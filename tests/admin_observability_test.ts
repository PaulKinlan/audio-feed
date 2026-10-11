/**
 * The admin observability page (audio-feed-n6uu).
 *
 * Paul's requirement: "I asked you to build in observability. I need you to manage this so I can see
 * it from the admin page in audio-feed." He had to COPY a failed episode and its claim history out
 * of the UI and paste it to the fleet, so what these tests pin is precisely that story:
 *
 *   1. the page is behind the EXISTING admin gate (session + isActiveAdmin) and carries no failure
 *      data to anyone else — the detail includes other people's subscriptions;
 *   2. the failure it shows is the real one: a claim that died without a terminal write is rendered
 *      with the PHASE each attempt reached and the lease expiry, not as a bare "failed";
 *   3. the read model survives the failure it reports, because it reads durable storage directly.
 *
 * The abandonment case is driven through the real storage transitions (claimEpisode /
 * touchEpisodeClaim / the refusing claim that triggers abandonment), so the records the page reads
 * are the ones production writes — not hand-built fixtures that would pass while the real writer
 * changed shape.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import {
  buildObservabilityReport,
  claimAttemptsFrom,
  REPORT_QUEUE_CAP,
} from "../src/observability/admin_report.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { claimLifecycleEvent } from "../src/storage/episode_events.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { LogRecord } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const ADMIN_TOKEN = "admin-secret";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: ADMIN_TOKEN };

/** A detail string that must never reach a non-admin: it stands in for the error text. */
const SECRET_DETAIL = "secret-failure-detail-9ff2";

async function setup() {
  const stores: Stores = memoryStores();
  const admin = makeUser({
    id: "admin-1",
    email: "admin@example.com",
    isAdmin: true,
    status: "approved",
  });
  await stores.metadata.putUser(admin);
  await stores.metadata.putUser(
    makeUser({ id: "user-1", email: "subscriber@example.com", status: "approved" }),
  );
  await stores.metadata.putSource(makeSource({ id: "stratechery", userId: "user-1" }));
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const page = (cookie?: string) =>
    fetch(
      new Request(`${BASE}/admin/observability`, {
        headers: cookie ? { cookie } : {},
      }),
    );
  return { stores, ctx, fetch, page, admin };
}

const sessionFor = (stores: Stores, userId: string) => createSession(stores.metadata, userId);

/**
 * `stores` with some durable reads failing, so the tests can prove a READ FAILURE is never rendered
 * as an absence (audio-feed-ciuw). A proxy rather than a spread: `MemoryMetadataStore` is a class,
 * so its methods live on the prototype and a spread would silently produce a store with no methods
 * at all - which is a different bug from the one under test.
 */
function breakStore(
  stores: Stores,
  overrides: Record<string, (...args: never[]) => Promise<never>>,
): Stores {
  const metadata = new Proxy(stores.metadata, {
    get(target, property, receiver) {
      const override = overrides[property as string];
      if (override) return override;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...stores, metadata };
}

/**
 * The incident shape: three workers claim the same episode, each dies mid-phase without a terminal
 * write, and the fourth claim finds the ceiling and abandons it. This is the history Paul could not
 * read from the console without copying it out.
 */
async function driveAbandonedEpisode(stores: Stores) {
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-1",
      userId: "user-1",
      sourceId: "stratechery",
      content: "First paragraph. Second paragraph.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      status: "pending",
      mode: "direct",
      title: "Super Intelligence Is Not Right, Either",
    }),
  );
  const leaseMs = 15 * 60_000;
  await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-1",
    now: "2026-10-11T14:00:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  await stores.metadata.touchEpisodeClaim("user-1", "episode-1", "worker-1", {
    phase: "synthesizing_segment_1_of_4",
    now: "2026-10-11T14:02:00.000Z",
  });
  await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-2",
    now: "2026-10-11T14:16:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  await stores.metadata.touchEpisodeClaim("user-1", "episode-1", "worker-2", {
    phase: "synthesizing_segment_3_of_4",
    now: "2026-10-11T14:18:00.000Z",
  });
  await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-3",
    now: "2026-10-11T14:32:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  await stores.metadata.touchEpisodeClaim("user-1", "episode-1", "worker-3", {
    phase: "uploading_audio",
    now: "2026-10-11T14:34:00.000Z",
  });
  // The claim that finds the ceiling: it is refused AND the store writes the abandonment.
  const refused = await stores.metadata.claimEpisode("user-1", "episode-1", {
    owner: "worker-4",
    now: "2026-10-11T14:48:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  assertEquals(refused, null, "the ceiling must refuse the fourth claim");
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

Deno.test("audio-feed-n6uu: the page refuses a visitor and an admin-less subscriber, with no failure data", async () => {
  const { stores, page } = await setup();
  await stores.metadata.appendLog({
    time: new Date().toISOString(),
    severity: "error",
    type: "synthesis.failure",
    process: "worker",
    message: SECRET_DETAIL,
    episodeId: "episode-1",
    userId: "user-1",
  });

  // No session at all: this page is not public, and the shell must carry no failure text.
  const anonymous = await page();
  const anonymousBody = await anonymous.text();
  assertEquals(anonymous.status, 403, "an anonymous caller must not read failure detail");
  assertStringIncludes(anonymousBody, "Observability is for admins");
  assertEquals(
    anonymousBody.includes(SECRET_DETAIL),
    false,
    "a visitor must not receive any failure detail",
  );

  // A signed-in subscriber is somebody — just not an admin.
  const subscriber = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "user-1")}`);
  const subscriberBody = await subscriber.text();
  assertEquals(subscriber.status, 403, "a non-admin session must not read failure detail");
  assertEquals(
    subscriberBody.includes(SECRET_DETAIL),
    false,
    "a subscriber must not receive failure detail either",
  );

  // An admin does get it, which is what makes the two refusals above meaningful rather than vacuous.
  const admin = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`);
  const adminBody = await admin.text();
  assertEquals(admin.status, 200);
  assertStringIncludes(adminBody, SECRET_DETAIL);
  // Header contract, same as the console: never cached, never indexed, no referrer.
  assertEquals(admin.headers.get("cache-control"), "no-store");
  assertEquals(admin.headers.get("x-robots-tag"), "noindex");
  assertEquals(admin.headers.get("referrer-policy"), "no-referrer");
  const csp = admin.headers.get("content-security-policy") ?? "";
  assertStringIncludes(csp, "nonce-");
});

// ---------------------------------------------------------------------------
// The failure story
// ---------------------------------------------------------------------------

Deno.test("audio-feed-n6uu: an abandoned claim renders the phase each attempt died in and the missing terminal write", async () => {
  const { stores, page } = await setup();
  await driveAbandonedEpisode(stores);

  const response = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`);
  const body = await response.text();
  assertEquals(response.status, 200);

  // Every attempt's phase is visible, which is what "the phase-per-attempt view" means.
  for (
    const phase of [
      "claimed",
      "synthesizing_segment_1_of_4",
      "synthesizing_segment_3_of_4",
      "uploading_audio",
    ]
  ) {
    assertStringIncludes(body, phase);
  }
  // The owner of each attempt, so "which worker" is answerable for PAST attempts too.
  for (const owner of ["worker-1", "worker-2", "worker-3"]) {
    assertStringIncludes(body, owner);
  }
  // The distinction that a bare "failed" cannot express.
  assertStringIncludes(body, "NO terminal write");
  // The episode and its recorded error, and the correlation id that joins the records.
  assertStringIncludes(body, "episode-1");
  assertStringIncludes(body, "abandoned after 3 attempts");
  // "Super Intelligence Is Not Right, Either" was the item Paul was looking at.
  assertStringIncludes(body, "Super Intelligence Is Not Right, Either");

  // And the report itself tells the same story, so the page is not where the truth lives.
  const report = await buildObservabilityReport(stores, Date.parse("2026-10-11T15:00:00.000Z"));
  const attempts = report.attempts["episode-1"] ?? [];
  assertEquals(attempts.length, 3, `three attempts were claimed; got ${attempts.length}`);
  assertEquals(attempts.map((attempt) => attempt.attempt), [1, 2, 3]);
  assertEquals(attempts[0]?.owner, "worker-1");
  assertEquals(attempts[0]?.phase, "synthesizing_segment_1_of_4");
  assertEquals(attempts[0]?.leaseMs, 15 * 60_000);
  assertEquals(attempts[0]?.leaseExpiresAt, "2026-10-11T14:15:00.000Z");
  assertEquals(attempts[0]?.leaseExpired, true);
  assertEquals(attempts[0]?.endedWithTerminalWrite, false);
  assertEquals(attempts[0]?.outcome, "abandoned");
  assertEquals(attempts[2]?.phase, "uploading_audio");
});

Deno.test("audio-feed-n6uu: a finished attempt is told apart from one that died", () => {
  // The read model, exercised directly: the mutant this kills is treating "there is a record" as
  // "there was a terminal write", which is exactly how a dead claim reads as a success.
  const base = { type: "claim.lifecycle", process: "storage" as const };
  const records: LogRecord[] = [
    {
      ...base,
      seq: 1,
      time: "2026-10-11T10:00:00.000Z",
      severity: "info",
      message: "",
      phase: "claimed",
      attempt: 1,
      correlationId: "episode-x",
      episodeId: "episode-x",
      context: { owner: "worker-a", leaseMs: 60_000, maxClaims: 3 },
    },
    {
      ...base,
      seq: 2,
      time: "2026-10-11T10:00:20.000Z",
      severity: "info",
      message: "",
      phase: "generating_script",
      attempt: 1,
      correlationId: "episode-x",
      episodeId: "episode-x",
    },
    {
      ...base,
      seq: 3,
      time: "2026-10-11T10:00:50.000Z",
      severity: "info",
      message: "",
      phase: "completing",
      attempt: 1,
      durationMs: 50_000,
      correlationId: "episode-x",
      episodeId: "episode-x",
    },
    {
      ...base,
      seq: 4,
      time: "2026-10-11T10:05:00.000Z",
      severity: "info",
      message: "",
      phase: "claimed",
      attempt: 2,
      correlationId: "episode-x",
      episodeId: "episode-x",
      context: { owner: "worker-b", leaseMs: 60_000 },
    },
    {
      ...base,
      seq: 5,
      time: "2026-10-11T10:06:30.000Z",
      severity: "error",
      message: "",
      phase: "reading_article",
      attempt: 2,
      reason: "abandoned after 3 attempts; reason: claim lease expired without terminal write",
      correlationId: "episode-x",
      episodeId: "episode-x",
      context: { workerState: "unknown", expiredAt: "2026-10-11T10:06:00.000Z" },
    },
    {
      ...base,
      seq: 6,
      time: "2026-10-11T10:10:00.000Z",
      severity: "info",
      message: "",
      phase: "claimed",
      attempt: 3,
      correlationId: "episode-x",
      episodeId: "episode-x",
      context: { owner: "worker-c", leaseMs: 15 * 60_000 },
    },
  ];
  const attempts = claimAttemptsFrom(records, Date.parse("2026-10-11T10:12:00.000Z"));
  assertEquals(attempts.length, 3);

  assertEquals(attempts[0]?.outcome, "finished");
  assertEquals(attempts[0]?.endedWithTerminalWrite, true);
  assertEquals(attempts[0]?.phase, "completing");
  assertEquals(attempts[0]?.durationMs, 50_000);
  assertEquals(attempts[0]?.owner, "worker-a");
  assertEquals(attempts[0]?.leaseExpiresAt, "2026-10-11T10:01:00.000Z");
  assertEquals(attempts[0]?.leaseExpired, true);

  assertEquals(attempts[1]?.outcome, "abandoned", "a lease expiry is not a terminal write");
  assertEquals(attempts[1]?.endedWithTerminalWrite, false);
  assertEquals(attempts[1]?.phase, "reading_article");
  assertEquals(attempts[1]?.reason?.includes("lease expired"), true);

  // Still running, lease live: not a failure, and not claimed as one.
  assertEquals(attempts[2]?.outcome, "in-flight");
  assertEquals(attempts[2]?.leaseExpired, false);
  assertEquals(attempts[2]?.endedWithTerminalWrite, false);
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

Deno.test("audio-feed-n6uu: the queue section counts claimable work and says whether it is draining", async () => {
  const { stores, page } = await setup();
  const queued = makeEpisode({
    id: "episode-q",
    userId: "user-1",
    sourceId: "stratechery",
    status: "pending",
    createdAt: "2026-10-11T09:00:00.000Z",
  });
  await stores.metadata.putEpisode(queued);

  // Queued work and no run history: the page must not pretend to know progress.
  const unknown = await buildObservabilityReport(stores, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(unknown.queue.claimable, 1);
  assertEquals(unknown.queue.drain, "unknown");
  assertEquals(unknown.queue.oldestClaimableAt, "2026-10-11T09:00:00.000Z");

  // A recent run that finished episodes: draining.
  await stores.metadata.recordRun({
    id: "run-1",
    kind: "synthesis",
    trigger: "cron",
    startedAt: "2026-10-11T09:59:00.000Z",
    durationMs: 1_000,
    ready: 2,
    failed: 0,
    deferred: 0,
  });
  const draining = await buildObservabilityReport(stores, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(draining.queue.drain, "draining");

  // A recent run that finished nothing is the "queued but not moving" case.
  await stores.metadata.recordRun({
    id: "run-2",
    kind: "synthesis",
    trigger: "cron",
    startedAt: "2026-10-11T09:59:30.000Z",
    durationMs: 1_000,
    ready: 0,
    failed: 1,
    deferred: 0,
  });
  const stalled = await buildObservabilityReport(stores, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(stalled.queue.drain, "stalled");

  const body = await (await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`))
    .text();
  assertStringIncludes(body, "Claimable now");
  assertStringIncludes(body, "queued work is NOT being processed");
  assertStringIncludes(body, "episode-q".length > 0 ? "Queue" : "Queue");
});

Deno.test("audio-feed-n6uu: the claimable count is capped and says so rather than reporting a total it did not measure", async () => {
  const { stores } = await setup();
  for (let i = 0; i <= REPORT_QUEUE_CAP; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `episode-${i}`,
        userId: "user-1",
        sourceId: "stratechery",
        status: "pending",
      }),
    );
  }
  const report = await buildObservabilityReport(stores, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(report.queue.claimable, REPORT_QUEUE_CAP);
  assertEquals(report.queue.claimableCapped, true);
});

// ---------------------------------------------------------------------------
// Review findings from the first round (audio-feed-506m, audio-feed-ciuw)
// ---------------------------------------------------------------------------

Deno.test("audio-feed-2sec: a yielded attempt reads as retrying and NEVER as a terminal write", () => {
  // The read model, exercised directly. The mutant this kills is treating a reason string as a
  // terminal verdict: the yield record carries BOTH a reason (explanation) and the structured
  // claimOutcome (fact), and folding must key on the fact — otherwise this yielded claim
  // reports as "failed with a terminal write", contradicting the episode's durable state
  // (still pending, preserved for resume).
  const base = {
    type: "claim.lifecycle",
    process: "worker" as const,
    correlationId: "episode-y",
    episodeId: "episode-y",
    userId: "user-1",
  };
  const records: LogRecord[] = [
    {
      ...base,
      seq: 1,
      time: "2026-10-11T16:00:00.000Z",
      severity: "info",
      message: "",
      phase: "claimed",
      attempt: 1,
      context: { owner: "worker-a", leaseMs: 60_000 },
    },
    {
      ...base,
      seq: 2,
      time: "2026-10-11T16:00:10.000Z",
      severity: "info",
      message: "",
      phase: "uploading_audio",
      attempt: 1,
    },
    {
      ...base,
      seq: 3,
      time: "2026-10-11T16:00:12.000Z",
      severity: "info",
      message: "",
      phase: "upload_retry",
      attempt: 1,
      reason: "terminal upload interrupted by invocation budget; retrying on a later tick",
      context: { claimOutcome: "yielded" },
    },
    // A later invocation picks the episode up and finishes it: the yielded attempt must stay
    // non-terminal even when a LATER attempt on the same episode is terminal.
    {
      ...base,
      seq: 4,
      time: "2026-10-11T16:02:00.000Z",
      severity: "info",
      message: "",
      phase: "claimed",
      attempt: 2,
      context: { owner: "worker-b", leaseMs: 60_000 },
    },
    {
      ...base,
      seq: 5,
      time: "2026-10-11T16:02:08.000Z",
      severity: "info",
      message: "",
      phase: "ready",
      attempt: 2,
      durationMs: 8_000,
    },
  ];
  const attempts = claimAttemptsFrom(records, Date.parse("2026-10-11T16:05:00.000Z"));
  assertEquals(attempts.length, 2);
  assertEquals(attempts[0]?.outcome, "retrying");
  assertEquals(
    attempts[0]?.endedWithTerminalWrite,
    false,
    "THE PROPERTY: a yielded attempt is never reported as ended with a terminal write",
  );
  assertEquals(attempts[1]?.outcome, "finished");
  assertEquals(attempts[1]?.endedWithTerminalWrite, true);
});

Deno.test("audio-feed-2sec: a pending upload_retry episode is VISIBLE as retrying, in the report and on the page", async () => {
  const { stores, page } = await setup();
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-r",
      userId: "user-1",
      sourceId: "stratechery",
      content: "One paragraph of content.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-r",
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-r",
      status: "pending",
      mode: "direct",
      title: "An episode waiting out an upload retry",
    }),
  );
  const leaseMs = 15 * 60_000;
  const claimed = await stores.metadata.claimEpisode("user-1", "episode-r", {
    owner: "worker-r",
    now: "2026-10-11T16:00:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  assert(claimed, "claim must succeed");
  await stores.metadata.touchEpisodeClaim("user-1", "episode-r", "worker-r", {
    phase: "uploading_audio",
    now: "2026-10-11T16:00:02.000Z",
  });
  // The yield: claim released deliberately, phase preserved, one lifecycle record with the
  // structured verdict — exactly what the worker writes on a budget-interrupted upload.
  const yielded = await stores.metadata.yieldEpisodeClaim(
    "user-1",
    "episode-r",
    "worker-r",
    { phase: "upload_retry", now: "2026-10-11T16:00:04.000Z" },
  );
  assert(yielded, "yield must succeed");
  await stores.metadata.appendLog(
    claimLifecycleEvent(claimed!, {
      phase: "upload_retry",
      attempt: 1,
      claimOutcome: "yielded",
      reason: "terminal upload interrupted by invocation budget (143 MB); retrying on a later tick",
    }),
  );

  const nowMs = Date.parse("2026-10-11T16:06:00.000Z");
  const report = await buildObservabilityReport(stores, nowMs);

  // The report: the episode is retrying, from DURABLE state, with the recorded reason.
  assertEquals(report.retries.length, 1, "the yielded claim must be visible as retrying");
  assertEquals(report.retries[0]?.episodeId, "episode-r");
  assertEquals(report.retries[0]?.phase, "upload_retry");
  assertEquals(report.retries[0]?.attempts, 0, "progress yield resets attempts");
  assertStringIncludes(report.retries[0]?.lastRetryReason ?? "", "terminal upload interrupted");
  assertEquals(report.retries[0]?.waitingMs, 6 * 60_000 - 4_000);

  // And the folding for the same episode: retrying, never terminal.
  const attempts = report.attempts["episode-r"] ?? [];
  assertEquals(attempts[0]?.outcome, "retrying");
  assertEquals(attempts[0]?.endedWithTerminalWrite, false);

  // The page: the section exists, names the phase and the recorded reason, and does NOT
  // present the episode as failed.
  const response = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`);
  const body = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(body, "Retrying (yielded claims)");
  assertStringIncludes(body, "upload_retry");
  assertStringIncludes(body, "terminal upload interrupted by invocation budget");
  assertStringIncludes(body, "An episode waiting out an upload retry");
});

Deno.test("audio-feed-506m: newer unrelated feed polls cannot hide the synthesis run the drain verdict needs", async () => {
  // The finding: listRuns(20) is a GLOBAL newest-first page, cut to 20, so twenty feed-poll runs
  // crowded out the synthesis run and the page reported drain=unknown with a synthesis run sitting
  // in the store. A page whose job is "is the queue draining" must not be blinded by job kind.
  const { stores, page } = await setup();
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-q",
      userId: "user-1",
      sourceId: "stratechery",
      status: "pending",
      createdAt: "2026-10-11T09:00:00.000Z",
    }),
  );
  await stores.metadata.recordRun({
    id: "syn",
    kind: "synthesis",
    trigger: "cron",
    startedAt: "2026-10-11T09:50:00.000Z",
    durationMs: 1_000,
    ready: 3,
    failed: 0,
    deferred: 0,
  });
  for (let i = 0; i < 20; i++) {
    await stores.metadata.recordRun({
      id: `poll-${i}`,
      kind: "feed-poll",
      trigger: "cron",
      startedAt: `2026-10-11T09:51:${String(i).padStart(2, "0")}.000Z`,
      durationMs: 500,
      polled: 1,
      queued: 0,
      failed: 0,
    });
  }

  // The unscoped read is the bug: it no longer contains the synthesis run at all. Pinned so that a
  // revert to a global page fails HERE rather than only in the report's drain verdict.
  assertEquals(
    (await stores.metadata.listRuns(20)).some((run) => run.kind === "synthesis"),
    false,
    "the unscoped page is what hid the run",
  );

  const report = await buildObservabilityReport(stores, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(report.queue.claimable, 1);
  assert(
    report.queue.lastSynthesisRun,
    "the retained synthesis run must be found behind 20 newer feed polls",
  );
  assertEquals(report.queue.drain, "draining", "and the drain verdict must use it");

  const body = await (await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`))
    .text();
  assertStringIncludes(body, "Last synthesis run");
  assertStringIncludes(body, "3 ready");
  assertEquals(
    body.includes("no run recorded"),
    false,
    "the page must not claim no run was recorded",
  );
});

Deno.test("audio-feed-ciuw: a failed durable queue read is UNREADABLE, never zero work", async () => {
  // The finding: `.catch(() => ({episodes: []}))` turned a read FAILURE into an empty queue, so the
  // page said "nothing queued" at the exact moment it could not see the queue - the most dangerous
  // possible lie in this feature. Three states now: populated, empty, unreadable.
  const { stores } = await setup();
  await stores.metadata.putEpisode(
    makeEpisode({ id: "episode-p", userId: "user-1", sourceId: "stratechery", status: "pending" }),
  );
  const broken = breakStore(stores, {
    listPendingEpisodes: () => Promise.reject(new Error("kv unavailable")),
  });

  const report = await buildObservabilityReport(broken, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(report.queue.claimable, null, "an unreadable queue is null, NOT zero");
  assertEquals(report.queue.drain, "unreadable");
  assertEquals(report.queue.readError?.includes("kv unavailable"), true);
  assertEquals(report.readErrors.some((failure) => failure.store === "queue"), true);

  // The page still renders (it must keep working while things are broken), and it says what broke.
  const ctx = { config, stores: broken };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const response = await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  );
  const body = await response.text();
  assertEquals(response.status, 200, "the page must render even when its own queue read fails");
  assertStringIncludes(body, "This is NOT an empty queue");
  assertStringIncludes(body, "kv unavailable");
  assertEquals(
    body.includes("nothing queued"),
    false,
    "an unreadable queue must never render as 'nothing queued'",
  );
});

Deno.test("audio-feed-ciuw: failed log and run reads are reported as unreadable, not as absence", async () => {
  const { stores } = await setup();
  const broken = breakStore(stores, {
    listLogs: () => Promise.reject(new Error("log store down")),
    listRuns: () => Promise.reject(new Error("run store down")),
  });

  const report = await buildObservabilityReport(broken, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(report.readErrors.map((failure) => failure.store).sort(), ["logs", "runs"]);
  assertEquals(report.queue.runsReadError?.includes("run store down"), true);

  const ctx = { config, stores: broken };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const response = await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  );
  const body = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(body, "log store down");
  assertStringIncludes(body, "run store down");
  assertStringIncludes(body, "the run history read failed");
  assertEquals(
    body.includes("No warn/error records"),
    false,
    "a log read failure must not render as 'no failures'",
  );
  assertEquals(
    body.includes("no run recorded"),
    false,
    "a run read failure must not render as 'it never ran'",
  );
});

// ---------------------------------------------------------------------------
// Honest limits
// ---------------------------------------------------------------------------

Deno.test("audio-feed-n6uu: the page states the limits it cannot fix, including the unhandled-error detail", async () => {
  const { stores, page } = await setup();
  const body = await (await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`))
    .text();
  // The invariant this page must not paper over: request-handler error messages are deliberately
  // NOT stored, and the page has to say where the detail actually lives instead of implying it is
  // hidden. Removing this text means an operator hunts for a message that was never recorded.
  assertStringIncludes(body, "record their class, not their message");
  assertStringIncludes(body, "correlation id");
  // And the host-gate limit: this page cannot render when the gate refuses the host.
  assertStringIncludes(body, "host gate");
  // The page is read-only: no form, no button that mutates.
  // The page is read-only: none of the console's mutating controls are here. (The shared shell
  // still carries its own sign-out form and confirm dialog, so "no <button> anywhere" would be
  // asserting about the shell, not about this page.)
  for (
    const control of [
      'id="retryBtn"',
      'id="pollNowBtn"',
      'id="synthesizeNowBtn"',
      'id="createForm"',
    ]
  ) {
    assertEquals(body.includes(control), false, `v1 is read-only: ${control} must not be here`);
  }
});

Deno.test("audio-feed-n6uu: the admin console links to the page", async () => {
  const { stores, fetch } = await setup();
  const consoleRes = await fetch(
    new Request(`${BASE}/admin`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  );
  const body = await consoleRes.text();
  assertEquals(consoleRes.status, 200);
  assertStringIncludes(body, 'href="/admin/observability"');
});
