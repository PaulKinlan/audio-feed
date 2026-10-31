/**
 * Environment configuration and store selection.
 *
 * Fails loudly at boot when a production backend is half-configured. A server
 * that silently falls back to an in-memory store in production loses every
 * episode on the next deploy, and looks healthy while doing it.
 *
 * Owned by: audio-feed-0h8.
 */

import type { BlobStore, MetadataStore } from "./storage/mod.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "./storage/memory.ts";
import { KvMetadataStore } from "./storage/kv.ts";
import { S3BlobStore } from "./storage/s3.ts";
import {
  DEFAULT_TIMEOUT_MS,
  type EnvReader,
  GEMINI_TTS_VOICES,
  type GeminiTtsVoice,
} from "./tts/gemini.ts";

/**
 * The daily per-user episode ceiling that applies when a subscriber has no
 * `dailyEpisodeBudget` of their own (audio-feed-khk3).
 *
 * WHY A NUMBER AND NOT "UNLIMITED": audio-feed-9mp made the per-user budget OPTIONAL and recorded
 * "default is no ceiling" as an accepted criterion, to avoid changing behaviour for the single-user
 * deployment. That is the hole this closes — discretionary spend had no ceiling for exactly the
 * subscribers nobody had configured, and the only other bounds were the admin approval gate and the
 * worker's ~150 episodes/hour of throughput, neither of which is a spending limit.
 *
 * WHY 50: it has to sit above a real personal day and below a runaway. Feed ingest caps at 10 items
 * per source per poll (src/ingest/feed.ts), so a busy day for the feeds this was built for is single
 * digits to low tens of episodes — 50 is clear of that. The pathological case 9mp itself measured is
 * one subscriber with twenty feeds queueing ~200 episodes, which this now stops at a quarter of.
 *
 * Exceeding it DEFERS rather than fails: nothing is spent, and the episodes are picked up the next
 * day when the counter resets (the audio-feed-9mp shape). An operator who wants a different ceiling —
 * including a deliberately large one — sets DEFAULT_DAILY_EPISODE_BUDGET; there is no sentinel that
 * restores unbounded, so "no ceiling" can only be chosen by naming a number.
 */
export const DEFAULT_DAILY_EPISODE_BUDGET = 50;

/**
 * The ceiling on paid episodes per UTC day across ALL subscribers (audio-feed-m182).
 *
 * The per-subscriber ceiling above bounds one subscriber, which leaves total spend linear in the
 * number of approved subscribers: fifty each is unbounded as an operator approves more of them, and
 * approval is the one action that multiplies it. This is the bound on the sum.
 *
 * The default is ten subscribers' worth at the default above, deliberately: it is high enough that
 * a small deployment never meets it by accident, and finite so that the sum cannot run away while
 * nobody is watching. Set GLOBAL_DAILY_EPISODE_BUDGET for the real number.
 */
export const DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET = 500;
/** Default maximum execution duration per synthesis invocation before yielding (audio-feed-vqu4, audio-feed-9lrl, audio-feed-sp38). */
export const DEFAULT_MAX_INVOCATION_DURATION_MS = 90_000;
/** Default maximum terminal-upload retry count before failing terminally (audio-feed-lqd6). */
export const DEFAULT_MAX_UPLOAD_RETRIES = 3;

/**
 * How long the structured log store keeps a record (audio-feed-wzv9).
 *
 * A week, because the store exists to explain failures that are noticed late — the two demos that
 * prompted it were investigated days after their claims died. It is deliberately a duration and not
 * "keep everything": the errors API answers a cursor into this store, and an unbounded store makes
 * the one promise the cursor makes ("everything below oldestSeq is gone") impossible to keep
 * honestly.
 *
 * Set LOG_RETENTION_DAYS to change it. Zero disables pruning entirely, which is a deliberate
 * opt-in for a deployment that has somewhere else to put the records.
 */
export const DEFAULT_LOG_RETENTION_DAYS = 7;

export interface AppConfig {
  /**
   * Days of structured log records to retain (audio-feed-wzv9). 0 means prune nothing.
   *
   * OPTIONAL, like globalDailyEpisodeBudget and for the same reason: a caller constructing a
   * config for one behaviour should not have to restate every deployment default, and the value
   * that matters is the one `loadConfig` resolves. The cron pass reads it through
   * `DEFAULT_LOG_RETENTION_DAYS`, so an omission means the default rather than "prune nothing".
   *
   * The daily pass is what enforces it; the errors API reads `logBounds()` to tell a caller that a
   * cursor has aged out rather than silently skipping records.
   */
  logRetentionDays?: number;
  port: number;
  /**
   * Explicit public origin. OPTIONAL, and optional on purpose (audio-feed-0k3).
   *
   * This used to default to `http://localhost:<port>`, which meant a deployment
   * that set nothing believed its own origin was loopback — and told visitors to
   * subscribe to `http://localhost:8000/feed/...`. A guess is worse than an
   * absence here, because an absence can be resolved from the request that
   * actually arrived. See `src/origin.ts`.
   *
   * Set it when something upstream rewrites Host, or to pin a canonical domain.
   */
  publicBaseUrl?: string;
  /**
   * Trust `x-forwarded-proto` / `x-forwarded-host` when deriving the origin.
   *
   * Off unless an operator opts in, because those headers are hop-by-hop: any
   * client can set them, and only the operator knows whether a proxy in front
   * overwrites client-supplied values.
   *
   * For the rate limiter's client address (audio-feed-u2ve) the requirement is narrower and is
   * enforced in `extractClientIp`: it keys on the LAST `x-forwarded-for` entry, the one the nearest
   * hop appended, so a caller cannot choose or rotate their bucket by prepending a forged address.
   * Enable this only where a proxy appends to that header; with no proxy in front it is whatever the
   * caller typed, which is why it is an operator assertion rather than a default.
   */
  trustProxyHeaders?: boolean;
  /**
   * Hosts this deployment is willing to advertise (audio-feed-fp4r).
   *
   * EXTRA hosts to accept, from `ALLOWED_HOSTS` (comma-separated), on top of
   * the host of `publicBaseUrl` — which is accepted on its own, without this
   * variable being set (audio-feed-7lsy). An override for staging or a custom
   * domain, never a prerequisite for the protection to exist. A request
   * arriving on an unlisted host is answered `421 Misdirected Request` at the
   * app boundary and never becomes the advertised origin — which also pins the
   * WebAuthn RP ID, since that derives from the advertised origin's hostname.
   * Unset, the gate still runs from `publicBaseUrl` alone; with neither value
   * set the set is empty and every non-loopback host is refused, so the app no
   * longer keeps the request-derived origin behaviour of audio-feed-0k3. An
   * EMPTY set is answered `500 server_misconfigured` naming `PUBLIC_BASE_URL`,
   * because that state is a deployment that cannot name its own host rather than
   * a misdirected request (audio-feed-3k2d); a non-empty set that does not
   * contain the request host is still `421 Misdirected Request`. The
   * `publicBaseUrl` host is implicitly allowed; loopback always is.
   */
  allowedHosts?: string[];
  /** Present only when TTS is configured; 65u owns its use. */
  geminiApiKey?: string;
  /**
   * Per-attempt TTS deadline in ms (TTS_TIMEOUT_MS, audio-feed-9yu8). Defaults to
   * DEFAULT_TIMEOUT_MS (120s). Keep it below the claim lease: the lease AbortSignal is what
   * actually bounds an episode, and a deadline longer than the lease can only end in a claim
   * that expires mid-synthesis.
   */
  ttsTimeoutMs?: number;
  /**
   * Daily per-user episode ceiling applied to a subscriber who has no
   * `dailyEpisodeBudget` of their own, from DEFAULT_DAILY_EPISODE_BUDGET
   * (audio-feed-khk3).
   *
   * The field on the user record is optional, and before this existed "unset"
   * meant "no ceiling at all": paid synthesis was unbounded for exactly the
   * subscribers nobody had got round to configuring. 0 is a legal value and
   * means an unconfigured subscriber synthesises nothing.
   */
  defaultDailyEpisodeBudget?: number;
  /**
   * The ceiling on paid episodes per UTC day across every subscriber (audio-feed-m182).
   *
   * Resolved the same way as the per-subscriber ceiling — explicit, then this, then the constant —
   * and enforced in the worker, so every entry point that synthesises is bounded by it. 0 means no
   * synthesis happens at all.
   */
  globalDailyEpisodeBudget?: number;
  /**
   * Maximum newly synthesized segments to produce in a single invocation before
   * checkpointing and yielding the claim back to the queue (audio-feed-vqu4).
   * Optional; defaults to undefined (unbounded by segment count).
   */
  maxSegmentsPerInvocation?: number;
  /**
   * Maximum duration in ms a single invocation may spend synthesizing before
   * checkpointing and yielding back to the queue (audio-feed-vqu4, audio-feed-sp38).
   * Defaults to DEFAULT_MAX_INVOCATION_DURATION_MS (90_000ms).
   */
  maxInvocationDurationMs?: number;
  /**
   * Maximum terminal-upload retries allowed before an episode fails terminally (audio-feed-lqd6).
   * Defaults to DEFAULT_MAX_UPLOAD_RETRIES (3).
   */
  maxUploadRetries?: number;
  adminToken?: string;
  /**
   * Shared key for the observability API (audio-feed-s2pi / obs-1).
   *
   * Optional here for the same reason as `logRetentionDays`: many test configs are hand-built, and
   * what matters is the value `loadConfig` resolves. The endpoint itself FAILS CLOSED — with no key
   * configured it refuses everyone rather than serving observability data openly, and says so.
   */
  observabilityKey?: string;
  /**
   * System default voice, from DEFAULT_VOICE (audio-feed-4xt).
   *
   * Unset means "no system preference", which is different from Charon: the chain
   * still falls through to DEFAULT_NARRATION_VOICE, but a source or user voice set
   * later is not shadowed by a value invented here.
   *
   * Validated at load, not at synthesis time. An invalid name throws rather than
   * falling back, because a typo in DEFAULT_VOICE silently reading every article in
   * a different voice is the kind of wrong that looks healthy — the same reason this
   * file refuses a half-configured blob store instead of defaulting to memory.
   */
  defaultVoice?: GeminiTtsVoice;
  /** Whether outbound notifications for on-demand articles are queued (audio-feed-np5). Defaults to false. */
  notifyOutboxEnabled?: boolean;
  /**
   * Optional WebAuthn Relying Party ID override (audio-feed-1o2).
   * When unset, defaults to exact hostname (e.g. audio-feed.paulkinlan-ea.deno.net)
   * preventing cross-app clashes.
   */
  webAuthnRpId?: string;
  /**
   * Optional Related Origin Requests (ROR) origins list (audio-feed-1o2).
   * Served at GET /.well-known/webauthn to allow cross-origin passkey recognition.
   */
  webAuthnRelatedOrigins?: string[];
}

// The reader is a parameter (audio-feed-lnnjd): tests pass a fake rather than mutating
// process-global Deno.env, which every concurrently running module would see. The default
// stays Deno.env, so production callers are unchanged.
function envFrom(reader: EnvReader, name: string): string | undefined {
  const value = reader.get(name);
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function loadConfig(reader: EnvReader = Deno.env): AppConfig {
  const port = Number(envFrom(reader, "PORT") ?? 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${envFrom(reader, "PORT")}`);
  }
  const trust = envFrom(reader, "TRUST_PROXY_HEADERS")?.toLowerCase();

  const defaultVoice = envFrom(reader, "DEFAULT_VOICE")?.trim();
  if (defaultVoice) {
    // Fail closed at boot. Every voice actually used is validated downstream too,
    // but catching it here means an operator learns at deploy time, not after the
    // first paid synthesis of the day sounded wrong.
    if (!(GEMINI_TTS_VOICES as readonly string[]).includes(defaultVoice)) {
      throw new Error(
        `Invalid DEFAULT_VOICE: "${defaultVoice}". Expected one of: ${
          GEMINI_TTS_VOICES.join(", ")
        }.`,
      );
    }
  }

  // audio-feed-9yu8: the per-attempt TTS deadline is an operator knob, so a latency spike can be
  // absorbed without a redeploy. Fail closed at boot for the same reason PORT does: a typo that
  // silently fell back to the default would look healthy while every long segment kept dying.
  const ttsTimeoutRaw = envFrom(reader, "TTS_TIMEOUT_MS");
  let ttsTimeoutMs: number | undefined;
  if (ttsTimeoutRaw !== undefined) {
    ttsTimeoutMs = Number(ttsTimeoutRaw);
    if (!Number.isInteger(ttsTimeoutMs) || ttsTimeoutMs <= 0) {
      throw new Error(
        `Invalid TTS_TIMEOUT_MS: "${ttsTimeoutRaw}". Expected a positive integer number of milliseconds.`,
      );
    }
  }

  // audio-feed-khk3: the ceiling that applies when a subscriber has no budget of their own. Fail
  // closed at boot for the same reason TTS_TIMEOUT_MS does: a typo that silently fell back to the
  // default would restore the unbounded behaviour this knob exists to remove, and would look
  // healthy while doing it.
  const defaultBudgetRaw = envFrom(reader, "DEFAULT_DAILY_EPISODE_BUDGET");
  let defaultDailyEpisodeBudget: number | undefined;
  if (defaultBudgetRaw !== undefined) {
    // `env` already treats an empty value as absent, so `DEFAULT_DAILY_EPISODE_BUDGET=` means
    // "unset" and lands on the constant below rather than on 0.
    defaultDailyEpisodeBudget = Number(defaultBudgetRaw);
    if (!Number.isInteger(defaultDailyEpisodeBudget) || defaultDailyEpisodeBudget < 0) {
      throw new Error(
        `Invalid DEFAULT_DAILY_EPISODE_BUDGET: "${defaultBudgetRaw}". ` +
          `Expected a non-negative integer number of episodes per subscriber per day.`,
      );
    }
  }

  // audio-feed-m182: same fail-closed reasoning as the per-subscriber ceiling above. A typo that
  // fell back to the constant would silently replace the operator's number with 500 and look
  // healthy, and a non-integer or negative ceiling is not a ceiling.
  const globalBudgetRaw = envFrom(reader, "GLOBAL_DAILY_EPISODE_BUDGET");
  let globalDailyEpisodeBudget: number | undefined;
  if (globalBudgetRaw !== undefined) {
    globalDailyEpisodeBudget = Number(globalBudgetRaw);
    if (!Number.isInteger(globalDailyEpisodeBudget) || globalDailyEpisodeBudget < 0) {
      throw new Error(
        `Invalid GLOBAL_DAILY_EPISODE_BUDGET: "${globalBudgetRaw}". ` +
          `Expected a non-negative integer number of episodes per day across all subscribers.`,
      );
    }
  }

  const logRetentionRaw = envFrom(reader, "LOG_RETENTION_DAYS");
  let logRetentionDays = DEFAULT_LOG_RETENTION_DAYS;
  if (logRetentionRaw !== undefined && logRetentionRaw !== "") {
    logRetentionDays = Number(logRetentionRaw);
    if (!Number.isInteger(logRetentionDays) || logRetentionDays < 0) {
      throw new Error(
        `Invalid LOG_RETENTION_DAYS: "${logRetentionRaw}". ` +
          `Expected a non-negative integer number of days (0 keeps records indefinitely).`,
      );
    }
  }

  // audio-feed-vqu4: per-invocation work bounds to fit inside Deno Deploy cron isolate lifetime
  const maxSegmentsRaw = envFrom(reader, "MAX_SEGMENTS_PER_INVOCATION");
  let maxSegmentsPerInvocation: number | undefined;
  if (maxSegmentsRaw !== undefined) {
    maxSegmentsPerInvocation = Number(maxSegmentsRaw);
    if (!Number.isInteger(maxSegmentsPerInvocation) || maxSegmentsPerInvocation <= 0) {
      throw new Error(
        `Invalid MAX_SEGMENTS_PER_INVOCATION: "${maxSegmentsRaw}". Expected a positive integer.`,
      );
    }
  }

  const maxDurationRaw = envFrom(reader, "MAX_INVOCATION_DURATION_MS");
  let maxInvocationDurationMs: number | undefined;
  if (maxDurationRaw !== undefined) {
    maxInvocationDurationMs = Number(maxDurationRaw);
    if (!Number.isInteger(maxInvocationDurationMs) || maxInvocationDurationMs <= 0) {
      throw new Error(
        `Invalid MAX_INVOCATION_DURATION_MS: "${maxDurationRaw}". Expected a positive integer number of milliseconds.`,
      );
    }
  }

  return {
    logRetentionDays,
    port,
    // No localhost fallback. An unset value means "resolve it from the request",
    // which is the only thing that knows the real origin.
    publicBaseUrl: envFrom(reader, "PUBLIC_BASE_URL")?.replace(/\/+$/, ""),
    allowedHosts: envFrom(reader, "ALLOWED_HOSTS")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxyHeaders: trust === "1" || trust === "true" || trust === "yes",
    notifyOutboxEnabled: envFrom(reader, "NOTIFY_OUTBOX_ENABLED") === "true" ||
      envFrom(reader, "NOTIFY_OUTBOX_ENABLED") === "1",
    geminiApiKey: envFrom(reader, "GEMINI_API_KEY"),
    ttsTimeoutMs: ttsTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultDailyEpisodeBudget: defaultDailyEpisodeBudget ?? DEFAULT_DAILY_EPISODE_BUDGET,
    // Resolved to a number here so the worker and the admin console read the same value; the worker
    // still treats an unusable value as absent rather than as unlimited.
    globalDailyEpisodeBudget: globalDailyEpisodeBudget ?? DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET,
    maxSegmentsPerInvocation,
    maxInvocationDurationMs: maxInvocationDurationMs ?? DEFAULT_MAX_INVOCATION_DURATION_MS,
    maxUploadRetries: (() => {
      const raw = envFrom(reader, "MAX_UPLOAD_RETRIES");
      const parsed = raw !== undefined ? parseInt(raw, 10) : undefined;
      return parsed !== undefined && Number.isFinite(parsed) && parsed >= 0
        ? parsed
        : DEFAULT_MAX_UPLOAD_RETRIES;
    })(),
    adminToken: envFrom(reader, "ADMIN_TOKEN"),
    // Read here and never anywhere else, so there is one place a reviewer has to look to confirm the
    // key is not logged: nothing writes it to a record, and a request record carries no headers.
    observabilityKey: envFrom(reader, "AUDIOFEED_OBSERVABILITY_KEY"),
    defaultVoice: defaultVoice as GeminiTtsVoice | undefined,
    webAuthnRpId: envFrom(reader, "WEBAUTHN_RP_ID"),
    webAuthnRelatedOrigins: envFrom(reader, "WEBAUTHN_RELATED_ORIGINS")
      ?.split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  };
}

export interface Stores {
  metadata: MetadataStore;
  blobs: BlobStore;
  /**
   * What was actually selected — logged at boot so prod misconfig is visible.
   *
   * PUBLIC. `GET /health` returns this to an unauthenticated caller (src/app.ts), so it names
   * the backend KIND only. The bucket, endpoint and account are identifying detail about the
   * deployment's storage and must never reach this string.
   */
  describe: string;
}

/**
 * Blob backend selection.
 *
 * All-or-nothing: either every S3 variable is present, or none are. A partial
 * set is a configuration error, never a silent downgrade to memory.
 */
export function selectBlobStore(
  reader: EnvReader = Deno.env,
): { store: BlobStore; describe: string } {
  const bucket = envFrom(reader, "STORAGE_BUCKET");
  const endpoint = envFrom(reader, "STORAGE_ENDPOINT");
  const accessKeyId = envFrom(reader, "STORAGE_ACCESS_KEY_ID") ??
    envFrom(reader, "STORAGE_ACCESS_KEY");
  const secretAccessKey = envFrom(reader, "STORAGE_SECRET_ACCESS_KEY") ??
    envFrom(reader, "STORAGE_SECRET_KEY");

  const provided = [bucket, endpoint, accessKeyId, secretAccessKey].filter(Boolean).length;

  if (provided === 0) {
    return { store: new MemoryBlobStore(), describe: "blobs=memory" };
  }
  if (provided < 4) {
    throw new Error(
      "Incomplete blob storage configuration. Set all of STORAGE_BUCKET, " +
        "STORAGE_ENDPOINT, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, or none of them.",
    );
  }

  return {
    store: new S3BlobStore({
      bucket: bucket!,
      endpoint: endpoint!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      region: envFrom(reader, "STORAGE_REGION"),
      publicBaseUrl: envFrom(reader, "STORAGE_PUBLIC_BASE_URL"),
    }),
    // Kind only: the bucket name is not published (see Stores.describe).
    describe: "blobs=s3",
  };
}

export async function openStores(opts?: { kvPath?: string }): Promise<Stores> {
  const blob = selectBlobStore();
  const metadata = await KvMetadataStore.open(opts?.kvPath);
  return {
    metadata,
    blobs: blob.store,
    describe: `metadata=kv ${blob.describe}`,
  };
}

/** Fully in-memory stores, for tests and offline dev. */
export function memoryStores(): Stores {
  return {
    metadata: new MemoryMetadataStore(),
    blobs: new MemoryBlobStore(),
    describe: "metadata=memory blobs=memory",
  };
}
