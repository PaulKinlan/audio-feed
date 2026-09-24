/**
 * Merged-tree acceptance smoke (audio-feed).
 *
 * Twelve lanes landed and each was reviewed per-branch, but three real defects on
 * this project lived in the SEAMS between lanes rather than in any one diff: the
 * shared `["user", id]` KV key with two incompatible record shapes, the feed URL
 * shape (the generator advertised paths the router never served), and the user id
 * doubling as a feed capability. A per-lane review cannot see any of those, so
 * this walks the whole product story through the composed app in one pass and
 * exits non-zero on the first broken expectation.
 *
 *   deno task smoke              # default port 8099
 *   deno task smoke -- 8123      # explicit port (the `--` is passed through)
 *
 * Deliberately cheap: memory stores, and synthesis is INJECTED rather than calling
 * Gemini, so this is a fast integration gate that costs nothing. It is not a
 * substitute for the real-API evidence each feature bead carries (the real TTS
 * path was proven separately, including transcribing the produced audio).
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";

// `deno task smoke -- 8123` passes the literal `--` through, so take the first
// numeric argument rather than trusting argv[0].
const numeric = (value: string | undefined) =>
  value && /^\d+$/.test(value) ? Number(value) : undefined;
const port = numeric(Deno.args.find((arg) => /^\d+$/.test(arg))) ??
  numeric(Deno.env.get("PORT")) ?? 8099;
const base = `http://localhost:${port}`;
const stores = memoryStores();
const config = { port, publicBaseUrl: base, adminToken: "smoke-admin" };
const ctx = { config, stores };

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(32)} ${detail}`);
};

// A new user arrives pending, exactly as signup leaves them.
await stores.metadata.putUser({
  id: "user-1",
  email: "paul@example.com",
  displayName: "Paul",
  status: "pending",
  isAdmin: false,
  createdAt: new Date().toISOString(),
  feedToken: "token-user-1",
});

const { fetch } = createApp(
  ctx,
  createHandlers(ctx, {
    // The article fetch is the only network call in the product path, so it is
    // the one thing stubbed here.
    fetchArticle: () =>
      Promise.resolve({
        url: "https://example.com/aggregation",
        title: "Why platforms win",
        author: "Ben Thompson",
        publishedAt: "2026-09-01T00:00:00.000Z",
        lead: "A short read.",
        body: "Aggregation theory explains why platforms win.",
      }),
  }),
);
Deno.serve({ port }, fetch);

/** A tiny valid RIFF/WAVE payload; the real bytes came from Gemini in b3a. */
const stubAudio = (): DecodedAudioResult => {
  const raw = new Uint8Array(44 + 480);
  raw.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  raw.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  raw.set([0x64, 0x61, 0x74, 0x61], 36); // data
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
};

const ingest = (token: string | null) =>
  fetch(
    new Request(`${base}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-feed-token": token } : {}),
      },
      body: JSON.stringify({ url: "https://example.com/aggregation", mode: "direct" }),
    }),
  );

// 1. The approval gate: a pending user cannot make the server spend money.
const pending = await ingest("token-user-1");
check("ingest while pending", pending.status === 403, `${pending.status} (must be 403)`);

// 2. The admin gate: token required, then the user is approved.
const noToken = await fetch(
  new Request(`${base}/api/admin/users/user-1/approve`, { method: "POST" }),
);
const approved = await fetch(
  new Request(`${base}/api/admin/users/user-1/approve`, {
    method: "POST",
    headers: { "x-admin-token": "smoke-admin" },
  }),
);
const approvedBody = await approved.json();
check(
  "approve without/with token",
  noToken.status === 401 && approved.status === 200 && approvedBody.status === "approved",
  `${noToken.status} then ${approved.status} ${approvedBody.status}`,
);

// 3. Ingest queues (202 = queued, not synthesised).
const queued = await ingest("token-user-1");
const job = await queued.json();
check(
  "ingest after approval",
  queued.status === 202 && job.status === "queued",
  `${queued.status} ${job.status}`,
);

// 4. The worker turns the queued job into audio.
const run = await runSynthesisBatch(ctx, () => Promise.resolve(stubAudio()));
// `superseded` is part of the pass condition, not just the message: work that
// was paid for and discarded must never be hidden behind a green tick.
check(
  "worker",
  run.ready.length === 1 && run.failed.length === 0 && run.superseded.length === 0,
  `${run.ready.length} ready, ${run.failed.length} failed, ${run.deferred.length} deferred, ` +
    `${run.skipped.length} skipped, ${run.superseded.length} superseded`,
);

// 5. The feed a subscriber already holds now carries it, with a self-link that
//    matches the route the router actually serves.
const feed = await fetch(new Request(`${base}/feed/token-user-1/master.xml`));
const xml = await feed.text();
check(
  "master feed",
  feed.status === 200 && (feed.headers.get("content-type") ?? "").includes("application/rss+xml"),
  `${feed.status} ${feed.headers.get("content-type")}`,
);
check(
  "self-link matches route",
  xml.includes(`<atom:link href="${base}/feed/token-user-1/master.xml"`),
  "the advertised URL is the served URL",
);
const enclosure = xml.match(/<enclosure url="([^"]+)" length="(\d+)" type="([^"]+)"\/>/);
check(
  "enclosure advertised",
  enclosure !== null,
  enclosure ? `length=${enclosure[2]} ${enclosure[3]}` : "MISSING",
);

if (enclosure) {
  const audioRes = await fetch(new Request(enclosure[1]!));
  const bytes = (await audioRes.bytes()).length;
  const ranged = await fetch(new Request(enclosure[1]!, { headers: { range: "bytes=0-99" } }));
  check(
    "enclosure fetch + seek",
    audioRes.status === 200 && bytes === Number(enclosure[2]) && ranged.status === 206,
    `${audioRes.status} ${bytes} bytes, seek ${ranged.status} ${
      ranged.headers.get("content-range")
    }`,
  );
}

// 6. The capability boundary: the user id must not open a feed.
const asId = await fetch(new Request(`${base}/feed/user-1/master.xml`));
check("id is not a capability", asId.status === 404, `${asId.status} (must be 404)`);

// 7. The per-source route resolves for the inbox the ingest landed in.
const perSource = await fetch(new Request(`${base}/feed/token-user-1/inbox/direct.xml`));
check("per-source feed", perSource.status === 200, `${perSource.status} (must be 200)`);

console.log(
  `\nsmoke: ${
    failures === 0 ? "PASS" : `${failures} FAILURE(S)`
  } — merged-tree acceptance on ${base}`,
);
await stores.metadata.close();
Deno.exit(failures === 0 ? 0 : 1);
