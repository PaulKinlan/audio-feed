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

// -- token persistence ----------------------------------------------------

Deno.test("the remembered token is found on a fresh load (audio-feed-ndc)", async () => {
  // The whole point of the feature: reopening the console finds the token
  // rather than an empty prompt, and the page auto-loads without a click.
  const harness = await runAdminScript({
    persistedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/users") return { users: [] };
      return { ok: true };
    },
  });

  assertEquals(harness.byId("adminToken").value, "admin-secret");
  assertEquals(harness.byId("rememberToken").checked, true, "the box reflects where it was found");
  assert(
    harness.requests.some((r) => r.path === "/api/admin/users"),
    "a remembered token must auto-load, with no click",
  );
});

Deno.test("a session-only token still loads, and the box says so (audio-feed-ndc)", async () => {
  const harness = await runAdminScript({
    storedToken: "admin-secret",
    respond: () => ({ users: [] }),
  });

  assertEquals(harness.byId("adminToken").value, "admin-secret");
  assertEquals(
    harness.byId("rememberToken").checked,
    false,
    "a token found in sessionStorage must not claim to be remembered",
  );
});

Deno.test("checking the box puts the token in localStorage and NOWHERE else (audio-feed-ndc)", async () => {
  // Exactly one copy must exist. Two copies means unchecking the box later
  // appears to forget the token while a persistent copy outlives the choice.
  const harness = await runAdminScript({ respond: () => ({ users: [] }) });

  harness.byId("adminToken").value = "typed-secret";
  harness.byId("rememberToken").checked = true;
  harness.byId("saveToken").click();
  await harness.flush();

  assertEquals(harness.localStore(TOKEN_KEY), "typed-secret");
  assertEquals(harness.sessionStore(TOKEN_KEY), null, "the session copy must be cleared");
});

Deno.test("unchecking the box keeps the token in the tab only (audio-feed-ndc)", async () => {
  const harness = await runAdminScript({ respond: () => ({ users: [] }) });

  harness.byId("adminToken").value = "typed-secret";
  harness.byId("rememberToken").checked = false;
  harness.byId("saveToken").click();
  await harness.flush();

  assertEquals(harness.sessionStore(TOKEN_KEY), "typed-secret");
  assertEquals(harness.localStore(TOKEN_KEY), null, "nothing may survive the browser closing");
});

Deno.test("unchecking the box ERASES a previously remembered token (audio-feed-ndc)", async () => {
  // The security-relevant direction, and the one a naive implementation gets
  // wrong: on a shared machine, unchecking must actually remove the persistent
  // copy rather than merely stop writing a new one.
  const harness = await runAdminScript({
    persistedToken: "old-secret",
    respond: () => ({ users: [] }),
  });
  assertEquals(harness.localStore(TOKEN_KEY), "old-secret");

  harness.byId("adminToken").value = "old-secret";
  harness.byId("rememberToken").checked = false;
  harness.byId("saveToken").click();
  await harness.flush();

  assertEquals(harness.localStore(TOKEN_KEY), null, "the persistent copy must be gone");
  assertEquals(harness.sessionStore(TOKEN_KEY), "old-secret");
});

Deno.test("the persistent copy wins when both stores hold a token (audio-feed-ndc)", async () => {
  // Only reachable if something went wrong earlier, but the page must resolve
  // it the same way every time rather than depending on read order.
  const harness = await runAdminScript({
    persistedToken: "persistent",
    storedToken: "session",
    respond: () => ({ users: [] }),
  });

  assertEquals(harness.byId("adminToken").value, "persistent");
  assertEquals(harness.byId("rememberToken").checked, true);
});

Deno.test("saving an empty token stores nothing and asks for one (audio-feed-ndc)", async () => {
  const harness = await runAdminScript({ respond: () => ({ users: [] }) });

  harness.byId("adminToken").value = "   ";
  harness.byId("saveToken").click();
  await harness.flush();

  assertEquals(harness.localStore(TOKEN_KEY), null);
  assertEquals(harness.sessionStore(TOKEN_KEY), null);
  assertEquals(harness.requests.length, 0, "no request may go out without a token");
});
