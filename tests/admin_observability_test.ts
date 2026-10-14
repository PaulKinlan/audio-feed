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
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import {
  buildObservabilityReport,
  claimAttemptsFrom,
  REPORT_CLAIM_CAP,
  REPORT_QUEUE_CAP,
} from "../src/observability/admin_report.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { claimLifecycleEvent } from "../src/storage/episode_events.ts";
import { DEFAULT_CLAIM_LEASE_MS } from "../src/types.ts";
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

Deno.test("audio-feed-n1f7: an empty queue is EARNED, not assumed from claimable === 0", async () => {
  // ACCEPTANCE, WITH THE EXPECTED FAILURE SIGNATURE NAMED IN ADVANCE rather than discovered afterwards:
  // with the fix reverted (the old `rawClaimable === 0 -> "empty"` arm restored ahead of the run
  // history), the FIRST assertion to fail is the one carrying
  // "REGRESSION GUARD: a failed last run with nothing claimable is not an empty queue", reported as
  // expected "stalled" against actual "empty". The controls that still pass in that state are the
  // caught-up control at the top of this test and every other drain assertion in this file, which is
  // what makes the red evidence about the new arm rather than about a broken verdict in general.
  const { stores } = await setup();
  const at = Date.parse("2026-10-11T10:00:00.000Z");

  // CONTROL THAT PASSES: nothing claimable and a recent, error-free, failure-free run. This is the
  // ordinary "all caught up" state, and it must stay `empty` - a fix that made everything stalled
  // would be as wrong as the bug.
  await stores.metadata.recordRun({
    id: "run-caught-up",
    kind: "synthesis",
    trigger: "cron",
    startedAt: "2026-10-11T09:59:30.000Z",
    durationMs: 50,
    ready: 0,
    failed: 0,
    deferred: 0,
  });
  const caughtUp = await buildObservabilityReport(stores, at);
  assertEquals(caughtUp.queue.claimable, 0);
  assertEquals(
    caughtUp.queue.drain,
    "empty",
    "CONTROL: a healthy recent run with nothing claimable is a genuinely empty queue",
  );

  // THE DEFECT (audio-feed-n1f7): nothing claimable, and the last synthesis run RECORDED A FAILURE.
  // Before the fix this reported `empty`, because `claimable === 0` short-circuited the verdict before
  // the run history was consulted - so a human reading "empty" was told all was well at the exact
  // moment the drain had failed. This is also the closest this signal gets to an abandoned episode.
  await stores.metadata.recordRun({
    id: "run-failed",
    kind: "synthesis",
    trigger: "cron",
    startedAt: "2026-10-11T09:59:40.000Z",
    durationMs: 50,
    ready: 0,
    failed: 1,
    deferred: 0,
  });
  const failed = await buildObservabilityReport(stores, at);
  assertEquals(failed.queue.claimable, 0, "nothing is claimable in every case here");
  assertEquals(
    failed.queue.drain,
    "stalled",
    "REGRESSION GUARD: a failed last run with nothing claimable is not an empty queue",
  );
  assertNotEquals(
    failed.queue.drain,
    "empty",
    "and it must never be readable as 'all is well' while the last run failed",
  );

  // A run with a top-level error, and then a stale one: both are evidence against "empty" too.
  await stores.metadata.recordRun({
    id: "run-errored",
    kind: "synthesis",
    trigger: "cron",
    startedAt: "2026-10-11T09:59:50.000Z",
    durationMs: 50,
    ready: 0,
    failed: 0,
    deferred: 0,
    error: "synthesis batch threw",
  });
  assertEquals(
    (await buildObservabilityReport(stores, at)).queue.drain,
    "stalled",
    "an errored last run with nothing claimable is not an empty queue",
  );
  await stores.metadata.recordRun({
    id: "run-stale",
    kind: "synthesis",
    trigger: "cron",
    startedAt: "2026-10-11T09:00:00.000Z",
    durationMs: 50,
    ready: 0,
    failed: 0,
    deferred: 0,
  });
  assertEquals(
    (await buildObservabilityReport(stores, at)).queue.drain,
    "stalled",
    "a stale last run with nothing claimable is not an empty queue",
  );

  // AND THE UNREADABLE-RUN-HISTORY ARM: a failed run read must not render as a healthy verdict, so it
  // is checked BEFORE the `claimable === 0` arm (the same rule as a failed queue read, audio-feed-ciuw).
  stores.metadata.listRuns = () => Promise.reject(new Error("injected run read failure"));
  const unknown = await buildObservabilityReport(stores, at);
  assertEquals(unknown.queue.claimable, 0);
  assertEquals(
    unknown.queue.drain,
    "unknown",
    "a run history that could not be read is not evidence of a healthy drain",
  );
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
  assertStringIncludes(body, "<th>Upload retries</th>");
  assertStringIncludes(body, "upload_retry");
  assertStringIncludes(body, "terminal upload interrupted by invocation budget");
  assertStringIncludes(body, "An episode waiting out an upload retry");
});

Deno.test("audio-feed-lqd6: upload retries counter and reason are surfaced in claim history and on the admin page", async () => {
  const { stores, page } = await setup();
  await stores.metadata.putArticle(
    makeArticle({
      id: "article-lqd6",
      userId: "user-1",
      sourceId: "stratechery",
      content: "Content for lqd6 retry visibility test.",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-lqd6",
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-lqd6",
      status: "pending",
      mode: "direct",
      title: "Episode with multiple upload retries",
    }),
  );

  const leaseMs = 15 * 60_000;
  // Attempt 1: claimed, uploaded, budget abort -> retry 1
  const claimed1 = await stores.metadata.claimEpisode("user-1", "episode-lqd6", {
    owner: "worker-1",
    now: "2026-10-11T16:00:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  assert(claimed1);
  await stores.metadata.yieldEpisodeClaim("user-1", "episode-lqd6", "worker-1", {
    phase: "upload_retry",
    uploadRetry: 1,
    now: "2026-10-11T16:00:10.000Z",
  });
  await stores.metadata.appendLog(
    claimLifecycleEvent(claimed1, {
      phase: "upload_retry",
      attempt: 1,
      claimOutcome: "yielded",
      uploadRetry: 1,
      reason:
        "terminal upload interrupted by invocation budget (45 MB); retrying on a later tick (retry 1/3)",
    }),
  );

  // Attempt 2: claimed, uploaded, budget abort -> retry 2
  const claimed2 = await stores.metadata.claimEpisode("user-1", "episode-lqd6", {
    owner: "worker-2",
    now: "2026-10-11T16:02:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  assert(claimed2);
  await stores.metadata.yieldEpisodeClaim("user-1", "episode-lqd6", "worker-2", {
    phase: "upload_retry",
    uploadRetry: 2,
    now: "2026-10-11T16:02:10.000Z",
  });
  await stores.metadata.appendLog(
    claimLifecycleEvent(claimed2, {
      phase: "upload_retry",
      attempt: 1,
      claimOutcome: "yielded",
      uploadRetry: 2,
      reason:
        "terminal upload interrupted by invocation budget (45 MB); retrying on a later tick (retry 2/3)",
    }),
  );

  const nowMs = Date.parse("2026-10-11T16:05:00.000Z");
  const report = await buildObservabilityReport(stores, nowMs);

  assertEquals(report.retries.length, 1);
  assertEquals(report.retries[0]?.uploadRetry, 2);
  assertEquals(report.retries[0]?.phase, "upload_retry");
  assertStringIncludes(report.retries[0]?.lastRetryReason ?? "", "retry 2/3");

  const response = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`);
  const body = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(body, "<th>Upload retries</th>");
  assertStringIncludes(body, "<td>2</td>");
  assertStringIncludes(body, "retry 2/3");
  assertStringIncludes(body, "Claim history (1)");
  assertStringIncludes(body, "retrying (upload retry 2)");

  // Verify claim attempts folding and outcome labels:
  // Both attempts are folded into attempt 1 with outcome "retrying" and uploadRetry
  const attempts = report.attempts["episode-lqd6"] ?? [];
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0]?.outcome, "retrying");
  assertEquals(attempts[0]?.uploadRetry, 2);

  // Now simulate terminal failure when retry cap is reached
  const claimed3 = await stores.metadata.claimEpisode("user-1", "episode-lqd6", {
    owner: "worker-3",
    now: "2026-10-11T16:06:00.000Z",
    leaseMs,
    maxClaims: 3,
  });
  assert(claimed3);
  const failureReason =
    "terminal audio upload exceeded retry cap (2): 45000000 bytes repeatedly interrupted by invocation budget (assumed 10000 bytes/ms, ~5s estimated duration vs 45000ms budget); raise MAX_INVOCATION_DURATION_MS or MAX_UPLOAD_RETRIES (audio-feed-lqd6)";
  await stores.metadata.completeEpisode(
    { ...claimed3, status: "failed", error: failureReason },
    "worker-3",
  );

  const failReport = await buildObservabilityReport(stores, Date.parse("2026-10-11T16:07:00.000Z"));
  assertEquals(failReport.retries.length, 0, "failed episode is no longer in retries");
  assertEquals(failReport.failures.length >= 1, true, "appears in recent failures");

  const failResponse = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`);
  const failBody = await failResponse.text();
  assertStringIncludes(failBody, "Recent failures");
  assertStringIncludes(failBody, "terminal audio upload exceeded retry cap (2)");
  assertStringIncludes(failBody, "failed (terminal write)");
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
  // audio-feed-m11b: the two log-DERIVED counts must not render as zeros either. They are the same
  // lie as an empty queue for a failed queue read, in a cell nobody had checked yet.
  assertEquals(report.queue.liveClaims, null, "an unreadable log store makes this count UNKNOWN");
  assertEquals(report.queue.abandoned, null);
  assertStringIncludes(body, 'so this is not "no live claims"');
  assertStringIncludes(body, 'so this is not "no abandoned attempts"');
});

Deno.test("audio-feed-ru0z: a failed RUN history read is not 'no history retained'", async () => {
  // The drain STATE ('unknown') was already honest; the explanatory sentence was not, and it sat
  // directly beside a lastRun cell that said the read had failed. Two adjacent statements about the
  // same read cannot disagree.
  const { stores } = await setup();
  await stores.metadata.putEpisode(
    makeEpisode({ id: "episode-q", userId: "user-1", sourceId: "stratechery", status: "pending" }),
  );
  const broken = breakStore(stores, {
    listRuns: () => Promise.reject(new Error("run store down")),
  });

  const report = await buildObservabilityReport(broken, Date.parse("2026-10-11T10:00:00.000Z"));
  assertEquals(report.queue.claimable, 1, "the queue read itself succeeded");
  assertEquals(report.queue.drain, "unknown");

  const ctx = { config, stores: broken };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const body = await (await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  )).text();
  assertStringIncludes(body, "the run history could not be read, so progress cannot be judged");
  assertEquals(
    body.includes("no synthesis run history is retained"),
    false,
    "retention is unknown when the read failed; it is not a fact about what is retained",
  );
});

// ---------------------------------------------------------------------------
// Honest limits
// ---------------------------------------------------------------------------

Deno.test("audio-feed-n6uu: the page states the limits it cannot fix, including the unhandled-error detail", async () => {
  const { stores, page } = await setup();
  const body = await (await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`))
    .text();
  // The invariant this page must not paper over: a request-handler error's message is SCREENED rather than
  // stored raw, and the page has to say what the operator is looking at instead of implying the detail is
  // hidden. Updated by audio-feed-sw1r: the page now shows a screened phrase (never nothing), so the text
  // names the rule AND the marker - "not their message" became "a SCREENED message", which is a different
  // claim, and the old assertion is exactly what caught the difference.
  assertStringIncludes(body, "record their class and a SCREENED message");
  assertStringIncludes(body, "message suppressed (not authored by this codebase)");
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

Deno.test("audio-feed-yrg4: an unreadable log store never renders a Retrying reason as blank", async () => {
  // The finding (an m11b-class sweep over aqms's new Retrying table): the reason cell is sourced from the
  // LOG store while the section only gates on the QUEUE read, so breaking only the log store rendered the
  // cell silently blank - which reads as "the worker recorded no reason" when the truth is "I could not
  // see the reasons". Same shape as audio-feed-ciuw's zero-vs-unreadable queue.
  const { stores } = await setup();
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
  const claimed = await stores.metadata.claimEpisode("user-1", "episode-r", {
    owner: "worker-r",
    now: "2026-10-11T16:00:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claimed, "claim must succeed");
  await stores.metadata.yieldEpisodeClaim("user-1", "episode-r", "worker-r", {
    phase: "upload_retry",
    now: "2026-10-11T16:00:04.000Z",
  });

  const broken = breakStore(stores, {
    listLogs: () => Promise.reject(new Error("log store down")),
  });
  const ctx = { config, stores: broken };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const response = await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  );
  const body = await response.text();
  assertEquals(response.status, 200, "the page must render while the log store is broken");
  // The row itself is DURABLE state, so it is still there: only the reason is unknown.
  assertStringIncludes(body, "Retrying (yielded claims)");
  assertStringIncludes(body, "upload_retry");
  // THE ASSERTION IS THE CELL, NOT THE PAGE: the Queue card's countCell() renders the same phrase for the
  // same failure, so a page-wide substring check passes even when the reason cell is still blank - measured
  // by restoring the blank cell and watching the page-wide version stay green while this one goes red.
  assertStringIncludes(
    body,
    "<td><strong>Unavailable — the log store could not be read</strong></td>",
  );
  assertEquals(
    body.includes("no reason recorded"),
    false,
    "an unreadable log store must not render as 'no reason recorded'",
  );
});

Deno.test("audio-feed-yrg4: a readable log store with no yield record says 'no reason recorded'", async () => {
  // The third state: the log store answers and simply has no yield record for this episode. That is a real
  // absence, and it is stated - the cell is never an empty box whose meaning has to be guessed.
  const { stores } = await setup();
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-q",
      userId: "user-1",
      sourceId: "stratechery",
      status: "pending",
      mode: "direct",
      title: "An episode with no recorded yield reason",
    }),
  );
  const claimed = await stores.metadata.claimEpisode("user-1", "episode-q", {
    owner: "worker-q",
    now: "2026-10-11T16:00:00.000Z",
    leaseMs: 15 * 60_000,
    maxClaims: 3,
  });
  assert(claimed, "claim must succeed");
  await stores.metadata.yieldEpisodeClaim("user-1", "episode-q", "worker-q", {
    phase: "upload_retry",
    now: "2026-10-11T16:00:04.000Z",
  });
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const response = await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  );
  const body = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(body, "upload_retry");
  assertStringIncludes(body, "no reason recorded");
  assertEquals(body.includes("Unavailable — the log store could not be read"), false);
});

Deno.test("audio-feed-sw1r: the page renders the SCREENED message and says that it is screened", async () => {
  // The write side is proven in tests/log_request_surface_invariant_test.ts and tests/error_screen_test.ts.
  // This asserts the READ side matches it: an unhandled-error record's screened message is shown, and the
  // reader is told why the text is one of our phrases rather than the thrown message.
  const { stores, page } = await setup();
  await stores.metadata.appendLog({
    time: new Date().toISOString(),
    severity: "error",
    type: "http.request",
    process: "app",
    message: "unhandled Error on /listen/:token",
    route: "/listen/:token",
    correlationId: "corr-sw1r",
    context: {
      error: "Error",
      errorMessage: "Unauthorized: admin token required",
    },
  });

  const body = await (await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`))
    .text();
  assert(
    body.includes("Unauthorized: admin token required"),
    "the screened message must be rendered for the operator",
  );
  assert(
    body.includes("screened before it was written"),
    "the page must say the message was screened rather than quoting it as the thrown text",
  );
  assert(
    body.includes("Unhandled request errors record their class and a SCREENED message"),
    "the limits section must describe what is actually stored",
  );
});

// ---------------------------------------------------------------------------
// The live lease view (audio-feed-exww)
// ---------------------------------------------------------------------------
//
// Paul's ask was a status page he can read without asking anyone, whose primary content is the
// LIVE CLAIM-LEASE EXPIRIES. The cases below pin three things that make the view worth having, and
// each of them can fail: the expiry is the one the CLAIM recorded (not a default the page invents),
// the page still renders it while every worker-derived read is broken, and an unreadable episode
// store is reported as unreadable rather than as "no worker holds a claim".

/** A live claim in `uploading_audio`, driven through the REAL storage transitions that write it. */
async function driveLiveUploadClaim(
  stores: Stores,
  opts: { episodeId: string; claimedAt: string; leaseMs: number; owner?: string },
): Promise<void> {
  const owner = opts.owner ?? "worker-live";
  await stores.metadata.putEpisode(
    makeEpisode({
      id: opts.episodeId,
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      status: "pending",
      title: `Uploading ${opts.episodeId}`,
      audioKey: undefined,
      createdAt: opts.claimedAt,
    }),
  );
  const claimed = await stores.metadata.claimEpisode("user-1", opts.episodeId, {
    owner,
    now: opts.claimedAt,
    leaseMs: opts.leaseMs,
    maxClaims: 3,
  });
  assertEquals(claimed?.status, "synthesizing", "the fixture must actually take the claim");
  await stores.metadata.touchEpisodeClaim("user-1", opts.episodeId, owner, {
    phase: "uploading_audio",
    now: opts.claimedAt,
  });
}

Deno.test("audio-feed-exww: the page renders the real claim, its phase and its exact lease expiry", async () => {
  const { stores, page } = await setup();
  const claimedAt = "2026-10-12T09:00:00.000Z";
  const leaseMs = 15 * 60_000;
  await driveLiveUploadClaim(stores, { episodeId: "episode-live", claimedAt, leaseMs });
  // A REAL failure record, written by the same log store production writes to.
  await stores.metadata.appendLog({
    time: claimedAt,
    severity: "error",
    type: "synthesis.failure",
    process: "worker",
    message: "TTS provider returned 503 after 3 attempts",
    episodeId: "episode-live",
    userId: "user-1",
  });

  const response = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`);
  const body = await response.text();
  assertEquals(response.status, 200);

  assertStringIncludes(body, "Live claims — lease expiries");
  assertStringIncludes(body, "episode-live");
  assertStringIncludes(body, "uploading_audio");
  assertStringIncludes(body, "worker-live");
  // The EXACT expiry the claim recorded: `claimedAt + the lease the claim was taken with`, rendered
  // as the <time datetime> value. A page that guessed the expiry, or used a hard-coded lease, fails
  // this line - which is the difference between reading the lease and describing one.
  assertStringIncludes(body, "2026-10-12T09:15:00.000Z");
  // And the real failure is on the page, so the two halves of Paul's ask are answered together.
  assertStringIncludes(body, "TTS provider returned 503 after 3 attempts");
});

Deno.test("audio-feed-exww: the lease view still renders when the worker path is unavailable", async () => {
  // THE CONDITION THE PAGE EXISTS FOR. No worker came back to report on itself, the log store cannot
  // be read, and there is no run history at all. If the lease view were built on any of those, it
  // would be empty exactly when an operator needs it.
  const { stores } = await setup();
  const claimedAt = "2026-10-12T09:00:00.000Z";
  const leaseMs = 15 * 60_000;
  await driveLiveUploadClaim(stores, { episodeId: "episode-stuck", claimedAt, leaseMs });

  const broken = breakStore(stores, {
    listLogs: () => Promise.reject(new Error("log store down")),
    logBounds: () => Promise.reject(new Error("log store down")),
    listRuns: () => Promise.reject(new Error("run history down")),
  });

  const ctx = { config, stores: broken };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const response = await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  );
  const body = await response.text();
  assertEquals(response.status, 200, "the page must render with the worker path unavailable");

  // The page says which reads broke, and still answers the question it exists for.
  assertStringIncludes(body, "log store down");
  assertStringIncludes(body, "run history down");
  assertStringIncludes(body, "episode-stuck");
  assertStringIncludes(body, "uploading_audio");
  assertStringIncludes(body, "2026-10-12T09:15:00.000Z");
  assertEquals(
    body.includes("No worker holds a claim right now"),
    false,
    "an unavailable worker path must never render as 'no worker holds a claim'",
  );
  // Without its claim record the page cannot know the claim's own lease, and it says the expiry is
  // derived from the deployment default rather than presenting an assumption as the claim's terms.
  assertStringIncludes(body, "deployment lease of 15 min");
});

Deno.test("audio-feed-exww: an unreadable episode store is UNREADABLE, never 'no worker holds a claim'", async () => {
  const { stores } = await setup();
  const broken = breakStore(stores, {
    listSynthesizingEpisodes: () => Promise.reject(new Error("episode store down")),
  });

  const nowMs = Date.parse("2026-10-12T09:30:00.000Z");
  const report = await buildObservabilityReport(broken, nowMs);
  assertEquals(report.activeClaims, [], "a failed read yields no rows");
  assertEquals(report.activeClaimsReadError?.includes("episode store down"), true);
  assertEquals(report.readErrors.some((failure) => failure.store === "claims"), true);

  const ctx = { config, stores: broken };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const response = await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}` },
    }),
  );
  const body = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(body, 'This is NOT "no worker holds a claim"');
  assertStringIncludes(body, "episode store down");
  assertEquals(
    body.includes("No worker holds a claim right now"),
    false,
    "a failed read must not render as an empty lease set",
  );
});

Deno.test("audio-feed-exww: the claim's OWN lease is used, and a default-derived expiry is labelled", async () => {
  const { stores } = await setup();
  const claimedAt = "2026-10-12T09:00:00.000Z";
  // Deliberately NOT the 15-minute deployment default: a page that used the default would be wrong
  // about this claim, and this is the line that catches it.
  const leaseMs = 60_000;
  await driveLiveUploadClaim(stores, { episodeId: "episode-short-lease", claimedAt, leaseMs });

  const report = await buildObservabilityReport(stores, Date.parse("2026-10-12T09:00:30.000Z"));
  const row = report.activeClaims.find((claim) => claim.episodeId === "episode-short-lease");
  assert(row, "the live claim must be in the report");
  assertEquals(row.leaseMs, leaseMs, "the lease from the claim record must be used");
  assertEquals(row.leaseMsAssumed, false);
  assertEquals(row.leaseExpiresAt, "2026-10-12T09:01:00.000Z");
  assertEquals(row.leaseExpired, false);
  assertEquals(row.remainingMs, 30_000);

  // Anti-vacuity: 60 seconds later the SAME row is expired, so the assertions above observe the
  // lease rather than a constant.
  const later = await buildObservabilityReport(stores, Date.parse("2026-10-12T09:01:30.000Z"));
  const expired = later.activeClaims.find((claim) => claim.episodeId === "episode-short-lease");
  assert(expired);
  assertEquals(expired.leaseExpired, true);
  assertEquals(expired.remainingMs, -30_000);

  // With the log store unreadable the claim record is gone, so the page falls back to the deployment
  // default - and must SAY that, because that expiry is a derived assumption about the lease.
  const noLogs = breakStore(stores, {
    listLogs: () => Promise.reject(new Error("log store down")),
    logBounds: () => Promise.reject(new Error("log store down")),
  });
  const assumed = await buildObservabilityReport(noLogs, Date.parse("2026-10-12T09:00:30.000Z"));
  const assumedRow = assumed.activeClaims.find((claim) =>
    claim.episodeId === "episode-short-lease"
  );
  assert(assumedRow);
  assertEquals(assumedRow.leaseMs, DEFAULT_CLAIM_LEASE_MS);
  assertEquals(assumedRow.leaseMsAssumed, true, "a default-derived expiry must be flagged");
  assertEquals(assumedRow.leaseExpiresAt, "2026-10-12T09:15:00.000Z");
});

Deno.test("audio-feed-exww: a claim with no readable claimedAt reports an UNKNOWN expiry, never false", async () => {
  const { stores } = await setup();
  // A `synthesizing` episode whose claim predates the lease fields (or lost `claimedAt`): the store
  // cannot say when the lease expires, and an expiry nobody can compute is unknown - rendering it as
  // "not expired" would be an invented fact about a claim that may have died long ago.
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-legacy-claim",
      userId: "user-1",
      sourceId: "stratechery",
      articleId: "article-1",
      status: "synthesizing",
      claimedBy: "worker-x",
      claimedAt: undefined,
      phase: "uploading_audio",
      audioKey: undefined,
    }),
  );

  const report = await buildObservabilityReport(stores, Date.parse("2026-10-12T09:00:00.000Z"));
  const row = report.activeClaims.find((claim) => claim.episodeId === "episode-legacy-claim");
  assert(row, "an expired-lease claim is still a live claim row");
  assertEquals(row.leaseExpiresAt, undefined);
  assertEquals(row.leaseExpired, null, "unknown is null, never false");
  assertEquals(row.remainingMs, null);
});

Deno.test("audio-feed-exww: a truncated lease listing says it is truncated, never a silent total", async () => {
  const { stores, page } = await setup();
  const claimedAt = "2026-10-12T09:00:00.000Z";
  for (let index = 0; index <= REPORT_CLAIM_CAP; index++) {
    await driveLiveUploadClaim(stores, {
      episodeId: `episode-cap-${index}`,
      claimedAt,
      leaseMs: 15 * 60_000,
      owner: `worker-${index}`,
    });
  }

  const report = await buildObservabilityReport(stores, Date.parse("2026-10-12T09:10:00.000Z"));
  assertEquals(report.activeClaims.length, REPORT_CLAIM_CAP);
  assertEquals(report.activeClaimsCapped, true);

  const response = await page(`${SESSION_COOKIE}=${await sessionFor(stores, "admin-1")}`);
  const body = await response.text();
  assertEquals(response.status, 200);
  assertStringIncludes(body, "truncated listing");
});

Deno.test("audio-feed-exww: an expired row renders the elapsed TIME, and a live row does not", async () => {
  // The regression test for the mutant that exposed a tautology: the expired-row check used to be
  // `includes("LEASE EXPIRED with no terminal write") && includes("expired")`, and the FIRST clause
  // contains the second, so a cell that dropped the duration still passed. This pins the RENDERED
  // duration in the row itself, so a page that says only the word fails here.
  //
  // Two separate trees, so the two assertions cannot be satisfied by each other's row: the pattern
  // must be present when the only claim is overdue, and absent when the only claim is live.
  const TIMED = /expired \d+ (min|s) ago/;
  const rowOf = (body: string, episodeId: string): string | undefined => {
    // Scoped to ONE row: split on the row open tag, then cut at the close tag, so the pattern cannot
    // be satisfied by text from elsewhere on the page.
    const chunk = body.split("<tr>").find((candidate) =>
      candidate.includes(episodeId) && candidate.includes("uploading_audio")
    );
    return chunk === undefined ? undefined : chunk.slice(0, chunk.indexOf("</tr>"));
  };

  const overdue = await setup();
  await driveLiveUploadClaim(overdue.stores, {
    episodeId: "ep-overdue",
    claimedAt: "2026-01-01T00:00:00.000Z",
    leaseMs: 15 * 60_000,
  });
  const overdueBody = await (await overdue.page(
    `${SESSION_COOKIE}=${await sessionFor(overdue.stores, "admin-1")}`,
  )).text();
  const overdueRow = rowOf(overdueBody, "ep-overdue");
  assert(overdueRow, "the overdue claim must have a rendered row");
  assert(
    TIMED.test(overdueRow),
    `an expired lease must render HOW LONG AGO it expired, not just the word: ${overdueRow}`,
  );
  assertStringIncludes(overdueRow, "LEASE EXPIRED with no terminal write");

  const live = await setup();
  await driveLiveUploadClaim(live.stores, {
    episodeId: "ep-current",
    claimedAt: new Date().toISOString(),
    leaseMs: 15 * 60_000,
  });
  const liveBody = await (await live.page(
    `${SESSION_COOKIE}=${await sessionFor(live.stores, "admin-1")}`,
  )).text();
  const liveRow = rowOf(liveBody, "ep-current");
  assert(liveRow, "the live claim must have a rendered row");
  assertEquals(
    TIMED.test(liveRow),
    false,
    `a live lease must NOT be rendered with an expired duration: ${liveRow}`,
  );
  assertStringIncludes(liveRow, "left");
});

Deno.test("audio-feed-exww: the default-lease label appears only when the claim's lease is unknown", async () => {
  // Two-sided, because a label is a claim about the data: it must be RENDERED when the expiry is
  // derived from the deployment lease (otherwise the fallback is invisible and the cell reads as the
  // claim's own terms), and it must NOT be rendered when the claim's own lease was read (otherwise
  // every row carries an assumption label and the one that matters is lost in the noise).
  const known = await setup();
  await driveLiveUploadClaim(known.stores, {
    episodeId: "ep-lease-known",
    claimedAt: new Date().toISOString(),
    leaseMs: 15 * 60_000,
  });
  const knownBody = await (await known.page(
    `${SESSION_COOKIE}=${await sessionFor(known.stores, "admin-1")}`,
  )).text();
  assertStringIncludes(knownBody, "ep-lease-known");
  assertEquals(
    knownBody.includes("computed from the deployment lease"),
    false,
    "the claim's own lease record IS readable here, so no assumption label may be rendered",
  );

  const unknown = await setup();
  await driveLiveUploadClaim(unknown.stores, {
    episodeId: "ep-lease-unknown",
    claimedAt: new Date().toISOString(),
    leaseMs: 15 * 60_000,
  });
  const broken = breakStore(unknown.stores, {
    listLogs: () => Promise.reject(new Error("log store down")),
    logBounds: () => Promise.reject(new Error("log store down")),
  });
  const ctx = { config, stores: broken };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const body = await (await fetch(
    new Request(`${BASE}/admin/observability`, {
      headers: { cookie: `${SESSION_COOKIE}=${await sessionFor(unknown.stores, "admin-1")}` },
    }),
  )).text();
  assertStringIncludes(body, "ep-lease-unknown");
  assertStringIncludes(body, "computed from the deployment lease");
});
