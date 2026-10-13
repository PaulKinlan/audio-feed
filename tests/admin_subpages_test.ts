/**
 * Tests for Admin Sub-Pages & Pre-Episode Ingest Failures (audio-feed-1tj2 & audio-feed-r7sb).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { esc } from "../src/routes/html.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { cwvRecord } from "../src/observability/cwv.ts";

const BASE = "https://audio.example.com";
const ADMIN_TOKEN = "admin-secret";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: ADMIN_TOKEN };

async function setup() {
  const stores: Stores = memoryStores();
  const admin = makeUser({
    id: "admin-1",
    email: "admin@example.com",
    displayName: "Admin Alice",
    isAdmin: true,
    status: "approved",
  });
  const subscriber = makeUser({
    id: "sub-1",
    email: "subscriber@example.com",
    displayName: "Bob Subscriber",
    isAdmin: false,
    status: "approved",
  });
  const pendingUser = makeUser({
    id: "sub-pending",
    email: "pending@example.com",
    displayName: "Pending Charlie",
    isAdmin: false,
    status: "pending",
  });
  const suspendedUser = makeUser({
    id: "sub-suspended",
    email: "suspended@example.com",
    displayName: "Suspended Dave",
    isAdmin: false,
    status: "suspended",
  });

  await stores.metadata.putUser(admin);
  await stores.metadata.putUser(subscriber);
  await stores.metadata.putUser(pendingUser);
  await stores.metadata.putUser(suspendedUser);

  const source = makeSource({
    id: "tech-blog",
    userId: "sub-1",
    title: "Tech Blog",
    feedUrl: "https://example.com/feed.xml",
  });
  await stores.metadata.putSource(source);

  const ep = makeEpisode({
    id: "ep-1",
    userId: "sub-1",
    sourceId: "tech-blog",
    title: "Episode One",
    status: "ready",
    audioKey: "sub-1/ep-1.mp3",
  });
  await stores.metadata.putEpisode(ep);

  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const adminSession = await createSession(stores.metadata, admin.id);
  const subSession = await createSession(stores.metadata, subscriber.id);

  const adminCookie = `${SESSION_COOKIE}=${adminSession}`;
  const subCookie = `${SESSION_COOKIE}=${subSession}`;

  return { stores, ctx, fetch, admin, subscriber, adminCookie, subCookie };
}

Deno.test("audio-feed-1tj2: admin sub-pages enforce admin authentication (403 for non-admins)", async () => {
  const { fetch, subCookie } = await setup();
  const paths = [
    "/admin",
    "/admin/subscribers",
    "/admin/subscribers/sub-1",
    "/admin/observability",
    "/admin/observability/issues",
    "/admin/observability/telemetry",
  ];

  for (const path of paths) {
    // Visitor (signed out)
    const visitorRes = await fetch(new Request(`${BASE}${path}`));
    if (path === "/admin") {
      // /admin renders signin prompt with 200
      assertEquals(visitorRes.status, 200);
      assertStringIncludes(await visitorRes.text(), "Sign in to administer");
    } else {
      assertEquals(visitorRes.status, 403, `expected 403 for visitor on ${path}`);
    }

    // Signed-in non-admin
    const nonAdminRes = await fetch(
      new Request(`${BASE}${path}`, {
        headers: { cookie: subCookie },
      }),
    );
    assertEquals(nonAdminRes.status, 403, `expected 403 for non-admin on ${path}`);
  }
});

Deno.test("audio-feed-1tj2: admin session accesses all sub-pages and renders shared sub-nav", async () => {
  const { fetch, adminCookie } = await setup();
  const pages: { path: string; activeLabel: string }[] = [
    { path: "/admin", activeLabel: "Operations" },
    { path: "/admin/subscribers", activeLabel: "Subscribers" },
    { path: "/admin/subscribers/sub-1", activeLabel: "Subscribers" },
    { path: "/admin/observability", activeLabel: "Queue & Claims" },
    { path: "/admin/observability/issues", activeLabel: "Issues & Dead Letters" },
    { path: "/admin/observability/telemetry", activeLabel: "Telemetry & Outbox" },
  ];

  for (const { path, activeLabel } of pages) {
    const res = await fetch(
      new Request(`${BASE}${path}`, {
        headers: { cookie: adminCookie },
      }),
    );
    assertEquals(res.status, 200, `expected 200 on ${path}`);
    const text = await res.text();
    // Sub-nav should be present on every admin page
    assertStringIncludes(text, 'class="admin-subnav"');
    assertStringIncludes(text, 'href="/admin"');
    assertStringIncludes(text, 'href="/admin/subscribers"');
    assertStringIncludes(text, 'href="/admin/observability"');
    assertStringIncludes(text, 'href="/admin/observability/issues"');
    assertStringIncludes(text, 'href="/admin/observability/telemetry"');
    assertStringIncludes(text, esc(activeLabel));
  }
});

Deno.test("audio-feed-1tj2: /admin/subscribers lists subscribers with filtering", async () => {
  const { fetch, adminCookie } = await setup();

  // All subscribers
  const res = await fetch(
    new Request(`${BASE}/admin/subscribers`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(res.status, 200);
  const text = await res.text();
  assertStringIncludes(text, "Admin Alice");
  assertStringIncludes(text, "Bob Subscriber");
  assertStringIncludes(text, "Pending Charlie");
  assertStringIncludes(text, "Suspended Dave");

  // Filter by status=pending
  const pendingRes = await fetch(
    new Request(`${BASE}/admin/subscribers?status=pending`, {
      headers: { cookie: adminCookie },
    }),
  );
  const pendingText = await pendingRes.text();
  assertStringIncludes(pendingText, "Pending Charlie");
  assertEquals(pendingText.includes("Bob Subscriber"), false);

  // Search by query q=bob
  const searchRes = await fetch(
    new Request(`${BASE}/admin/subscribers?q=bob`, {
      headers: { cookie: adminCookie },
    }),
  );
  const searchText = await searchRes.text();
  assertStringIncludes(searchText, "Bob Subscriber");
  assertEquals(searchText.includes("Pending Charlie"), false);
});

Deno.test("audio-feed-1tj2: /admin/subscribers/:id renders details and handles 404 for unknown user", async () => {
  const { fetch, adminCookie } = await setup();

  // Existing user
  const res = await fetch(
    new Request(`${BASE}/admin/subscribers/sub-1`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(res.status, 200);
  const text = await res.text();
  assertStringIncludes(text, "Bob Subscriber");
  assertStringIncludes(text, "subscriber@example.com");
  assertStringIncludes(text, "/feed/");
  assertStringIncludes(text, "Tech Blog");
  assertStringIncludes(text, "Episode One");

  // Nonexistent user 404
  const notFound = await fetch(
    new Request(`${BASE}/admin/subscribers/nonexistent-user`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(notFound.status, 404);
  assertStringIncludes(await notFound.text(), "Subscriber not found");
});

Deno.test("audio-feed-1tj2 & audio-feed-r7sb: /admin/observability/issues displays logs, filters, and dead letters", async () => {
  const { fetch, stores, adminCookie } = await setup();

  // Seed structured logs: normal warn, error, and an ingest.failed dead letter
  await stores.metadata.appendLog({
    time: new Date().toISOString(),
    severity: "warn",
    type: "ingest.failed",
    message: "Article ingest failed before episode creation",
    process: "app",
    route: "/api/ingest",
    userId: "sub-1",
    correlationId: "corr-dead-letter-1",
    reason: "fetch_failed",
    context: { status: 502, mode: "direct" },
  });

  await stores.metadata.appendLog({
    time: new Date().toISOString(),
    severity: "error",
    type: "synthesis.crash",
    message: "Synthesis worker failed unexpectedly",
    process: "worker",
    correlationId: "corr-synth-error-1",
    episodeId: "ep-999",
    reason: "tts_quota",
  });

  // Query issues page
  const res = await fetch(
    new Request(`${BASE}/admin/observability/issues`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(res.status, 200);
  const text = await res.text();

  // Dead-letter queue section
  assertStringIncludes(text, "Dead-Letter Queue");
  assertStringIncludes(text, "ingest.failed");
  assertStringIncludes(text, "fetch_failed");
  assertStringIncludes(text, "corr-dead-letter-1");

  // Log events list
  assertStringIncludes(text, "synthesis.crash");
  assertStringIncludes(text, "tts_quota");
  assertStringIncludes(text, "corr-synth-error-1");
  assertStringIncludes(text, "ep-999");

  // Filter by correlationId
  const filterRes = await fetch(
    new Request(`${BASE}/admin/observability/issues?correlationId=corr-synth-error-1`, {
      headers: { cookie: adminCookie },
    }),
  );
  const filterText = await filterRes.text();
  assertStringIncludes(filterText, "corr-synth-error-1");
  assertEquals(filterText.includes("corr-dead-letter-1"), false);
});

Deno.test("audio-feed-1tj2: /admin/observability/telemetry surfaces CWV, reports, outbox, and orphan blobs", async () => {
  const { fetch, stores, adminCookie } = await setup();

  // Seed CWV report
  await stores.metadata.appendLog(cwvRecord({ metric: "lcp", value: 1800, page: "home" }));
  await stores.metadata.appendLog(cwvRecord({ metric: "cls", value: 0.35, page: "listen" }));

  // Seed CSP report
  await stores.metadata.appendLog({
    time: new Date().toISOString(),
    severity: "warn",
    type: "report.csp-violation",
    message: "CSP violation: script-src blocked eval",
    process: "app",
    route: "/api/reports/csp",
    context: { url: "https://audio.example.com/account" },
  });

  // Seed Outbox notification
  await stores.metadata.queueNotification({
    id: "notif-1",
    userId: "sub-1",
    episodeId: "ep-1",
    status: "ready",
    title: "Article Finished",
    playerUrl: "https://audio.example.com/listen/tok-1",
    createdAt: new Date().toISOString(),
  });

  // Seed Orphan blob
  await stores.metadata.recordOrphanBlob("orphan-audio-blob-123.mp3");

  const res = await fetch(
    new Request(`${BASE}/admin/observability/telemetry`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(res.status, 200);
  const text = await res.text();

  // CWV section
  assertStringIncludes(text, "Core Web Vitals");
  assertStringIncludes(text, "LCP");
  assertStringIncludes(text, "CLS");
  assertStringIncludes(text, "1800ms");

  // Reports section
  assertStringIncludes(text, "Browser &amp; Security Reports");
  assertStringIncludes(text, "csp-violation");

  // Outbox section
  assertStringIncludes(text, "Notification Outbox Queue");
  assertStringIncludes(text, "Article Finished");

  // Orphan blobs section
  assertStringIncludes(text, "Orphan Audio Blobs");
  assertStringIncludes(text, "orphan-audio-blob-123.mp3");
});

Deno.test("audio-feed-r7sb: pre-episode ingest failure records structured ingest.failed log", async () => {
  const { fetch, stores, subCookie, subscriber } = await setup();

  // 1. Post invalid URL to /api/ingest
  const badUrlRes = await fetch(
    new Request(`${BASE}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": subscriber.feedToken,
        origin: BASE,
        cookie: subCookie,
      },
      body: JSON.stringify({ url: "https://localhost/private", mode: "direct" }),
    }),
  );
  assertEquals(badUrlRes.status, 400);

  // Check structured log
  const logs = await stores.metadata.listLogs({ limit: 10 });
  const failedLog = logs.find((l) => l.type === "ingest.failed" && l.reason === "url_rejected");
  assert(failedLog, "expected ingest.failed log with reason=url_rejected");
  assertEquals(failedLog.userId, subscriber.id);
  assertEquals(failedLog.process, "app");
  assertEquals(failedLog.route, "/api/ingest");
  assertEquals(failedLog.severity, "warn");
  assert(failedLog.correlationId, "expected minted correlationId");
});

Deno.test("audio-feed-r7sb: feed poll failure records structured ingest.failed log", async () => {
  const { stores, ctx, subscriber } = await setup();
  const deadSource = makeSource({
    id: "dead-feed",
    userId: subscriber.id,
    title: "Dead Feed",
    feedUrl: "https://example.com/dead.xml",
  });
  await stores.metadata.putSource(deadSource);

  // Poll with transport throwing network error
  const failingTransport = () => Promise.reject(new Error("Network unreachable"));
  const { pollFeedSource } = await import("../src/ingest/feed.ts");
  await pollFeedSource(ctx, deadSource, { transport: failingTransport });

  const logs = await stores.metadata.listLogs({ limit: 10 });
  const failedLog = logs.find((l) => l.type === "ingest.failed" && l.reason === "feed_poll_failed");
  assert(failedLog, "expected ingest.failed log with reason=feed_poll_failed");
  assertEquals(failedLog.userId, subscriber.id);
  assertEquals(failedLog.process, "cron");
  assertEquals(failedLog.job, "feed-poll");
  assertEquals(failedLog.context?.sourceId, "dead-feed");
});

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

Deno.test("audio-feed-ciuw / audio-feed-m11b: store read failure is reported as unavailable, never as empty/zero", async () => {
  const { stores, adminCookie } = await setup();

  // 1. Broken logs store on /admin/observability/issues
  const brokenLogsStores = breakStore(stores, {
    listLogs: () => Promise.reject(new Error("simulated log KV partition")),
  });
  const brokenLogsCtx = { config, stores: brokenLogsStores };
  const { fetch: brokenLogsFetch } = createApp(brokenLogsCtx, createHandlers(brokenLogsCtx));

  const issuesRes = await brokenLogsFetch(
    new Request(`${BASE}/admin/observability/issues`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(issuesRes.status, 200);
  const issuesText = await issuesRes.text();
  assertStringIncludes(issuesText, "Unavailable — the log store could not be read");
  assertStringIncludes(issuesText, "simulated log KV partition");
  assertStringIncludes(issuesText, "This is NOT an empty state.");

  // 2. Broken outbox and logs on /admin/observability/telemetry
  const brokenTelemetryStores = breakStore(stores, {
    listLogs: () => Promise.reject(new Error("simulated log read failure")),
    listOutbox: () => Promise.reject(new Error("simulated outbox disk error")),
    listOrphanBlobs: () => Promise.reject(new Error("simulated orphan blobs lock failure")),
  });
  const brokenTelemetryCtx = { config, stores: brokenTelemetryStores };
  const { fetch: brokenTelemetryFetch } = createApp(
    brokenTelemetryCtx,
    createHandlers(brokenTelemetryCtx),
  );

  const telemetryRes = await brokenTelemetryFetch(
    new Request(`${BASE}/admin/observability/telemetry`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(telemetryRes.status, 200);
  const telemetryText = await telemetryRes.text();
  assertStringIncludes(telemetryText, "Unavailable — the log store could not be read");
  assertStringIncludes(telemetryText, "Unavailable — the outbox store could not be read");
  assertStringIncludes(telemetryText, "Unavailable — the orphan blob store could not be read");
  assertStringIncludes(telemetryText, "This is NOT an empty state.");

  // 3. Broken users store on /admin/subscribers
  const brokenUsersStores = breakStore(stores, {
    listUsers: () => Promise.reject(new Error("simulated users db timeout")),
  });
  const brokenUsersCtx = { config, stores: brokenUsersStores };
  const { fetch: brokenUsersFetch } = createApp(brokenUsersCtx, createHandlers(brokenUsersCtx));

  const subscribersRes = await brokenUsersFetch(
    new Request(`${BASE}/admin/subscribers`, {
      headers: { cookie: adminCookie },
    }),
  );
  assertEquals(subscribersRes.status, 200);
  const subscribersText = await subscribersRes.text();
  assertStringIncludes(subscribersText, "Unavailable — the subscriber store could not be read");
  assertStringIncludes(subscribersText, "simulated users db timeout");
  assertStringIncludes(subscribersText, "This is NOT an empty state.");
});
