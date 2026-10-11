#!/usr/bin/env -S deno run -A
/**
 * Observability (3) agent poll (audio-feed-yl6b).
 *
 * Reads the authenticated errors API with a durable cursor, asks a model to rank what is NEW as
 * suggested fixes, and files those as beads. It exists so an operator reads "here is what is failing
 * and here is the change that makes it resilient" instead of a dashboard of raw counts.
 *
 * WHY THIS IS A SCRIPT AND NOT A Deno.cron JOB IN THE APP, which is the decision the reviewer should
 * weigh first:
 *   - `Deno.Command` appears nowhere in src/, and a Deploy isolate has neither a git checkout nor a
 *     `bd` binary, so a job inside the app CANNOT file beads. The thing that files beads has to be the
 *     thing that has beads.
 *   - audio-feed-siv1 was exactly the other failure mode: a long synthesis died SILENTLY because it
 *     outlived the Deno.cron isolate bound. An hourly job whose defining step is a model call is long
 *     by nature, so it belongs outside the isolate, where its bound is the timer.
 * It therefore reuses the RULE the fleet's cadence scripts embody - one place records a run with its
 * caps and its skip reason, one place decides whether this interval runs - driven by a stamp behind an
 * existing systemd timer, not a second scheduling mechanism.
 *
 * SAFETY PROPERTIES, in the order the reviewer should attack them:
 *   1. OFF unless AUDIOFEED_OBSERVABILITY_AGENT_ENABLED is set AND a key is present. A disabled poll
 *      makes zero network calls and zero model calls.
 *   2. IDLE HOURS COST NOTHING. The summary endpoint answers "has anything changed" without fetching
 *      events, so a quiet hour makes no model call at all - a bound by construction, not a cap checked
 *      after the fact. Every run records WHY it did nothing.
 *   3. BOUNDED INPUT. At most MAX_EVENTS_PER_RUN events and MAX_PROMPT_BYTES of prompt reach the model,
 *      enforced by building the prompt until the cap is reached. A backlog is REPORTED, never skipped:
 *      the cursor advances only past events that were actually sent.
 *   4. FAIL CLOSED, NO RETRY. Any cap hit means: no model call, no bead, non-zero exit, and a reason in
 *      the artifact. A cap that retries is not a cap.
 *   5. NO DOUBLE SPEND ON RETRY. The idempotency token is the cursor WINDOW, checked against existing
 *      beads before any model call; beads are filed before the cursor advances, so a crash replays a
 *      check rather than a call.
 *   6. The daily counters are incremented BEFORE the call, so a killed run cannot spend unrecorded.
 *
 * Usage: deno run -A scripts/observability-agent-poll.ts [--state-dir <dir>] [--bd-bin <path>] [--dry-run] [--json]
 */

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/** Hard ceilings. These are caps, not defaults: see FAIL CLOSED in the header. */
export const MAX_EVENTS_PER_RUN = 200;
/** The API's own maximum page (MAX_LIMIT in src/routes/observability.ts). Fetching the largest page the
 * API allows costs nothing extra and makes the backlog estimate truer, while the SEND cap above still
 * bounds what reaches the model. */
export const FETCH_LIMIT = 500;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_OUTPUT_TOKENS = 2048;
export const MAX_CALLS_PER_DAY = 24;
export const MAX_INPUT_TOKENS_PER_DAY = 400_000;
export const MAX_OUTPUT_TOKENS_PER_DAY = 50_000;
/** A rough bytes-per-token divisor, used only to attribute daily spend to the counters. */
const BYTES_PER_TOKEN = 4;
/** How old the newest unprocessed event may be before the poll reports itself as structurally behind. */
export const BACKLOG_ALERT_HOURS = 6;
/**
 * A STABLE fingerprint for the backlog signal: deliberately a constant, so a backlog that persists for
 * days keeps one open bead instead of filing a fresh one every hour. It is not derived from any event,
 * which is exactly why it must not be built like an event fingerprint.
 *
 * IT MUST BE 16 HEX. The first version read "backlog0structural", which is not, and so could never be
 * read back by openFingerprints - the dedupe this constant exists for was silently dead (audio-feed-zxhv).
 * The value is sha256("observability-agent:backlog:structural:v1") truncated to 16 hex, inlined so it is
 * visibly fixed rather than computed at run time.
 */
export const BACKLOG_FINGERPRINT = "3cdca0cf12ee17bd";
/**
 * The stable fingerprint for "the poll dropped a record it could not send". A drop is a real loss of
 * coverage, so it is surfaced once as a bead - and stable, so a record that keeps being unsendable keeps
 * ONE open bead rather than filing one every hour (the audio-feed-zxhv lesson, applied here from the
 * start). The record's own fingerprint is recorded in the artifact, but it must not be the bead's identity:
 * it changes per record, which is what would produce the spam.
 *
 * 16 hex, for the same reason as the backlog constant: sha256("observability-agent:oversized-drop:v1").
 */
export const OVERSIZED_FINGERPRINT = "ece23e86b4bc43c4";

export const API_PATH_ERRORS = "/api/observability/errors";
export const API_PATH_SUMMARY = "/api/observability/summary";

const DEFAULT_STATE_DIR = `${
  Deno.env.get("HOME") ?? "."
}/.local/state/audio-feed-observability-agent`;
const DEFAULT_BASE_URL = "http://localhost:8000";
/** The app's own text model (DEFAULT_SCRIPT_MODEL in src/worker/script.ts), so the poll does not
 * introduce a second, unmanaged model choice. */
const DEFAULT_MODEL = "gemini-3.8-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = 120_000;

export interface PollConfig {
  enabled: boolean;
  key: string | null;
  baseUrl: string;
  model: string;
  geminiKey: string | null;
  stateDir: string;
  bdBin: string;
  dryRun: boolean;
  json: boolean;
  /** The prompt byte cap. An override exists so tests can reach the drop path, which is unreachable at
   * the default because one rendered event always fits (pinned by a test). */
  maxPromptBytes: number;
}

/** Resolves configuration WITHOUT making any decision about doing work. */
export function resolveConfig(args: string[]): PollConfig {
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const value = args[i + 1];
    return value === undefined ? null : value;
  };
  const maxPromptRaw = flag("--max-prompt-bytes") ??
    Deno.env.get("AUDIOFEED_AGENT_MAX_PROMPT_BYTES");
  const maxPromptOverride = maxPromptRaw === null ? Number.NaN : Number(maxPromptRaw);
  // A non-positive or unparseable override falls back to the default: a cap of nothing would drop every
  // event, which is worse than ignoring a typo in what is meant to be a test knob.
  const maxPromptBytes = Number.isFinite(maxPromptOverride) && maxPromptOverride > 0
    ? maxPromptOverride
    : MAX_PROMPT_BYTES;

  const key = Deno.env.get("AUDIOFEED_OBSERVABILITY_KEY") ?? null;
  const enabledFlag = (Deno.env.get("AUDIOFEED_OBSERVABILITY_AGENT_ENABLED") ?? "").toLowerCase();
  return {
    // Off unless EXPLICITLY enabled, and a key is necessary anyway. The two conditions are separate on
    // purpose: a deployment that has a key for other reasons must still opt in to spending money.
    enabled: ["1", "true", "yes"].includes(enabledFlag) && key !== null && key.length > 0,
    key,
    baseUrl: (flag("--base-url") ?? Deno.env.get("AUDIOFEED_OBSERVABILITY_BASE_URL") ??
      DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: flag("--model") ?? Deno.env.get("AUDIOFEED_AGENT_MODEL") ?? DEFAULT_MODEL,
    geminiKey: Deno.env.get("GEMINI_API_KEY") ?? null,
    stateDir: flag("--state-dir") ?? Deno.env.get("AUDIOFEED_AGENT_STATE_DIR") ?? DEFAULT_STATE_DIR,
    bdBin: flag("--bd-bin") ?? "bd",
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
    maxPromptBytes,
  };
}

// ---------------------------------------------------------------------------------------------
// Durable state and the machine-readable artifact
// ---------------------------------------------------------------------------------------------

/**
 * Everything the poll remembers between runs. `artifact` is written every run - including runs that do
 * nothing - because "this run cost nothing" must be auditable rather than believed: without a record
 * nobody can tell a quiet hour from a broken job.
 */
export interface PollState {
  cursor: number;
  day: string;
  callsToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
  lastRun: string | null;
  artifact: RunArtifact | null;
}

export type SkipReason =
  | "disabled"
  | "idle"
  | "no-open-findings"
  | "fingerprints-already-open"
  | "cap-events"
  | "cap-prompt-bytes"
  | "cap-daily-calls"
  | "cap-daily-input-tokens"
  | "cap-daily-output-tokens"
  | "missing-gemini-key"
  | "model-failed"
  | "api-failed"
  /** Another run holds the lock. The daily ceiling is a construction only if two runs cannot race it. */
  | "locked"
  /** The oldest queued event cannot fit the prompt even alone. It is SKIPPED, and recorded (audio-feed-w0b5). */
  | "oversized"
  /**
   * bd refused a bead, so the events behind it were neither filed nor already open. The cursor is HELD
   * rather than advanced past them (audio-feed-hoow) - a failure to file must not look like coverage.
   */
  | "bead-failed";

export interface RunArtifact {
  startedAt: string;
  finishedAt: string;
  state: "idle" | "ranked" | "skipped" | "failed";
  /** Why the run did nothing, or which cap stopped it. Never empty for a run that spent nothing. */
  reason: SkipReason | null;
  cursorBefore: number;
  cursorAfter: number;
  eventsSeen: number;
  eventsSent: number;
  promptBytes: number;
  /** True when the window held more than the caps allowed; `backlog` says how much was left behind. */
  truncated: boolean;
  /** Events left unprocessed by this run - the depth of the backlog, in the artifact so "behind and by
   * how much" is unmissable rather than inferred from a flag (coord, after ruling oldest-first). */
  backlog: number;
  /** Pages still to drain at the current page size, and the age of the newest unsent event. A poll that
   * is structurally behind is an operational signal, not a silent condition. */
  pagesRemaining: number;
  newestUnsentAgeHours: number | null;
  /** Any cursor gap forced by retention, so a 410 is visible in the audit trail rather than implied. */
  gapReported: { from: number; resumedAt: number } | null;
  fingerprintsSeen: string[];
  fingerprintsFiled: string[];
  /** An event that could not fit the prompt even alone and was dropped. A recorded loss, never silent. */
  skippedOversized: { seq: number; fingerprint: string; reason: string } | null;
  fingerprintsSkipped: string[];
  beadIds: string[];
  modelCalls: number;
  note: string | null;
}

export function emptyState(): PollState {
  return {
    cursor: 0,
    day: utcDay(new Date()),
    callsToday: 0,
    inputTokensToday: 0,
    outputTokensToday: 0,
    lastRun: null,
    artifact: null,
  };
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resets the daily counters when the UTC day rolls over. Called before any cap is consulted. */
export function rollDay(state: PollState, now: Date): PollState {
  const day = utcDay(now);
  if (state.day === day) return state;
  return { ...state, day, callsToday: 0, inputTokensToday: 0, outputTokensToday: 0 };
}

export async function loadState(dir: string): Promise<PollState> {
  try {
    const raw = await Deno.readTextFile(`${dir}/state.json`);
    const parsed = JSON.parse(raw) as Partial<PollState>;
    if (typeof parsed.cursor !== "number" || !Number.isFinite(parsed.cursor)) return emptyState();
    return { ...emptyState(), ...parsed } as PollState;
  } catch {
    // A missing or unreadable state file is a first run, not an error: the alternative would be a poll
    // that refuses to start because its own bookkeeping is absent.
    return emptyState();
  }
}

/**
 * An EXCLUSIVE lock, taken before any work and held for the whole run.
 *
 * Without it the daily ceiling is policing rather than construction: two runs - a timer firing while a
 * person runs the poll by hand, or two long runs overlapping - would each read callsToday = 23 and each
 * make a call, and the ceiling Paul set would be exceeded by exactly the mechanism meant to enforce it.
 * `createNew` is an atomic exclusive create, so the second caller fails rather than racing.
 *
 * A stale lock (from a run killed hard) is reclaimed after STALE_LOCK_MS so one crash cannot wedge the
 * poll permanently; the age is the whole reason the file records a timestamp.
 */
export const LOCK_FILE = "run.lock";
export const STALE_LOCK_MS = 30 * 60 * 1000;

/**
 * A unique owner token. The lock file holds one, so a release or a reclaim can tell WHOSE lock it is
 * looking at - which is what makes "release only what you own" checkable rather than a convention.
 */
export function lockToken(now: Date): string {
  return `${now.toISOString()} pid=${Deno.pid} nonce=${crypto.randomUUID()}`;
}

/** The lock's token and age, or null when there is no lock. */
async function readLock(path: string): Promise<{ token: string; mtimeMs: number } | null> {
  try {
    const token = (await Deno.readTextFile(path)).trim();
    const stat = await Deno.stat(path);
    return { token, mtimeMs: stat.mtime?.getTime() ?? 0 };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

export async function acquireLock(
  dir: string,
  now: Date,
  token: string = lockToken(now),
): Promise<boolean> {
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${LOCK_FILE}`;
  try {
    // THE ATOMIC PRIMITIVE: createNew either creates the file or fails, with nothing in between.
    const f = await Deno.open(path, { createNew: true, write: true });
    await f.write(new TextEncoder().encode(token));
    f.close();
    return true;
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }

  const held = await readLock(path);
  if (held === null) {
    // It vanished between the create and the read, so the holder finished rather than contended: retry
    // once. Contention returns false below instead - a lock that is genuinely held is not a retry.
    return await acquireLock(dir, now, token);
  }
  if (now.getTime() - held.mtimeMs <= STALE_LOCK_MS) return false;

  // STALE, SO RECLAIM IT ATOMICALLY (audio-feed-131z). The previous version wrote the file here, which is a
  // plain overwrite: two invocations both stat the same stale mtime, both overwrite, and BOTH believe they
  // hold the lock (measured by the reviewer at 199/200 rounds). Each then loaded state before the other's
  // reservation was durable, so both reserved, both called the model, and the daily ceiling Paul set was
  // exceeded by the mechanism meant to enforce it.
  //
  // RENAME is the atomic primitive for this: exactly one reclaimer can move the file aside, and the loser
  // gets NotFound. The winner then takes the lock through the SAME exclusive create as everyone else, so a
  // third invocation racing us is serialised by createNew rather than by luck.
  const graveyard = `${path}.stale.${Deno.pid}.${crypto.randomUUID()}`;
  try {
    await Deno.rename(path, graveyard);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Someone else reclaimed or released it while we were deciding, so the name is free: go through the
      // normal path and let createNew decide who owns it, rather than assuming it is us.
      return await acquireLock(dir, now, token);
    }
    throw err;
  }

  // NARROW RACE, CLOSED ON PURPOSE: between our stat and our rename, the holder may have released and a
  // different run acquired a FRESH lock. We would then be holding someone else's live lock. The token says
  // whose it is, so if this is not the one we judged stale, put it back and stand down.
  const moved = await readLock(graveyard);
  if (moved !== null && moved.token !== held.token) {
    try {
      await Deno.rename(graveyard, path);
    } catch {
      // The path was retaken in the meantime: either way this lock is not ours.
    }
    return false;
  }
  try {
    await Deno.remove(graveyard);
  } catch {
    // Best effort: a leftover graveyard file is inert - nothing reads it, and nothing locks on it.
  }
  return await acquireLock(dir, now, token);
}

/**
 * Releases the lock, and only the lock this run owns when a token is given.
 *
 * Ownership matters for the same reason the reclaim does: if a stale reclaim moved our lock aside and
 * another run took over, removing the file by name would delete a LIVE lock and let a third run in
 * (audio-feed-jmkm, then audio-feed-131z).
 */
export async function releaseLock(dir: string, token?: string): Promise<void> {
  const path = `${dir}/${LOCK_FILE}`;
  if (token !== undefined) {
    const held = await readLock(path);
    if (held !== null && held.token !== token) return;
  }
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** Writes atomically: a crash mid-write must not leave a corrupt cursor, which would lose coverage. */
export async function saveState(dir: string, state: PollState): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${dir}/state.json.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(state, null, 2) + "\n");
  await Deno.rename(tmp, `${dir}/state.json`);
}

export function renderDigest(a: RunArtifact): string {
  const lines = [
    `# Observability agent run - ${a.startedAt}`,
    "",
    `- state: ${a.state}${a.reason ? ` (${a.reason})` : ""}`,
    `- cursor: ${a.cursorBefore} -> ${a.cursorAfter}`,
    `- events: saw ${a.eventsSeen}, sent ${a.eventsSent}, prompt ${a.promptBytes} bytes`,
    `- capped: ${a.truncated}`,
    a.truncated || a.backlog > 0
      ? `- BEHIND: ${a.backlog} event(s) still queued, about ${a.pagesRemaining} page(s) remaining` +
        (a.newestUnsentAgeHours !== null
          ? `; the newest unprocessed event is ${a.newestUnsentAgeHours.toFixed(1)}h old`
          : "")
      : "- BEHIND: no, this run drained the window it fetched",
    `- model calls: ${a.modelCalls}`,
    `- beads filed: ${a.beadIds.length ? a.beadIds.join(", ") : "none"}`,
    `- fingerprints skipped as already open: ${a.fingerprintsSkipped.length}`,
    a.skippedOversized === null
      ? `- oversized events skipped (not analysed): none`
      : `- DROPPED (NOT analysed): seq ${a.skippedOversized.seq}, fingerprint ${a.skippedOversized.fingerprint} - ${a.skippedOversized.reason}`,
  ];
  if (a.gapReported) {
    lines.push(
      `- GAP: cursor ${a.gapReported.from} was no longer retained; resumed at ${a.gapReported.resumedAt}`,
    );
  }
  if (a.note) lines.push("", a.note);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// The errors API
// ---------------------------------------------------------------------------------------------

/** One record as the store returns it. Mirrors src/storage/mod.ts's LogRecord. */
export interface LogEvent {
  seq: number;
  time: string;
  severity: "debug" | "info" | "warn" | "error";
  /** Stable dotted classifier ("synthesis.claim"). The store documents that obs-3 ranks by it. */
  type: string;
  message: string;
  route?: string;
  job?: string;
  phase?: string;
  attempt?: number;
  reason?: string;
  correlationId?: string;
}

/**
 * Both endpoints speak the store's contract, verified against src/routes/observability.ts rather than
 * assumed: cursor and `since` are decimal STRINGS (the sequence of the last record SCANNED), `byType` is
 * a list of {type, count}, and the summary's `truncated` means UNSCANNED records lie inside the window -
 * a `total: 0, truncated: true` answer means "more behind a filter", not "nothing".
 */
export interface ErrorsPage {
  events: LogEvent[];
  cursor: string;
  hasMore: boolean;
  scanned: number;
  returned: number;
  window: { oldestRetained: number; newest: number };
}

export interface SummaryBody {
  cursor: string;
  since: string;
  total: number;
  bySeverity: Record<string, number>;
  byType: Array<{ type: string; count: number }>;
  truncated: boolean;
  scanned: number;
  window: { oldestRetained: number; newest: number };
}

/**
 * The key travels in the Authorization HEADER only, matching the API's own rule that a query parameter
 * would be logged. The same reasoning makes the Gemini key a header below.
 */
function authHeaders(key: string): HeadersInit {
  return { authorization: `Bearer ${key}`, accept: "application/json" };
}

async function fetchJson<T>(url: string, headers: HeadersInit, timeoutMs: number): Promise<
  { ok: true; status: number; body: T } | { ok: false; status: number; body: unknown }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the raw text: an HTML error page from a proxy is diagnostic, not a parse failure to hide
    }
    return res.ok
      ? { ok: true, status: res.status, body: body as T }
      : { ok: false, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSummary(
  config: PollConfig,
  cursor: number,
): Promise<{ ok: true; body: SummaryBody } | { ok: false; status: number; body: unknown }> {
  if (config.key === null) throw new Error("unreachable: fetchSummary without a key");
  const url = `${config.baseUrl}${API_PATH_SUMMARY}?since=${cursor}`;
  const res = await fetchJson<SummaryBody>(url, authHeaders(config.key), REQUEST_TIMEOUT_MS);
  return res.ok ? { ok: true, body: res.body } : res;
}

export async function fetchErrors(
  config: PollConfig,
  cursor: number,
  limit: number,
): Promise<
  | { ok: true; body: ErrorsPage }
  | { ok: false; status: number; body: unknown }
> {
  if (config.key === null) throw new Error("unreachable: fetchErrors without a key");
  const url = `${config.baseUrl}${API_PATH_ERRORS}?since=${cursor}&limit=${limit}`;
  const res = await fetchJson<ErrorsPage>(url, authHeaders(config.key), REQUEST_TIMEOUT_MS);
  return res.ok ? { ok: true, body: res.body } : res;
}

/** The sequence a 410 names as the oldest retained one, so recovery is deterministic, not guessed. */
export function oldestRetainedFromProblem(body: unknown): number | null {
  const detail = (body as { detail?: unknown })?.detail;
  if (typeof detail !== "string") return null;
  const m = /Oldest retained:\s*(\d+)/.exec(detail);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------------------------
// Fingerprints: the mechanism that stops an hourly job spamming the tracker
// ---------------------------------------------------------------------------------------------

/**
 * Collapses volatile path segments so `/api/items/91823` and `/api/items/55` are one signature.
 * Without this, every request would carry its own fingerprint and dedupe would never fire.
 */
export function normaliseRoute(route: string | undefined): string {
  if (route === undefined || route.length === 0) return "unknown";
  const path: string = route;
  const pathOnly = path.split("?")[0] ?? path;
  return pathOnly
    .split("/")
    .map((seg) =>
      /^(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{16,}|[A-Za-z0-9_-]{20,})$/.test(seg) ? ":id" : seg
    )
    .join("/");
}

/** Coarse band, so a 500 and a 503 are the same class of problem and one bead covers both. */
export function severityBand(severity: LogEvent["severity"]): string {
  return severity === "error" ? "high" : severity === "warn" ? "medium" : "low";
}

/**
 * The fingerprint is SHA-256 over EXACTLY THREE normalised fields: the dotted `type` classifier the
 * store provides for this purpose, the severity band, and the collapsed route. The raw message,
 * timestamp, correlation id, episode id and cursor are deliberately EXCLUDED - including any of them
 * makes the fingerprint change every hour, which defeats the mechanism completely.
 */
export async function fingerprint(event: LogEvent): Promise<string> {
  const signature = `${event.type}|${severityBand(event.severity)}|${normaliseRoute(event.route)}`;
  const bytes = new TextEncoder().encode(signature);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
    .slice(0, 16);
}

export const FINGERPRINT_MARKER = "fingerprint:";

// ---------------------------------------------------------------------------------------------
// Beads
// ---------------------------------------------------------------------------------------------

interface BdIssue {
  id: string;
  title: string;
  description?: string;
  status?: string;
}

async function runBd(bin: string, args: string[]): Promise<
  { ok: true; stdout: string } | { ok: false; code: number; stderr: string }
> {
  try {
    const out = await new Deno.Command(bin, { args, stdout: "piped", stderr: "piped" }).output();
    const decoder = new TextDecoder();
    return out.success
      ? { ok: true, stdout: decoder.decode(out.stdout) }
      : { ok: false, code: out.code, stderr: decoder.decode(out.stderr) };
  } catch (err) {
    return { ok: false, code: -1, stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Open beads carrying any fingerprint marker, so a ranking is not filed twice. */
export async function openFingerprints(bin: string): Promise<Set<string>> {
  const res = await runBd(bin, ["list", "--status", "open", "--json"]);
  const found = new Set<string>();
  if (!res.ok) return found;
  // The RAW output is scanned as well as the parsed fields. Parsing is what makes the round trip
  // checkable against real `bd list --json` (which carries title and description), and the raw scan is
  // what survives a shape change - a regression here silently disables every dedupe in this file, which
  // is exactly how audio-feed-zxhv hid (audio-feed-hoow depends on this set too).
  const haystack: string[] = [res.stdout];
  try {
    const parsed = JSON.parse(res.stdout) as Array<{ title?: string; description?: string }>;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item?.title === "string") haystack.push(item.title);
        if (typeof item?.description === "string") haystack.push(item.description);
      }
    }
  } catch {
    // Not JSON: the raw scan above still applies, so this is not an error path.
  }
  for (const text of haystack) {
    for (const m of text.matchAll(new RegExp(`${FINGERPRINT_MARKER}([0-9a-f]{16})`, "g"))) {
      const hex = m[1];
      if (hex !== undefined) found.add(hex);
    }
  }
  return found;
}

export interface RankedSuggestion {
  title: string;
  impact: string;
  fix: string;
  events: number;
  fingerprints: string[];
}

export async function fileBead(
  bin: string,
  suggestion: RankedSuggestion,
  run: { startedAt: string; cursorBefore: number; cursorAfter: number },
  dryRun: boolean,
): Promise<string | null> {
  const description = [
    suggestion.impact,
    "",
    `Suggested change: ${suggestion.fix}`,
    "",
    `Observed ${suggestion.events} matching event(s) since cursor ${run.cursorBefore}.`,
    `Fingerprints: ${suggestion.fingerprints.map((f) => FINGERPRINT_MARKER + f).join(", ")}`,
    `Filed automatically by the observability agent poll at ${run.startedAt}.`,
    "",
    "This bead was produced by a ranked analysis of stored errors, not by a human report: treat the",
    "suggested change as a hypothesis to verify against the code before implementing it.",
  ].join("\n");
  if (dryRun) return null;
  const res = await runBd(bin, [
    "create",
    "--title",
    suggestion.title,
    "--type",
    "bug",
    "--priority",
    "3",
    "--description",
    description,
    "--json",
  ]);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { id?: string } | Array<{ id?: string }>;
    const id = Array.isArray(parsed) ? parsed[0]?.id : parsed.id;
    return id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------------------------

export interface PromptBuild {
  text: string;
  bytes: number;
  eventsSent: number;
  truncated: boolean;
  backlog: number;
}

/**
 * Builds the prompt BY ADDING EVENTS UNTIL THE CAP IS REACHED, then stopping. Measuring after the fact
 * is not a bound: a burst of large errors would already have produced the oversized request.
 * Oldest-first, so the cursor can advance past exactly what was sent and nothing is skipped.
 */
export function buildPrompt(events: LogEvent[], maxBytes: number = MAX_PROMPT_BYTES): PromptBuild {
  const header = [
    "You are reviewing stored application errors for a podcast-synthesis web service.",
    "Group the events below by root cause and rank the groups by impact.",
    "Return STRICT JSON: an array of objects with keys title (short imperative fix),",
    "impact (one sentence on the user-visible consequence), fix (the concrete code change),",
    "events (how many of the listed events belong to the group), fingerprints (the fingerprint",
    "values listed for those events). Return at most 5 groups. Do not invent events.",
    "",
  ].join("\n");
  let text = header;
  let sent = 0;
  let backlog = 0;
  for (const e of events) {
    const line = JSON.stringify({
      seq: e.seq,
      type: e.type,
      severity: e.severity,
      route: normaliseRoute(e.route),
      phase: e.phase ?? null,
      reason: e.reason ?? null,
      message: e.message.slice(0, 300),
    }) + "\n";
    const next = text + line;
    const nextBytes = new TextEncoder().encode(next).length;
    if (nextBytes > maxBytes || sent >= MAX_EVENTS_PER_RUN) {
      backlog = events.length - sent;
      return {
        text,
        bytes: new TextEncoder().encode(text).length,
        eventsSent: sent,
        truncated: true,
        backlog,
      };
    }
    text = next;
    sent++;
  }
  return {
    text,
    bytes: new TextEncoder().encode(text).length,
    eventsSent: sent,
    truncated: false,
    backlog: 0,
  };
}

export interface ModelResult {
  ok: boolean;
  text: string;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

/**
 * One call, no retries. A retry inside a run is how a cap becomes decorative.
 * The key goes in the x-goog-api-key header, matching src/tts/gemini.ts, which explicitly refuses to
 * put it in a query parameter because URLs are logged.
 */
export async function callModel(config: PollConfig, prompt: string): Promise<ModelResult> {
  if (config.geminiKey === null || config.geminiKey.length === 0) {
    return { ok: false, text: "", inputTokens: 0, outputTokens: 0, error: "missing-gemini-key" };
  }
  const url = `${GEMINI_BASE_URL}/models/${config.model}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, text: "", inputTokens: 0, outputTokens: 0, error: `http ${res.status}` };
    }
    const parsed = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const out = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      ok: true,
      text: out,
      inputTokens: parsed.usageMetadata?.promptTokenCount ??
        Math.ceil(prompt.length / BYTES_PER_TOKEN),
      outputTokens: parsed.usageMetadata?.candidatesTokenCount ??
        Math.ceil(out.length / BYTES_PER_TOKEN),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Parses the model's JSON defensively: a malformed reply must not file a garbage bead. */
export function parseSuggestions(text: string): RankedSuggestion[] {
  const trimmed = text.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(arr)) return [];
  const out: RankedSuggestion[] = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    if (typeof o?.title !== "string" || o.title.trim().length === 0) continue;
    out.push({
      title: o.title.trim().slice(0, 200),
      impact: typeof o.impact === "string" ? o.impact : "",
      fix: typeof o.fix === "string" ? o.fix : "",
      events: typeof o.events === "number" ? o.events : 0,
      fingerprints: Array.isArray(o.fingerprints)
        ? o.fingerprints.filter((f): f is string => typeof f === "string")
        : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

export interface RunDeps {
  now: () => Date;
  fetchSummary: typeof fetchSummary;
  fetchErrors: typeof fetchErrors;
  openFingerprints: typeof openFingerprints;
  fileBead: typeof fileBead;
  callModel: typeof callModel;
}

export function defaultDeps(): RunDeps {
  return {
    now: () => new Date(),
    fetchSummary,
    fetchErrors,
    openFingerprints,
    fileBead,
    callModel,
  };
}

/**
 * One run. Returns the artifact it wrote, which is also what the caller logs and what --json prints.
 * The order of operations IS the safety design, so the reviewer should read it as such:
 *   enable guard -> caps consulted before any spend -> summary gate -> fetch -> dedupe BEFORE the call
 *   -> count the call BEFORE making it -> one call -> file beads BEFORE advancing the cursor.
 */
export async function runOnce(
  config: PollConfig,
  deps: RunDeps,
): Promise<{ artifact: RunArtifact; state: PollState }> {
  const startedAt = deps.now().toISOString();
  let state = rollDay(await loadState(config.stateDir), deps.now());
  const cursorBefore = state.cursor;

  const artifact: RunArtifact = {
    startedAt,
    finishedAt: startedAt,
    state: "skipped",
    reason: null,
    cursorBefore,
    cursorAfter: cursorBefore,
    eventsSeen: 0,
    eventsSent: 0,
    promptBytes: 0,
    truncated: false,
    backlog: 0,
    pagesRemaining: 0,
    newestUnsentAgeHours: null,
    gapReported: null,
    fingerprintsSeen: [],
    fingerprintsFiled: [],
    skippedOversized: null,
    fingerprintsSkipped: [],
    beadIds: [],
    modelCalls: 0,
    note: null,
  };
  // Ownership, tracked explicitly and BY TOKEN: a DISABLED or refused invocation also returns through
  // finish(), and releasing a lock this run never acquired (or no longer owns) deletes a live run's lock
  // and lets a second run in - the exact race the lock exists to prevent (audio-feed-jmkm, audio-feed-131z).
  let heldToken: string | null = null;
  const finish = async (state_: "idle" | "ranked" | "skipped" | "failed"): Promise<RunArtifact> => {
    artifact.state = state_;
    artifact.finishedAt = deps.now().toISOString();
    state = { ...state, lastRun: artifact.finishedAt, artifact };
    await saveState(config.stateDir, state);
    await Deno.writeTextFile(`${config.stateDir}/digest.md`, renderDigest(artifact));
    // Released on every path that returns through here, but ONLY if this run still owns it.
    if (heldToken !== null) {
      await releaseLock(config.stateDir, heldToken);
      heldToken = null;
    }
    return artifact;
  };

  // (1) OFF unless enabled: nothing below this line runs for a disabled poll, and that is what the test
  // asserts - not that it exits quietly, but that it makes zero network calls.
  if (!config.enabled) {
    artifact.reason = "disabled";
    artifact.note =
      "AUDIOFEED_OBSERVABILITY_AGENT_ENABLED is not set, or no key is configured. Nothing was requested.";
    return { artifact: await finish("skipped"), state };
  }

  // (2) The lock, BEFORE the caps and BEFORE anything else that costs or writes. A ceiling that two
  // concurrent runs can each pass is not a ceiling, so the exclusion is not an optimisation.
  const lockNow = deps.now();
  const token = lockToken(lockNow);
  const acquired = await acquireLock(config.stateDir, lockNow, token);
  heldToken = acquired ? token : null;
  if (!acquired) {
    artifact.reason = "locked";
    artifact.note =
      `Another run holds ${LOCK_FILE} in ${config.stateDir}. This run did nothing and wrote no state, ` +
      `because the holder owns the cursor and the counters - writing here would clobber them.`;
    return { artifact, state };
  }

  // (3) Daily caps are consulted BEFORE anything is fetched, and the day rolls first.
  if (state.callsToday >= MAX_CALLS_PER_DAY) {
    artifact.reason = "cap-daily-calls";
    artifact.note =
      `Daily call ceiling of ${MAX_CALLS_PER_DAY} already reached; no model call was made.`;
    return { artifact: await finish("skipped"), state };
  }
  if (
    state.inputTokensToday >= MAX_INPUT_TOKENS_PER_DAY ||
    state.outputTokensToday >= MAX_OUTPUT_TOKENS_PER_DAY
  ) {
    artifact.reason = state.inputTokensToday >= MAX_INPUT_TOKENS_PER_DAY
      ? "cap-daily-input-tokens"
      : "cap-daily-output-tokens";
    artifact.note = "Daily token ceiling already reached; no model call was made.";
    return { artifact: await finish("skipped"), state };
  }

  // (3) The summary endpoint is a GATE, not a nicety: it answers "has anything changed" without
  // fetching events, so an idle hour costs literally nothing.
  const summary = await deps.fetchSummary(config, state.cursor);
  if (!summary.ok) {
    if (summary.status === 410) {
      const resumedAt = oldestRetainedFromProblem(summary.body);
      if (resumedAt !== null) {
        artifact.gapReported = { from: state.cursor, resumedAt };
        state = { ...state, cursor: resumedAt - 1 };
        artifact.note =
          `cursor ${cursorBefore} was no longer retained; resumed at ${resumedAt}. Events in ` +
          `between were NOT seen - recorded here rather than skipped silently.`;
      }
    }
    if (artifact.gapReported === null) {
      artifact.reason = "api-failed";
      artifact.note = `summary request failed with status ${summary.status}.`;
      return { artifact: await finish("failed"), state };
    }
  }
  // THE idle test, and it has to be both terms. `total` alone is not enough: the API documents
  // that a bound full of FILTERED-OUT records reports total 0 with truncated true, and a caller
  // that stops there never reaches the records behind them. So nothing new means no matching
  // records AND nothing unscanned. An earlier version compared a `newest` field that does not
  // exist on this response at all, so the gate never fired and every run would have spent a call -
  // the tests missed it because their stubs were built from the same wrong type.
  if (summary.ok && summary.body.total === 0 && !summary.body.truncated) {
    artifact.reason = "idle";
    artifact.note =
      `Nothing new since cursor ${state.cursor}: 0 matching record(s) and nothing unscanned ` +
      `in the window (scanned ${summary.body.scanned}). This run made no model call.`;
    return { artifact: await finish("idle"), state };
  }

  // (4) Fetch the OLDEST events that fit; the cursor will advance only past what is actually sent.
  const page = await deps.fetchErrors(config, state.cursor, FETCH_LIMIT);
  if (!page.ok) {
    artifact.reason = "api-failed";
    artifact.note = `errors request failed with status ${page.status}.`;
    return { artifact: await finish("failed"), state };
  }
  const events = page.body.events.filter((e) => e.severity !== "debug");
  artifact.eventsSeen = events.length;

  // (5) Dedupe BEFORE spending: an event whose fingerprint is already open needs no ranking.
  const alreadyOpen = await deps.openFingerprints(config.bdBin);
  const withPrints: Array<{ event: LogEvent; print: string }> = [];
  for (const e of events) {
    const print = await fingerprint(e);
    if (!artifact.fingerprintsSeen.includes(print)) artifact.fingerprintsSeen.push(print);
    if (alreadyOpen.has(print)) {
      if (!artifact.fingerprintsSkipped.includes(print)) artifact.fingerprintsSkipped.push(print);
      continue;
    }
    withPrints.push({ event: e, print });
  }
  if (withPrints.length === 0) {
    artifact.reason = events.length === 0 ? "no-open-findings" : "fingerprints-already-open";
    artifact.note = events.length === 0
      ? `Cursor moved to ${page.body.window.newest} but no rankable events were returned.`
      : "Every new event already has an open bead carrying its fingerprint, so no model call was made.";
    // Advancing here is safe: every event was either non-rankable or already represented by a bead.
    // The response cursor is a decimal STRING; the poll keeps numbers internally.
    artifact.cursorAfter = Number(page.body.cursor);
    state = { ...state, cursor: Number(page.body.cursor) };
    return { artifact: await finish("skipped"), state };
  }

  const prompt = buildPrompt(withPrints.map((w) => w.event), config.maxPromptBytes);
  artifact.eventsSent = prompt.eventsSent;
  artifact.promptBytes = prompt.bytes;
  artifact.truncated = prompt.truncated;
  artifact.backlog = prompt.backlog;
  if (prompt.eventsSent === 0) {
    // A SAFETY NET, and deliberately so: with `message` sliced to 300 characters and every other
    // LogEvent field short, a single event cannot exceed the cap today (pinned by a test). The branch
    // exists because the alternative failure is the worst this job has - a record that can never be
    // sent wedges the cursor forever and ends coverage silently. Note the cap cases below still HOLD the
    // cursor, which is correct: a cap must not skip work, but an unsendable record must not stop it.
    // PROGRESS IS NOT OPTIONAL. If nothing can be sent, the cursor still has to move past the oldest
    // queued event: otherwise every run refetches the same record and the poll is wedged forever, which
    // is worse than skipping one event, because a wedge ends all coverage silently (audio-feed-w0b5).
    // The skip is RECORDED - this is a loss, and the artifact says so rather than dropping it quietly.
    const oldest = withPrints[0];
    if (oldest !== undefined) {
      const past = oldest.event.seq;
      const why =
        `the oldest queued event (seq ${past}) does not fit the ${config.maxPromptBytes}-byte prompt ` +
        `even alone`;
      artifact.reason = "oversized";
      // The record is identified by BOTH its own fingerprint and its sequence, so an operator can find
      // exactly what was lost rather than knowing only that something was.
      artifact.skippedOversized = { seq: past, fingerprint: oldest.print, reason: why };
      artifact.cursorAfter = past;
      state = { ...state, cursor: past };
      // A drop is a real loss of coverage, so it is surfaced - once, under a STABLE fingerprint, and with
      // the open-set check applied from the start (a per-record identity here would file a bead an hour).
      if (!alreadyOpen.has(OVERSIZED_FINGERPRINT)) {
        const id = await deps.fileBead(
          config.bdBin,
          {
            title: `Observability poll dropped an event it cannot send (seq ${past})`,
            impact: `One record could not be ranked at all: its rendered form exceeds the ` +
              `${config.maxPromptBytes}-byte prompt cap, so it was dropped and the cursor advanced past ` +
              `it. Coverage is incomplete until the cap or the projection changes.`,
            fix:
              "Either raise the prompt cap, or shrink the projection in buildPrompt so every record fits. " +
              "The drop is deliberate and recorded, so it is never mistaken for a quiet success.",
            events: 1,
            fingerprints: [OVERSIZED_FINGERPRINT],
          },
          { startedAt, cursorBefore, cursorAfter: past },
          config.dryRun,
        );
        if (id !== null) artifact.beadIds.push(id);
      }
      artifact.note =
        `The poll dropped ${why} and advanced the cursor past it, because a record that can never be ` +
        `sent would otherwise wedge the poll forever - the whole window would stop being processed. ` +
        `This event was NOT analysed, and the drop is recorded here and reported as a bead so it stays ` +
        `visible rather than becoming a quiet success.`;
      return { artifact: await finish("skipped"), state };
    }
    artifact.reason = prompt.bytes > 0 ? "cap-prompt-bytes" : "cap-events";
    artifact.note =
      "The per-run input cap was reached before a single event could be sent; nothing was ranked.";
    return { artifact: await finish("skipped"), state };
  }

  if (config.geminiKey === null || config.geminiKey.length === 0) {
    artifact.reason = "missing-gemini-key";
    artifact.note =
      "GEMINI_API_KEY is not configured, so no model call was made. Nothing was filed.";
    return { artifact: await finish("skipped"), state };
  }

  // (6) RESERVE the call durably BEFORE making it, and reserve the WORST case it could consume. An
  // in-memory increment is not a bound: kill the process inside the call and the spend happened while the
  // durable counter still read zero, so across timer runs a 24/day ceiling is exceeded by the mechanism
  // meant to enforce it (audio-feed-nvog). The reservation is settled against the actuals below.
  const reservedInputTokens = Math.ceil(
    new TextEncoder().encode(prompt.text).length / BYTES_PER_TOKEN,
  );
  const reservedOutputTokens = MAX_OUTPUT_TOKENS;
  state = {
    ...state,
    callsToday: state.callsToday + 1,
    inputTokensToday: state.inputTokensToday + reservedInputTokens,
    outputTokensToday: state.outputTokensToday + reservedOutputTokens,
  };
  await saveState(config.stateDir, state);
  const model = await deps.callModel(config, prompt.text);
  artifact.modelCalls = 1;
  // Settle: swap the reservation for what the call actually reported. A failed call keeps the
  // reservation, which is the correct direction - it may still have been billed.
  state = {
    ...state,
    inputTokensToday: Math.max(0, state.inputTokensToday - reservedInputTokens + model.inputTokens),
    outputTokensToday: Math.max(
      0,
      state.outputTokensToday - reservedOutputTokens + model.outputTokens,
    ),
  };
  if (!model.ok) {
    artifact.reason = "model-failed";
    artifact.note =
      `The model call failed (${model.error}). No retry is attempted within a run, and the ` +
      `cursor is unchanged so the same window is retried next hour.`;
    return { artifact: await finish("failed"), state };
  }

  // (7) File beads, then advance the cursor - in that order, so a crash replays a check, not a call.
  const suggestions = parseSuggestions(model.text);
  const sentSeqs = withPrints.slice(0, prompt.eventsSent).map((w) => w.event.seq);
  const sentPrints = withPrints.slice(0, prompt.eventsSent).map((w) => w.print);
  const claimed = new Set<string>();
  // A fingerprint may be advanced past only if it was FILED, or was already open (nothing to file), or
  // this is a dry run (filing nothing is the point). Anything else is an event that would be lost by
  // advancing, so it is collected and the cursor is held below (audio-feed-hoow).
  const unfiled: string[] = [];
  for (const s of suggestions.slice(0, 5)) {
    const prints = s.fingerprints.length > 0 ? s.fingerprints : sentPrints.slice(0, 1);
    for (const p of prints) claimed.add(p);
    const id = await deps.fileBead(config.bdBin, { ...s, fingerprints: prints }, {
      startedAt,
      cursorBefore,
      cursorAfter: sentSeqs.length > 0 ? Math.max(...sentSeqs) : cursorBefore,
    }, config.dryRun);
    if (id !== null) {
      artifact.beadIds.push(id);
      artifact.fingerprintsFiled.push(...prints);
    } else if (config.dryRun || prints.every((p) => alreadyOpen.has(p))) {
      artifact.fingerprintsFiled.push(...prints);
    } else {
      unfiled.push(...prints);
    }
  }
  // Events the model did not group are still covered: one catch-all bead keeps them from vanishing.
  const unclaimed = sentPrints.filter((p) => !claimed.has(p));
  if (unclaimed.length > 0) {
    const id = await deps.fileBead(config.bdBin, {
      title: `Unranked observability findings (${unclaimed.length} event fingerprint(s))`,
      impact: "These events were sent to the model but not grouped into a ranked suggestion.",
      fix: "Review the events for this window and decide whether they share a cause.",
      events: unclaimed.length,
      fingerprints: unclaimed,
    }, {
      startedAt,
      cursorBefore,
      cursorAfter: sentSeqs.length > 0 ? Math.max(...sentSeqs) : cursorBefore,
    }, config.dryRun);
    if (id !== null) {
      artifact.beadIds.push(id);
      artifact.fingerprintsFiled.push(...unclaimed);
    } else if (config.dryRun || unclaimed.every((p) => alreadyOpen.has(p))) {
      artifact.fingerprintsFiled.push(...unclaimed);
    } else {
      unfiled.push(...unclaimed);
    }
  }

  // Where the cursor WOULD go. It is not committed until the events behind it are filed or already
  // covered: advancing past an event that was neither is the silent skip the whole retention rule exists
  // to prevent (audio-feed-hoow).
  const advanceTo = prompt.truncated
    ? Math.max(...sentSeqs)
    : Math.max(Number(page.body.cursor), ...sentSeqs);

  // How far behind are we, and is anything we have not reached already old? hasMore matters as much as
  // the page contents: without it a full page reports a backlog of zero while hundreds remain.
  const unsent = withPrints.slice(prompt.eventsSent);
  const newestUnsent = unsent.at(-1)?.event ?? null;
  // ONE TERM, and it is the whole backlog (audio-feed-95jc). This was `beyondPage + remainingInPage`, but
  // `newest - advanceTo` ALREADY includes the events left unsent in the page, so the in-page remainder was
  // counted twice - the digest and the backlog bead overstated how far behind the poll was (measured 1100
  // against a true 800). An overstated backlog is the mirror of the understated one this file already
  // fixed: both are the poll lying about its own coverage, and only one term can be true.
  artifact.backlog = Math.max(0, page.body.window.newest - advanceTo);
  artifact.pagesRemaining = artifact.backlog === 0
    ? 0
    : Math.max(1, Math.ceil(artifact.backlog / MAX_EVENTS_PER_RUN));
  if (newestUnsent !== null) {
    const ageMs = Date.parse(startedAt) - Date.parse(newestUnsent.time);
    artifact.newestUnsentAgeHours = Number.isFinite(ageMs) ? ageMs / 3_600_000 : null;
  }

  // A structurally behind poll is an operational signal, so it is surfaced as a bead - and because it
  // reuses the fingerprint mechanism with a STABLE fingerprint, a backlog that persists for days keeps
  // one open bead rather than filing a new one every hour.
  if (
    artifact.newestUnsentAgeHours !== null &&
    artifact.newestUnsentAgeHours >= BACKLOG_ALERT_HOURS &&
    // The check the stable fingerprint exists FOR. Filing this bead without consulting the open set was
    // the whole defect (audio-feed-zxhv): a poll that stayed behind for a week filed a new bead every
    // hour, which is bead spam and, worse, buries the signal it was meant to raise.
    !alreadyOpen.has(BACKLOG_FINGERPRINT)
  ) {
    const id = await deps.fileBead(
      config.bdBin,
      {
        title: `Observability poll is behind: ${artifact.backlog} event(s) unprocessed`,
        impact:
          `The newest unprocessed event is about ${
            artifact.newestUnsentAgeHours.toFixed(1)
          }h old, so ` +
          `findings are being reported late. A poll that is structurally behind is a signal about the ` +
          `poll, not about the application.`,
        fix:
          "Check whether the error rate has outgrown one page per hour, and raise the per-run caps or the " +
          "cadence rather than letting the backlog grow. The backlog drains oldest-first, so nothing is lost.",
        events: artifact.backlog,
        fingerprints: [BACKLOG_FINGERPRINT],
      },
      { startedAt, cursorBefore, cursorAfter: advanceTo },
      config.dryRun,
    );
    if (id !== null) artifact.beadIds.push(id);
  }
  if (unfiled.length > 0) {
    // FILED OR ALREADY OPEN, OR THE CURSOR DOES NOT MOVE. The real fileBead returns null when bd exits
    // non-zero or returns unreadable output, and advancing anyway would drop those events permanently
    // while the artifact claimed they were filed (audio-feed-hoow). Retrying them next hour is cheap; a
    // silent skip is not recoverable.
    artifact.reason = "bead-failed";
    artifact.note =
      `bd did not accept ${unfiled.length} bead(s) (${unfiled.slice(0, 3).join(", ")}` +
      `${
        unfiled.length > 3 ? ", ..." : ""
      }), so the cursor is HELD at ${cursorBefore} rather than ` +
      `advanced past events that were neither filed nor already open. The same window is retried next ` +
      `hour, and nothing is claimed as filed that was not.`;
    return { artifact: await finish("failed"), state };
  }
  artifact.cursorAfter = advanceTo;
  state = { ...state, cursor: advanceTo };
  if (prompt.truncated) {
    artifact.note =
      `Capped at ${prompt.eventsSent} event(s); ${prompt.backlog} remain and will be ` +
      `processed by the next run, because the cursor advanced only past what was sent.`;
  }
  return { artifact: await finish("ranked"), state };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const config = resolveConfig(Deno.args);
  const { artifact } = await runOnce(config, defaultDeps());
  if (config.json) {
    console.log(JSON.stringify(artifact, null, 2));
  } else {
    console.log(
      `[observability-agent] ${artifact.state}${artifact.reason ? ` (${artifact.reason})` : ""}: ` +
        `cursor ${artifact.cursorBefore} -> ${artifact.cursorAfter}, sent ${artifact.eventsSent}, ` +
        `calls ${artifact.modelCalls}, beads ${artifact.beadIds.length}`,
    );
    if (artifact.note) console.log(`[observability-agent] ${artifact.note}`);
  }
  // Fail closed: a cap or an API failure is a non-zero exit so a timer or a human can see it. An idle
  // run and a disabled run are successes - they are the system working, not failing.
  if (artifact.state === "failed") return 1;
  if (artifact.reason !== null && artifact.reason.startsWith("cap-")) return 2;
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
