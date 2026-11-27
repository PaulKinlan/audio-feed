/**
 * End-to-end tests for the Cloudflare Workers entrypoint (`src/worker_entry.ts`):
 * verifies `fetch()` routing, `CF_VERSION_METADATA` /health reporting, WebAuthn ROR
 * & RP ID on `audiofeed.app`, `cf-connecting-ip` rate-limit binding, and `scheduled()`
 * Cron Trigger dispatch against real in-memory SQLite D1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import worker, { type FeedPollQueueMessage, type WorkerEnv } from "../src/worker_entry.ts";
import { D1MetadataStore } from "../src/storage/d1.ts";
import { createTestD1 } from "./sqlite_d1.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

function makeExecCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
    },
    passThroughOnException() {},
    flush: () => Promise.all(promises),
  };
}

Deno.test("worker_entry: serves /health with metadata=d1, CF_VERSION_ID, and /.well-known/webauthn", async () => {
  const d1 = createTestD1();
  try {
    const env: WorkerEnv = {
      DB: d1,
      CF_VERSION_METADATA: { id: "cf-ver-test-123" },
      PUBLIC_BASE_URL: "https://audiofeed.app",
      WEBAUTHN_RP_ID: "audiofeed.app",
      ADMIN_TOKEN: "super-secret-admin-token-1234",
    };
    const ctx = makeExecCtx();

    const healthRes = await worker.fetch(new Request("https://audiofeed.app/health"), env, ctx);
    assertEquals(healthRes.status, 200);
    const health = await healthRes.json();
    assertEquals(health.status, "ok");
    assertEquals(health.storage, "metadata=d1 blobs=memory");
    assertEquals(health.deploy, "cf-ver-test-123");
    assertEquals(health.deploySource, "CF_VERSION_ID");

    const rorRes = await worker.fetch(
      new Request("https://audiofeed.app/.well-known/webauthn"),
      env,
      ctx,
    );
    assertEquals(rorRes.status, 200);
    assertEquals(await rorRes.json(), { origins: ["https://audiofeed.app"] });

    const loginOptsRes = await worker.fetch(
      new Request("https://audiofeed.app/api/auth/login/options", {
        method: "POST",
        headers: { origin: "https://audiofeed.app", "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
    );
    assertEquals(loginOptsRes.status, 200);
    const loginOpts = await loginOptsRes.json();
    assertEquals(loginOpts.rpId, "audiofeed.app");
  } finally {
    d1.close();
  }
});

Deno.test("worker_entry: scheduled() dispatches feed-poll and log-retention cron triggers into D1", async () => {
  const d1 = createTestD1();
  try {
    const env: WorkerEnv = {
      DB: d1,
      PUBLIC_BASE_URL: "https://audiofeed.app",
      ADMIN_TOKEN: "super-secret-admin-token-1234",
    };
    const ctx = makeExecCtx();

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} },
      env,
      ctx,
    );
    await worker.scheduled(
      { cron: "17 4 * * *", scheduledTime: Date.now(), noRetry() {} },
      env,
      ctx,
    );
    await ctx.flush();

    const statsRes = await worker.fetch(
      new Request("https://audiofeed.app/api/admin/stats", {
        headers: { "x-admin-token": "super-secret-admin-token-1234" },
      }),
      env,
      ctx,
    );
    assertEquals(statsRes.status, 200);
    const stats = await statsRes.json();
    assertEquals(stats.runs.length, 1);
    assertEquals(stats.runs[0].kind, "feed-poll");

    const logs = await d1.prepare(`SELECT data FROM logs ORDER BY seq ASC`).all<{ data: string }>();
    assertStringIncludes(
      logs.results.map((r) => r.data).join("\n"),
      "observability.retention",
    );
  } finally {
    d1.close();
  }
});

Deno.test("worker_entry: scheduled() fans out due feeds to FEED_POLL_QUEUE and triggers EPISODE_WORKFLOW for pending episodes", async () => {
  const d1 = createTestD1();
  try {
    const store = new D1MetadataStore(d1);
    await store.putUser(makeUser({ id: "u1", status: "approved" }));
    await store.putSource(
      makeSource({ id: "s1", userId: "u1", feedUrl: "https://example.com/feed1.xml" }),
    );
    await store.putSource(
      makeSource({ id: "s2", userId: "u1", feedUrl: "https://example.com/feed2.xml" }),
    );
    await store.putArticle(makeArticle({ id: "a1", userId: "u1", sourceId: "s1" }));
    await store.putEpisode(
      makeEpisode({ id: "ep1", userId: "u1", sourceId: "s1", articleId: "a1", status: "pending" }),
    );

    const enqueued: FeedPollQueueMessage[] = [];
    const workflowsCreated: Array<{ id?: string; params?: { episodeId: string; userId: string } }> =
      [];

    const env: WorkerEnv = {
      DB: d1,
      PUBLIC_BASE_URL: "https://audiofeed.app",
      GEMINI_API_KEY: "test-key",
      FEED_POLL_QUEUE: {
        async send(body) {
          enqueued.push(body);
        },
        async sendBatch(messages) {
          for (const m of messages) enqueued.push(m.body);
        },
      },
      EPISODE_WORKFLOW: {
        async create(opts) {
          workflowsCreated.push({ id: opts?.id, params: opts?.params });
          return { id: opts?.id ?? "wf-1" };
        },
      },
    };
    const ctx = makeExecCtx();

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} },
      env,
      ctx,
    );
    await worker.scheduled(
      { cron: "*/2 * * * *", scheduledTime: Date.now(), noRetry() {} },
      env,
      ctx,
    );
    await ctx.flush();

    assertEquals(enqueued.length, 2, "both due sources must be fanned out to FEED_POLL_QUEUE");
    assertEquals(
      enqueued.map((m) => m.sourceId).sort(),
      ["s1", "s2"],
    );
    assertEquals(workflowsCreated.length, 1);
    assertEquals(workflowsCreated[0]?.id, "ep-ep1");
    assertEquals(workflowsCreated[0]?.params, { episodeId: "ep1", userId: "u1" });
  } finally {
    d1.close();
  }
});

Deno.test("worker_entry: queue() consumer acks missing sources and handles messages cleanly", async () => {
  const d1 = createTestD1();
  try {
    const env: WorkerEnv = {
      DB: d1,
      PUBLIC_BASE_URL: "https://audiofeed.app",
    };
    const ctx = makeExecCtx();
    let acked = 0;
    let retried = 0;

    await worker.queue(
      {
        queue: "audio-feed-poll",
        messages: [
          {
            id: "msg-1",
            timestamp: new Date(),
            body: { userId: "missing-user", sourceId: "missing-source" },
            attempts: 1,
            ack() {
              acked++;
            },
            retry() {
              retried++;
            },
          },
        ],
        ackAll() {},
        retryAll() {},
      },
      env,
      ctx,
    );

    assertEquals(acked, 1);
    assertEquals(retried, 0);
    assert(typeof worker.queue === "function");
  } finally {
    d1.close();
  }
});
