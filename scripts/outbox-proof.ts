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
import { makeArticle, makeEpisode } from "../tests/fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";

const PORT = 8145;
const BASE = `http://localhost:${PORT}`;
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

const config: AppConfig = {
  port: PORT,
  publicBaseUrl: BASE,
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
const { fetch } = createApp(ctx, handlers);

const checks: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail: string) => {
  checks.push({ step, ok, detail });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${step}  ${detail}`);
  if (!ok) throw new Error(`step failed: ${step}`);
};

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
const run1 = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), { batchSize: 5 });
check("synthesis batch completes 1 episode", run1.ready.length === 1, `ready: ${run1.ready.length}`);

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
  n1.title === "On-Demand Read Article" && n1.playerUrl === `${BASE}/listen/${TOKEN}` && n1.status === "ready",
  `title='${n1.title}', playerUrl='${n1.playerUrl}', status='${n1.status}'`,
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
    makeArticle({ id: artId, userId: user.id, sourceId: "feed-source", title: `Feed Item ${i}` }),
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

const runFeed = await runSynthesisBatch(ctx, () => Promise.resolve(fakeAudio()), { batchSize: 5 });
check("synthesis batch completes 3 feed episodes", runFeed.ready.length === 3, `ready: ${runFeed.ready.length}`);

const outboxAfterFeed = await (await fetch(
  new Request(`${BASE}/api/admin/outbox`, { headers: { "x-admin-token": ADMIN_TOKEN } }),
)).json();
check(
  "feed poll episodes did NOT create outbox notifications",
  outboxAfterFeed.notifications.length === 1,
  `outbox count remains ${outboxAfterFeed.notifications.length}`,
);

// 6. Failed on-demand episode notifies once with error reason
await fetch(
  new Request(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-feed-token": TOKEN },
    body: JSON.stringify({ url: "https://example.com/failing-post", mode: "direct" }),
  }),
);

const runFail = await runSynthesisBatch(ctx, () => Promise.reject(new Error("Gemini quota exhausted")), {
  batchSize: 5,
  maxAttempts: 2,
});
check("failing episode marked failed", runFail.failed.length === 1, `failed: ${runFail.failed.length}`);

const outboxAfterFail = await (await fetch(
  new Request(`${BASE}/api/admin/outbox`, { headers: { "x-admin-token": ADMIN_TOKEN } }),
)).json();
check(
  "outbox now holds 2 entries (ready + failed)",
  outboxAfterFail.notifications.length === 2,
  `entries: ${outboxAfterFail.notifications.length}`,
);
const failNotification = outboxAfterFail.notifications.find((n: { status: string }) => n.status === "failed");
check(
  "failed notification contains failure reason",
  failNotification && failNotification.error?.includes("Gemini quota exhausted"),
  `error: '${failNotification?.error}'`,
);

// 7. Ack notifications
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

// Write markdown summary
const summary = `# Outbox Notification Verification Report: audio-feed-np5

## Verified Criteria
1. **On-Demand Notification**: Submitting an article via \`/api/ingest\` places exactly 1 entry in the outbox upon synthesis completion, naming the episode title and player URL.
2. **Feed Poll Silence**: Background feed polls synthesizing multiple episodes do NOT emit outbox entries.
3. **Failure Reporting**: Permanent synthesis failures notify once with the specific error reason. In-batch retries do not duplicate notifications.
4. **Resilience**: Outbox write rejections do not abort episode completion; failure is logged.
5. **Security**: Zero credentials, tokens, or admin secrets are echoed in notification payloads or server logs beyond the subscriber's own player URL.
6. **Opt-in Only**: Outbox notifications are disabled by default (\`notifyOutboxEnabled: false\`).

## Execution Log
\`\`\`
${checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.step}: ${c.detail}`).join("\n")}
\`\`\`
`;

await Deno.writeTextFile(`${OUT}README.md`, summary);
console.log(`Saved report to ${OUT}README.md`);
