/**
 * `GET /api/admin/stats` and the token-persistence choice (audio-feed-ndc).
 *
 * Two things this file is careful about:
 *
 * 1. The endpoint is ADMIN-GATED and returns per-subscriber figures plus their
 *    email addresses. That is exactly the shape of response that must never be
 *    reachable without the token, so the gate is tested before anything else —
 *    a dashboard that leaks who downloaded what is worse than no dashboard.
 * 2. "Remember token on this device" is a claim about WHERE a credential went.
 *    Asserting the checkbox state would pass while the token sat in the wrong
 *    store, so these drive the real shipped script and then look in BOTH web
 *    storages. That is the same reasoning as audio-feed-05b: watch for the
 *    effect, not for the appearance.
 */
import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { runAdminScript } from "./admin_script.ts";
import { makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { RunRecord } from "../src/storage/mod.ts";

const BASE = "https://audio.example.com";
const TOKEN_KEY = "audio-feed-admin-token";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

function app() {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores };
}

const statsRequest = (token: string | null = "admin-secret") =>
  new Request(`${BASE}/api/admin/stats`, {
    headers: token ? { "x-admin-token": token } : {},
  });

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  kind: "feed-poll",
  trigger: "cron",
  startedAt: "2026-09-25T10:00:00.000Z",
  durationMs: 100,
  polled: 2,
  queued: 1,
  failed: 0,
  ...over,
});

// -- the gate -------------------------------------------------------------

Deno.test("stats are unreachable without the admin token (audio-feed-ndc)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.recordDownload("user-1");

  assertEquals((await fetch(statsRequest(null))).status, 401);
  assertEquals((await fetch(statsRequest("wrong"))).status, 401);

  // And the refusal must not leak the figures it is refusing to show.
  const body = await (await fetch(statsRequest(null))).text();
  assertEquals(body.includes("user-1"), false, "a 401 must not carry the data");
  assertEquals(body.includes("downloads"), false);
});

Deno.test("stats are never cached (audio-feed-ndc)", async () => {
  // The response names subscribers and their download counts; a shared cache
  // holding it is the same class of mistake as caching the admin page itself.
  const { fetch } = app();
  const res = await fetch(statsRequest());
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
});

// -- the shape ------------------------------------------------------------

Deno.test("an empty deployment reports zeroes, not absences (audio-feed-ndc)", async () => {
  // The dashboard renders this on a server that has never run anything. Every
  // field has to exist so the UI has no null-shaped special cases.
  const { fetch } = app();
  const body = await (await fetch(statsRequest())).json();

  assertEquals(body.ok, true);
  assertEquals(body.downloads, { total: 0, perUser: [] });
  assertEquals(body.runs, []);
  assertEquals(body.feedProcessing, {
    lastPolledAt: null,
    lastDurationMs: null,
    averageDurationMs: null,
    sampleSize: 0,
  });
});

Deno.test("downloads are resolved to an email, and an unknown id is not invented (audio-feed-ndc)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser({ id: "user-1", email: "paul@example.com" }));
  await stores.metadata.recordDownload("user-1");
  await stores.metadata.recordDownload("user-1");
  // A download attributed to a user who has since been deleted.
  await stores.metadata.recordDownload("ghost");

  const body = await (await fetch(statsRequest())).json();
  assertEquals(body.downloads.total, 3);
  assertEquals(body.downloads.perUser, [
    { userId: "user-1", count: 2, email: "paul@example.com" },
    { userId: "ghost", count: 1, email: null },
  ]);
});

Deno.test("feed processing time is derived from the poll runs, not a second timer (audio-feed-ndc)", async () => {
  // One source of truth: the summary figures and the history below them come
  // from the same records, so the dashboard cannot disagree with itself.
  const { fetch, stores } = app();
  await stores.metadata.recordRun(
    run({ id: "p1", startedAt: "2026-09-25T10:00:00.000Z", durationMs: 100 }),
  );
  await stores.metadata.recordRun(
    run({ id: "p2", startedAt: "2026-09-25T11:00:00.000Z", durationMs: 300 }),
  );
  // A synthesis run must NOT move the feed-poll average.
  await stores.metadata.recordRun(
    run({ id: "s1", kind: "synthesis", startedAt: "2026-09-25T12:00:00.000Z", durationMs: 9999 }),
  );

  const body = await (await fetch(statsRequest())).json();
  assertEquals(body.feedProcessing.lastPolledAt, "2026-09-25T11:00:00.000Z");
  assertEquals(body.feedProcessing.lastDurationMs, 300);
  assertEquals(body.feedProcessing.averageDurationMs, 200, "(100 + 300) / 2, synthesis excluded");
  assertEquals(body.feedProcessing.sampleSize, 2);

  // The history itself still carries every kind.
  assertEquals(body.runs.map((r: RunRecord) => r.id), ["s1", "p2", "p1"]);
});

Deno.test("a failed run reaches the dashboard with its error (audio-feed-ndc)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.recordRun(run({ id: "boom", error: "feed fetch timed out" }));

  const body = await (await fetch(statsRequest())).json();
  assertEquals(body.runs.length, 1);
  assertEquals(body.runs[0].error, "feed fetch timed out");
});

Deno.test("manual and cron runs are distinguishable (audio-feed-ndc)", async () => {
  // The dashboard shows "started by", so the trigger has to survive the round
  // trip. Without it an operator cannot tell a scheduled poll from one they
  // just clicked, which is the first question they ask.
  const { fetch, stores } = app();
  await stores.metadata.recordRun(
    run({ id: "c", trigger: "cron", startedAt: "2026-09-25T10:00:00.000Z" }),
  );
  await stores.metadata.recordRun(
    run({ id: "m", trigger: "manual", startedAt: "2026-09-25T11:00:00.000Z" }),
  );

  const body = await (await fetch(statsRequest())).json();
  assertEquals(body.runs.map((r: RunRecord) => [r.id, r.trigger]), [["m", "manual"], [
    "c",
    "cron",
  ]]);
});

// -- one job must not starve another (audio-feed-ct1) ---------------------

/**
 * Production cadence from src/cron.ts: the feed poll every 15 minutes, the
 * synthesis cron every 2, and the synthesis cron records a run on every tick,
 * idle or not. At 34 rows an hour a single 50-row history spans about 88
 * minutes, which is the whole of audio-feed-ct1.
 */
async function seedCadence(stores: Stores, minutes: number, pollUntilMinute = minutes) {
  const t0 = Date.parse("2026-09-25T00:00:00.000Z");
  const iso = (m: number, ms = 0) => new Date(t0 + m * 60_000 + ms).toISOString();
  for (let m = 0; m < minutes; m++) {
    if (m % 15 === 0 && m < pollUntilMinute) {
      await stores.metadata.recordRun(
        run({ id: `p${m}`, startedAt: iso(m), durationMs: 1000 + 2 * m }),
      );
    }
    if (m % 2 === 0) {
      // +250 ms, so a poll and a tick in the same minute never tie.
      await stores.metadata.recordRun(
        run({ id: `s${m}`, kind: "synthesis", startedAt: iso(m, 250), durationMs: 30 }),
      );
    }
  }
}

Deno.test("poll figures survive a busy synthesis cron (audio-feed-ct1)", async () => {
  // Three healthy hours: 12 polls and 90 idle synthesis ticks. Under one shared
  // 50-row cap only the newest 5 polls survived, so the card labelled "Mean of
  // the last 10 polls" averaged 5.
  const { fetch, stores } = app();
  await seedCadence(stores, 180);

  const body = await (await fetch(statsRequest())).json();
  assertEquals(body.feedProcessing.sampleSize, 10, "the mean covers the ten polls it claims");
  // Polls at minutes 30..165, duration 1000 + 2m: mean 1195.
  assertEquals(body.feedProcessing.averageDurationMs, 1195);
  assertEquals(body.feedProcessing.lastPolledAt, "2026-09-25T02:45:00.000Z");
  assertEquals(body.runs.filter((r: RunRecord) => r.kind === "feed-poll").length, 12);
  assertEquals(body.runs.filter((r: RunRecord) => r.kind === "synthesis").length, 50);
});

Deno.test("a stopped poller still shows its last run, not never (audio-feed-ct1)", async () => {
  // The outage this card exists for: the poll cron's last run was at 00:45 and
  // synthesis kept ticking to 02:58. Under one shared cap that poll was evicted
  // about 100 minutes later, and the card said the poller had NEVER run.
  const { fetch, stores } = app();
  await seedCadence(stores, 180, 60);

  const body = await (await fetch(statsRequest())).json();
  assertEquals(body.feedProcessing.lastPolledAt, "2026-09-25T00:45:00.000Z");
  assertEquals(body.feedProcessing.sampleSize, 4);
});

Deno.test("the runs table shows the newest runs of EACH job (audio-feed-ct1)", async () => {
  // Synthesis ticks every 2 minutes and the poll every 15, so the newest 20
  // runs overall were 18 idle ticks and 2 polls. The table takes the newest 10
  // of each job instead.
  const { fetch, stores } = app();
  await seedCadence(stores, 180);
  const stats = await (await fetch(statsRequest())).json();

  const harness = await runAdminScript({
    signedIn: true,
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/stats") return stats;
      if (method === "GET" && path === "/api/admin/users") return { users: [] };
      return { ok: true };
    },
  });
  await harness.flush();

  const jobs = harness.byId("runsBody").children.map((tr) => tr.children[1]?.textContent);
  assertEquals(jobs.filter((j) => j === "Feed poll").length, 10);
  assertEquals(jobs.filter((j) => j === "Synthesis").length, 10);
  assertEquals(harness.byId("statPollNote").textContent, "Mean of the last 10 polls.");
});

// -- sign-in auth and operational lifecycle (audio-feed-0jp) ----------------

Deno.test("a signed-in admin console auto-loads users and operations on fresh load (audio-feed-0jp)", async () => {
  // Fresh load on passkey session auto-loads without requiring token entry.
  const harness = await runAdminScript({
    signedIn: true,
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/users") return { users: [] };
      if (method === "GET" && path === "/api/admin/stats") {
        return {
          downloads: { total: 0, perUser: [] },
          feedProcessing: { lastPolledAt: null, averageDurationMs: null, sampleSize: 0 },
          runs: [],
        };
      }
      return { ok: true };
    },
  });

  assert(
    harness.requests.some((r) => r.path === "/api/admin/users"),
    "subscribers must auto-load on signed-in session",
  );
  assert(
    harness.requests.some((r) => r.path === "/api/admin/stats"),
    "stats must auto-load on signed-in session",
  );
  assertEquals(
    harness.requests.every((r) => r.adminToken === null),
    true,
    "requests use session cookie authentication, no token header",
  );
});

Deno.test("a signed-out console keeps operations and user actions disabled (audio-feed-0jp)", async () => {
  const harness = await runAdminScript({
    signedIn: false,
    respond: () => ({ users: [] }),
  });

  assertEquals(harness.byId("loadUsers").disabled, true);
  assertEquals(harness.byId("refreshStats").disabled, true);
  assertEquals(harness.byId("pollNowBtn").disabled, true);
  assertEquals(harness.byId("synthesizeNowBtn").disabled, true);
});

Deno.test("a signed-out console sends no API requests on load (audio-feed-0jp)", async () => {
  const harness = await runAdminScript({
    signedIn: false,
    respond: () => ({ users: [] }),
  });

  assertEquals(harness.requests.length, 0, "signed-out console must not issue background requests");
});

Deno.test("the console UI does not read or write token storage keys (audio-feed-0jp)", async () => {
  const harness = await runAdminScript({
    signedIn: true,
    respond: () => ({ users: [] }),
  });

  assertEquals(harness.localStore(TOKEN_KEY), null, "no token in local storage");
  assertEquals(harness.sessionStore(TOKEN_KEY), null, "no token in session storage");
});

Deno.test("refreshing stats on a signed-in console fetches updated operational data (audio-feed-0jp)", async () => {
  let statsCalls = 0;
  const harness = await runAdminScript({
    signedIn: true,
    respond: (_method, path) => {
      if (path === "/api/admin/stats") {
        statsCalls++;
        return {
          downloads: { total: statsCalls, perUser: [] },
          feedProcessing: { lastPolledAt: null, averageDurationMs: null, sampleSize: 0 },
          runs: [],
        };
      }
      return { users: [] };
    },
  });

  assertEquals(statsCalls, 1, "initial load fetched stats once");
  harness.byId("refreshStats").click();
  await harness.flush();
  assertEquals(statsCalls, 2, "refresh button triggered second stats fetch");
  assertEquals(harness.byId("statDownloads").textContent, "2");
});

Deno.test("manual poll and synthesize triggers execute on the signed-in session (audio-feed-0jp)", async () => {
  const harness = await runAdminScript({
    signedIn: true,
    respond: (_method, path) => {
      if (path === "/api/admin/poll-now") return { polled: 2, queued: 1, failed: 0 };
      if (path === "/api/admin/synthesize-now") return { ready: 1, failed: 0, deferred: 0 };
      return { users: [] };
    },
  });

  harness.byId("pollNowBtn").click();
  await harness.flush();
  assert(harness.requests.some((r) => r.path === "/api/admin/poll-now"));

  harness.byId("synthesizeNowBtn").click();
  await harness.flush();
  assert(harness.requests.some((r) => r.path === "/api/admin/synthesize-now"));
});

Deno.test("load subscribers button re-queries users list on the signed-in session (audio-feed-0jp)", async () => {
  let userFetches = 0;
  const harness = await runAdminScript({
    signedIn: true,
    respond: (_method, path) => {
      if (path === "/api/admin/users") {
        userFetches++;
        return { users: [{ id: "u1", email: "a@example.com", status: "approved" }] };
      }
      return { ok: true };
    },
  });

  assertEquals(userFetches, 1, "initial auto-load fetched users once");
  harness.byId("loadUsers").click();
  await harness.flush();
  assertEquals(userFetches, 2, "manual load clicked fetched users again");
  assertEquals(harness.byId("usersBody").children.length, 1);
});
