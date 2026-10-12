/**
 * Verification proof for on-demand article notifications via outbox (audio-feed-np5).
 *
 * Walks the full end-to-end flow:
 *   1. Send an article via /api/ingest -> run one synthesis batch -> verify outbox entry.
 *   2. Run multi-episode feed poll -> run synthesis batch -> verify zero outbox entries added.
 *   3. Ingest article that fails synthesis -> verify 1 failed outbox entry with reason.
 *   4. Ack notifications via /api/admin/outbox/:id/ack -> verify outbox cleared.
 *   5. Verify no secrets or admin tokens leak into notification payloads.
 *
 *   deno run --allow-all --unstable-kv scripts/outbox-proof.ts
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { recordRun } from "../src/stats.ts";
import { makeArticle, makeEpisode } from "../tests/fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import type { RunRecord } from "../src/storage/mod.ts";
import { runProof, writeEvidenceReadme } from "./proof-helper.ts";

const requestedPort = Number(Deno.args.find((a) => /^\d+$/.test(a)) ?? 0);
const TOKEN = "subscriber-token-123";
const ADMIN_TOKEN = "admin-secret-999";
const OUT = new URL("../docs/evidence/audio-feed-np5/", import.meta.url).pathname;

await Deno.mkdir(OUT, { recursive: true });

function fakeAudio(): DecodedAudioResult {
  const raw = new Uint8Array(524);
  raw.set([0x52, 0x49, 0x46, 0x46], 0);
  raw.set([0x57, 0x41, 0x56, 0x45], 8);
  raw.set([0x64, 0x61, 0x74, 0x61], 36);
  return {
    rawBytes: raw,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    durationSeconds: 2,
    finishReason: "STOP",
    truncated: false,
    toWav: () => raw,
  };
}

interface SecretScanResult {
  clean: boolean;
  leaks: string[];
}

function scanForSecretLeaks(
  surface: {
    notifications: Array<Record<string, unknown>>;
    capturedLogs: string[];
    runHistory?: Array<Record<string, unknown> | RunRecord>;
  },
  knownSecrets: {
    adminToken: string;
    subscriberToken: string;
  },
): SecretScanResult {
  const leaks: string[] = [];

  const authHeaderPattern = /(?:authorization|bearer)\s*[:=]\s*[^\s,;]+/i;
  const adminSecretPattern = /admin[-_]?(?:secret|token)[-_]?[0-9]*/i;
  const tokenAssignmentPattern =
    /(?:api[-_]?key|secret[-_]?token|admin[-_]?key)\s*[:=]\s*[^\s,;]+/i;

  for (const n of surface.notifications) {
    for (const [key, val] of Object.entries(n)) {
      if (typeof val !== "string") continue;

      if (val.includes(knownSecrets.adminToken)) {
        leaks.push(`notification.${key} contains adminToken`);
      }
      if (adminSecretPattern.test(val)) {
        leaks.push(`notification.${key} matches adminSecretPattern: ${val}`);
      }
      if (authHeaderPattern.test(val)) {
        leaks.push(`notification.${key} matches authHeaderPattern: ${val}`);
      }
      if (tokenAssignmentPattern.test(val)) {
        leaks.push(`notification.${key} matches tokenAssignmentPattern: ${val}`);
      }

      // Whitelist subscriber token / capability URL ONLY in notification.playerUrl
      if (key !== "playerUrl" && val.includes(knownSecrets.subscriberToken)) {
        leaks.push(`notification.${key} leaks subscriberToken: ${val}`);
      }
    }
  }

  for (const logLine of surface.capturedLogs) {
    if (logLine.includes(knownSecrets.adminToken)) {
      leaks.push(`capturedLog contains adminToken: ${logLine}`);
    }
    if (authHeaderPattern.test(logLine)) {
      leaks.push(`capturedLog matches authHeaderPattern: ${logLine}`);
    }
    if (adminSecretPattern.test(logLine)) {
      leaks.push(`capturedLog matches adminSecretPattern: ${logLine}`);
    }
    if (tokenAssignmentPattern.test(logLine)) {
      leaks.push(`capturedLog matches tokenAssignmentPattern: ${logLine}`);
    }

    // ANY subscriber capability URL or token appearing in server logs is forbidden (no sanitization)
    if (logLine.includes(knownSecrets.subscriberToken)) {
      leaks.push(`capturedLog contains subscriber capability URL / token: ${logLine}`);
    }
  }

  if (surface.runHistory) {
    for (const record of surface.runHistory) {
      const serialized = JSON.stringify(record);
      if (serialized.includes(knownSecrets.adminToken)) {
        leaks.push(`runHistory entry ${record.id ?? "unknown"} contains adminToken`);
      }
      if (serialized.includes(knownSecrets.subscriberToken)) {
        leaks.push(
          `runHistory entry ${record.id ?? "unknown"} contains subscriber capability URL / token`,
        );
      }
      if (adminSecretPattern.test(serialized)) {
        leaks.push(`runHistory entry ${record.id ?? "unknown"} matches adminSecretPattern`);
      }
      if (authHeaderPattern.test(serialized)) {
        leaks.push(`runHistory entry ${record.id ?? "unknown"} matches authHeaderPattern`);
      }
      if (tokenAssignmentPattern.test(serialized)) {
        leaks.push(`runHistory entry ${record.id ?? "unknown"} matches tokenAssignmentPattern`);
      }
    }
  }

  return { clean: leaks.length === 0, leaks };
}

const config: AppConfig = {
  port: requestedPort,
  publicBaseUrl: requestedPort ? `http://localhost:${requestedPort}` : "http://localhost",
  adminToken: ADMIN_TOKEN,
  notifyOutboxEnabled: true,
};
const stores: Stores = memoryStores();
const ctx = { config, stores };

const handlers = createHandlers(ctx, {
  fetchArticle: (url) =>
    Promise.resolve({
      url,
      title: "On-Demand Read Article",
      author: "Test Author",
      publishedAt: new Date().toISOString(),
      lead: "A lead paragraph.",
      body: "Full article body for on-demand testing.",
    }),
});
const app = createApp(ctx, handlers);
const server = Deno.serve(
  {
    port: requestedPort,
    hostname: "localhost",
    onListen: () => {},
  },
  (req) => app.fetch(req),
);
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;
const fetch = (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init));

await runProof("audio-feed-np5 outbox proof", async (checker) => {
  const checks: { step: string; ok: boolean; detail: string }[] = [];
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;

  const check = (step: string, ok: boolean, detail: string) => {
    checks.push({ step, ok, detail });
    checker.check(step, ok, detail);
  };

  checker.check = (name: string, pass: boolean, detail?: string) => {
    const status = pass ? "PASS" : "FAIL";
    const line = detail !== undefined ? `${status}  ${name}  ${detail}` : `${status}  ${name}`;
    origConsoleLog(line);
    if (!pass) {
      checker.failures.push({ name, detail });
    }
    return pass;
  };

  const capturedServerLogs: string[] = [];
  console.log = (...args: unknown[]) => {
    capturedServerLogs.push(
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
    );
    origConsoleLog(...args);
  };
  console.error = (...args: unknown[]) => {
    capturedServerLogs.push(
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
    );
    origConsoleError(...args);
  };
  console.warn = (...args: unknown[]) => {
    capturedServerLogs.push(
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
    );
    origConsoleWarn(...args);
  };

  try {
    // 0. Opt-in default: when notifyOutboxEnabled is unset (default false), no outbox notification is queued
    const defaultStores = memoryStores();
    const defaultCtx = {
      config: {
        port: 0,
        publicBaseUrl: "http://localhost",
        adminToken: ADMIN_TOKEN,
        // notifyOutboxEnabled is left unset (undefined -> defaults to false)
      },
      stores: defaultStores,
    };
    const defaultUserRaw = await createUser(defaultStores.metadata, {
      email: "default-optin@example.com",
      displayName: "Default OptIn",
    });
    const defaultUser = await approveUser(defaultStores.metadata, defaultUserRaw.id, "admin");
    await defaultStores.metadata.putUser({ ...defaultUser, feedToken: "default-feed-tok" });

    const defaultHandlers = createHandlers(defaultCtx, {
      fetchArticle: (url) =>
        Promise.resolve({
          url,
          title: "Default Config Article",
          author: "Test Author",
          publishedAt: new Date().toISOString(),
          lead: "Default lead",
          body: "Default body",
        }),
    });
    const defaultApp = createApp(defaultCtx, defaultHandlers);
    const defaultIngestRes = await defaultApp.fetch(
      new Request("http://localhost/api/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-feed-token": "default-feed-tok",
        },
        body: JSON.stringify({
          url: "https://example.com/default-post",
          mode: "direct",
        }),
      }),
    );
    check(
      "POST /api/ingest returns 202 under default config",
      defaultIngestRes.status === 202,
      `status: ${defaultIngestRes.status}`,
    );

    const defaultRun = await recordRun(
      defaultCtx,
      "synthesis",
      "manual",
      () =>
        runSynthesisBatch(
          defaultCtx,
          () => Promise.resolve(fakeAudio()),
          { batchSize: 1 },
        ),
      (r) => ({
        ready: r.ready.length,
        failed: r.failed.length,
        deferred: r.deferred.length,
      }),
    );
    const defaultOutbox = await defaultStores.metadata.listOutbox();
    check(
      "default config without notifyOutboxEnabled emits zero outbox notifications",
      defaultRun.ready.length === 1 && defaultOutbox.length === 0,
      `ready: ${defaultRun.ready.length}, outbox entries: ${defaultOutbox.length}`,
    );

    // 1. Seed approved subscriber
    const rawUser = await createUser(stores.metadata, {
      email: "subscriber@example.com",
      displayName: "Subscriber",
    });
    const user = await approveUser(stores.metadata, rawUser.id, "admin");
    await stores.metadata.putUser({ ...user, feedToken: TOKEN });

    // 2. Send an article via /api/ingest
    const ingestRes = await fetch(
      new Request(`${BASE}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-feed-token": TOKEN,
        },
        body: JSON.stringify({
          url: "https://example.com/on-demand-post",
          mode: "direct",
        }),
      }),
    );
    check("POST /api/ingest returns 202", ingestRes.status === 202, `status: ${ingestRes.status}`);

    // 3. Run worker batch
    const run1 = await recordRun(
      ctx,
      "synthesis",
      "manual",
      () => runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), { batchSize: 5 }),
      (r) => ({
        ready: r.ready.length,
        failed: r.failed.length,
        deferred: r.deferred.length,
      }),
    );
    check(
      "synthesis batch completes 1 episode",
      run1.ready.length === 1,
      `ready: ${run1.ready.length}`,
    );

    // 4. Check outbox
    const outboxRes = await fetch(
      new Request(`${BASE}/api/admin/outbox`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
      }),
    );
    const outboxData = await outboxRes.json();
    check(
      "outbox holds 1 notification for on-demand article",
      outboxData.notifications.length === 1,
      `entries: ${outboxData.notifications.length}`,
    );

    const n1 = outboxData.notifications[0];
    check(
      "notification names episode title and player URL",
      n1?.title === "On-Demand Read Article" && n1?.playerUrl === `${BASE}/listen/${TOKEN}` &&
        n1?.status === "ready",
      `title='${n1?.title}', playerUrl='http://localhost:<ephemeral>/listen/${TOKEN}', status='${n1?.status}'`,
    );

    // 5. Feed poll: seed 3 feed episodes from an RSS source
    await stores.metadata.putSource({
      id: "feed-source",
      userId: user.id,
      title: "Daily News Feed",
      feedUrl: "https://example.com/feed.xml",
      modes: ["direct"],
      voices: {},
      createdAt: new Date().toISOString(),
    });
    for (let i = 1; i <= 3; i++) {
      const artId = `feed-art-${i}`;
      await stores.metadata.putArticle(
        makeArticle({
          id: artId,
          userId: user.id,
          sourceId: "feed-source",
          title: `Feed Item ${i}`,
        }),
      );
      await stores.metadata.putEpisode(
        makeEpisode({
          id: `feed-ep-${i}`,
          userId: user.id,
          sourceId: "feed-source",
          articleId: artId,
          title: `Feed Item ${i}`,
          status: "pending",
        }),
      );
    }

    const runFeed = await recordRun(
      ctx,
      "synthesis",
      "manual",
      () => runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), { batchSize: 5 }),
      (r) => ({
        ready: r.ready.length,
        failed: r.failed.length,
        deferred: r.deferred.length,
      }),
    );
    check(
      "synthesis batch completes 3 feed episodes",
      runFeed.ready.length === 3,
      `ready: ${runFeed.ready.length}`,
    );

    const outboxAfterFeed = await (await fetch(
      new Request(`${BASE}/api/admin/outbox`, { headers: { "x-admin-token": ADMIN_TOKEN } }),
    )).json();
    check(
      "feed poll episodes did NOT create outbox notifications",
      outboxAfterFeed.notifications.length === 1,
      `outbox count remains ${outboxAfterFeed.notifications.length}`,
    );

    // 6. Failed on-demand episode notifies once with error reason, and in-batch retry is observed
    await fetch(
      new Request(`${BASE}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-feed-token": TOKEN },
        body: JSON.stringify({ url: "https://example.com/failing-post", mode: "direct" }),
      }),
    );

    let failAttempts = 0;
    const runFail = await recordRun(
      ctx,
      "synthesis",
      "manual",
      () =>
        runSynthesisBatch(
          ctx,
          () => {
            failAttempts++;
            return Promise.reject(new Error("Gemini quota exhausted"));
          },
          {
            batchSize: 5,
            maxAttempts: 2,
            retryBaseDelayMs: 1,
          },
        ),
      (r) => ({
        ready: r.ready.length,
        failed: r.failed.length,
        deferred: r.deferred.length,
        errors: r.failed.length > 0
          ? r.failed.slice(0, 10).map((f) =>
            f.title
              ? `Episode ${f.episodeId} ("${f.title}"): ${f.error}`
              : `Episode ${f.episodeId}: ${f.error}`
          )
          : undefined,
      }),
    );
    check(
      "synthesis retries in-batch and executes 2 attempts",
      failAttempts === 2,
      `attempts: ${failAttempts}`,
    );
    check(
      "failing episode marked failed",
      runFail.failed.length === 1,
      `failed: ${runFail.failed.length}`,
    );

    const outboxAfterFail = await (await fetch(
      new Request(`${BASE}/api/admin/outbox`, { headers: { "x-admin-token": ADMIN_TOKEN } }),
    )).json();
    check(
      "outbox now holds 2 entries (ready + failed)",
      outboxAfterFail.notifications.length === 2,
      `entries: ${outboxAfterFail.notifications.length}`,
    );
    const failNotification = outboxAfterFail.notifications.find((n: { status: string }) =>
      n.status === "failed"
    );
    check(
      "failed notification contains failure reason",
      Boolean(failNotification && failNotification.error?.includes("Gemini quota exhausted")),
      `error: '${failNotification?.error}'`,
    );

    const failedEpisodeNotifications = outboxAfterFail.notifications.filter(
      (n: { episodeId: string }) => n.episodeId === runFail.failed[0]?.episodeId,
    );
    check(
      "in-batch retries do not duplicate failure notification",
      failedEpisodeNotifications.length === 1,
      `notifications for retried episode: ${failedEpisodeNotifications.length}`,
    );

    // 7. Rejected outbox write resilience & failure logging
    await fetch(
      new Request(`${BASE}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-feed-token": TOKEN },
        body: JSON.stringify({ url: "https://example.com/rejected-outbox-post", mode: "direct" }),
      }),
    );

    const origQueueNotification = stores.metadata.queueNotification.bind(stores.metadata);
    let queueRejectionCount = 0;
    stores.metadata.queueNotification = () => {
      queueRejectionCount++;
      return Promise.reject(new Error("Simulated storage write failure"));
    };

    let runRejection;
    try {
      runRejection = await recordRun(
        ctx,
        "synthesis",
        "manual",
        () => runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), { batchSize: 1 }),
        (r) => ({
          ready: r.ready.length,
          failed: r.failed.length,
          deferred: r.deferred.length,
        }),
      );
    } finally {
      stores.metadata.queueNotification = origQueueNotification;
    }

    const rejEpId = runRejection?.ready[0]?.episodeId;
    const rejStoredEp = rejEpId ? await stores.metadata.getEpisode(user.id, rejEpId) : null;
    check(
      "rejected outbox write does not abort episode completion",
      runRejection?.ready.length === 1 && rejStoredEp?.status === "ready",
      `ready: ${runRejection?.ready.length}, status: ${rejStoredEp?.status}`,
    );

    const rejectionLogged = capturedServerLogs.some((msg) =>
      msg.includes(`failed to queue notification for episode ${rejEpId}`) &&
      msg.includes("Simulated storage write failure")
    );
    check(
      "rejected outbox write failure is logged",
      rejectionLogged && queueRejectionCount === 1,
      rejectionLogged
        ? "logged failure via console.error"
        : "no failure logged for rejected outbox write",
    );

    // 8. Secret scan: verify no tokens/credentials/admin secrets leak into notification payloads or logs
    // Anti-test 1: verify that the security scanner detects injected secret-shaped strings
    const antiTestResult = scanForSecretLeaks(
      {
        notifications: [
          {
            id: "poison-1",
            title: "Article with Authorization: Bearer super-secret-token",
            playerUrl: "http://localhost/listen/clean",
            error: "admin-secret-999 leaked in error",
          },
        ],
        capturedLogs: ["server log: x-admin-token: admin-secret-999"],
        runHistory: [],
      },
      { adminToken: ADMIN_TOKEN, subscriberToken: TOKEN },
    );
    check(
      "secret scanner anti-test detects injected token, authorization header, and admin secret",
      !antiTestResult.clean && antiTestResult.leaks.length >= 3,
      `detected leaks: ${antiTestResult.leaks.length}`,
    );

    // Anti-test 2: poisoning anti-test distinguishing permitted notification playerUrl from forbidden log / run-history echo
    const cleanPlayerUrl = `${BASE}/listen/${TOKEN}`;
    const permittedAntiTest = scanForSecretLeaks(
      {
        notifications: [
          {
            id: "permitted-1",
            title: "On-Demand Read Article",
            playerUrl: cleanPlayerUrl,
            status: "ready",
          },
        ],
        capturedLogs: [],
        runHistory: [],
      },
      { adminToken: ADMIN_TOKEN, subscriberToken: TOKEN },
    );
    const poisonedLogAntiTest = scanForSecretLeaks(
      {
        notifications: [
          {
            id: "permitted-1",
            title: "On-Demand Read Article",
            playerUrl: cleanPlayerUrl,
            status: "ready",
          },
        ],
        capturedLogs: [`capability printed in server log: playerUrl=${cleanPlayerUrl}`],
        runHistory: [],
      },
      { adminToken: ADMIN_TOKEN, subscriberToken: TOKEN },
    );
    const poisonedHistoryAntiTest = scanForSecretLeaks(
      {
        notifications: [
          {
            id: "permitted-1",
            title: "On-Demand Read Article",
            playerUrl: cleanPlayerUrl,
            status: "ready",
          },
        ],
        capturedLogs: [],
        runHistory: [
          {
            id: "run-poison",
            kind: "synthesis",
            trigger: "manual",
            startedAt: new Date().toISOString(),
            durationMs: 10,
            error: `leaked subscriber URL: ${cleanPlayerUrl}`,
          },
        ],
      },
      { adminToken: ADMIN_TOKEN, subscriberToken: TOKEN },
    );
    check(
      "poisoning anti-test permits playerUrl in notification but rejects capability URL in server logs and run history",
      permittedAntiTest.clean &&
        !poisonedLogAntiTest.clean &&
        poisonedLogAntiTest.leaks.some((l) => l.startsWith("capturedLog")) &&
        !poisonedHistoryAntiTest.clean &&
        poisonedHistoryAntiTest.leaks.some((l) => l.startsWith("runHistory")),
      `permitted: clean=${permittedAntiTest.clean}; poisonedLog leaks: ${poisonedLogAntiTest.leaks.length}; poisonedHistory leaks: ${poisonedHistoryAntiTest.leaks.length}`,
    );

    // Live scan: inspect real outbox payloads, captured server logs, and persisted run history
    const allRunHistory = [
      ...await defaultStores.metadata.listRuns(),
      ...await stores.metadata.listRuns(),
    ];
    const liveScan = scanForSecretLeaks(
      {
        notifications: outboxAfterFail.notifications,
        capturedLogs: capturedServerLogs,
        runHistory: allRunHistory,
      },
      { adminToken: ADMIN_TOKEN, subscriberToken: TOKEN },
    );
    const sanitizePort = (s: string) => s.replace(new RegExp(`:${PORT}`, "g"), ":<ephemeral>");
    check(
      "no credentials, tokens, or admin secrets are echoed into server logs, run history, or notifications beyond subscriber player URL",
      liveScan.clean,
      liveScan.clean ? "0 leaks detected" : `leaks: ${sanitizePort(liveScan.leaks.join("; "))}`,
    );

    // 9. Ack notifications
    for (const n of outboxAfterFail.notifications) {
      const ackRes = await fetch(
        new Request(`${BASE}/api/admin/outbox/${n.id}/ack`, {
          method: "POST",
          headers: { "x-admin-token": ADMIN_TOKEN },
        }),
      );
      check(`ack notification ${n.id}`, ackRes.status === 200, `status: ${ackRes.status}`);
    }

    const outboxEmpty = await (await fetch(
      new Request(`${BASE}/api/admin/outbox`, { headers: { "x-admin-token": ADMIN_TOKEN } }),
    )).json();
    check("outbox is now empty after acking", outboxEmpty.notifications.length === 0, "0 entries");

    await writeEvidenceReadme({
      dir: OUT,
      title: "Outbox Notification Verification Report: audio-feed-np5",
      script: "scripts/outbox-proof.ts",
      asserts: [
        "on-demand notification places exactly one outbox entry on synthesis completion",
        "background feed polls emit none",
        "permanent synthesis failures notify once with the specific reason and in-batch retries do not duplicate",
        "a rejected outbox write does not abort episode completion and the failure is logged",
        "no credentials, tokens, or admin secrets are echoed beyond subscriber player URL",
        "outbox notification is opt-in only, default false",
      ],
      sections: [
        {
          heading: "Verified Criteria",
          body:
            `1. **On-Demand Notification**: Submitting an article via \`/api/ingest\` places exactly 1 entry in the outbox upon synthesis completion, naming the episode title and player URL.
2. **Feed Poll Silence**: Background feed polls synthesizing multiple episodes do NOT emit outbox entries.
3. **Failure Reporting & Deduplication**: Permanent synthesis failures notify once with the specific error reason. In-batch retries are verified to occur and do not duplicate notifications.
4. **Resilience**: Outbox write rejections do not abort episode completion; failure is logged.
5. **Security**: Zero credentials, tokens, or admin secrets are echoed in notification payloads, server logs, or run history beyond the subscriber's own player URL.
6. **Opt-in Only**: Outbox notifications are disabled by default (\`notifyOutboxEnabled: false\`).`,
        },
        {
          heading: "Execution Log",
          body: `\`\`\`
${checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.step}: ${c.detail}`).join("\n")}
\`\`\``,
        },
      ],
    });
    origConsoleLog(`Saved report to ${OUT}README.md`);
  } finally {
    await server.shutdown();
  }
});
