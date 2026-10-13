/**
 * Local harness for the login and account system (audio-feed-8fc).
 *
 * Serves the REAL app on memory stores, seeded with an admin, a reader and an
 * invitee, a few sources and episodes, and some run history. No accounts have
 * passkeys yet: the browser proof bootstraps the first admin exactly as the bead
 * describes, by issuing a setup link with ADMIN_TOKEN.
 *
 * Feed and article fetches are stubbed, so nothing here touches the network.
 * Deliberately NOT part of the gate: it serves on localhost with a fixed admin
 * token, fine for a driven browser session and wrong for anything else.
 *
 *   deno run --allow-all --unstable-kv scripts/account-harness.ts [port]
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";

/**
 * Fixed port for reproducible evidence screenshots (audio-feed-vc4u).
 * An ephemeral port (port 0) leaks random OS-assigned port digits into
 * screenshots (bookmarklet snippet, curl examples, and feed URLs) which breaks
 * byte reproducibility and causes varying PNG compression sizes.
 *
 * The default is a fixed, documented port (8133) so tests, proofs, and harnesses
 * always render the exact same port digits.
 * For an ephemeral or custom port, pass ACCOUNT_HARNESS_PORT=0 (or 'ephemeral'/'live')
 * or set a specific port number via env or command-line argument.
 */
const HARNESS_PORT_DEFAULT = 8133;
const port = (() => {
  const env = Deno.env.get("ACCOUNT_HARNESS_PORT");
  if (env === "ephemeral" || env === "0") return 0;
  if (env && /^\d+$/.test(env)) return Number(env);
  const cliPort = Deno.args.find((a) => /^[1-9]\d*$/.test(a));
  if (cliPort) return Number(cliPort);
  return HARNESS_PORT_DEFAULT;
})();
const stores = memoryStores();
const config = { port, adminToken: "harness-admin" };
const ctx = { config, stores };
const store = stores.metadata;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Weekly</title>
<link>https://example.com</link><item><title>A post worth hearing</title>
<link>https://example.com/post</link><pubDate>Fri, 25 Sep 2026 06:00:00 +0000</pubDate>
</item></channel></rss>`;

async function person(email: string, displayName: string, isAdmin: boolean, approve: boolean) {
  const user = await createUser(store, { email, displayName, isAdmin });
  return approve ? await approveUser(store, user.id, "harness") : user;
}

const paul = await person("paul@example.com", "Paul Kinlan", true, true);
const rita = await person("rita@example.com", "Rita Reader", false, true);
await person("sam@example.com", "Sam Newcomer", false, false);

/**
 * Pinned base instant for reproducible evidence screenshots (audio-feed-vc4u).
 * The default is a fixed instant so tests, harnesses and proofs render the
 * exact same timestamps forever. This default instant was chosen to keep
 * the regulated artefact set inside the evidence size budget (150KB per file)
 * without wall-clock drift. Do not round or alter this instant without re-verifying
 * evidence size budgets and screenshot reproducibility.
 * For manual/interactive exploration, pass ACCOUNT_HARNESS_NOW=live or a specific ISO timestamp.
 */
const HARNESS_BASE_INSTANT_DEFAULT = "2026-10-12T03:30:00.000Z";
const baseInstantMs = (() => {
  const env = Deno.env.get("ACCOUNT_HARNESS_NOW");
  if (env === "live" || env === "now") return Date.now();
  if (env) {
    const parsed = Date.parse(env);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.parse(HARNESS_BASE_INSTANT_DEFAULT);
})();
const hoursAgo = (h: number) => new Date(baseInstantMs - h * 3_600_000).toISOString();
for (
  const [id, title, feedUrl, modes] of [
    ["stratechery", "Stratechery", "https://stratechery.com/feed/", ["direct"]],
    ["simonw", "Simon Willison's Weblog", "https://simonwillison.net/atom/everything/", [
      "direct",
      "deepdive",
    ]],
  ] as const
) {
  await store.putSource({
    id,
    userId: paul.id,
    title,
    feedUrl,
    modes: [...modes],
    voices: {},
    createdAt: hoursAgo(72),
    lastPolledAt: hoursAgo(0.2),
  });
}
const episodes = [
  ["The end of the beginning", "stratechery", "Stratechery", "direct", "ready", 3],
  ["Prompt injection, two years on", "simonw", "Simon Willison's Weblog", "deepdive", "ready", 6],
  ["Aggregators and the agent web", "stratechery", "Stratechery", "direct", "synthesizing", 0.5],
  ["Why local models matter", "simonw", "Simon Willison's Weblog", "direct", "pending", 0.2],
] as const;
for (const [i, [title, sourceId, sourceTitle, mode, status, h]] of episodes.entries()) {
  await store.putEpisode({
    id: `ep-${i}`,
    userId: paul.id,
    sourceId,
    sourceTitle,
    articleId: `a-${i}`,
    mode,
    status,
    title,
    createdAt: hoursAgo(h),
    // Published on older prompts, so /account offers Regenerate (audio-feed-ktn).
    ...(status === "ready"
      ? {
        audioKey: `audio/${paul.id}/${mode}/ep-${i}.wav`,
        contentType: "audio/wav",
        byteLength: 4,
        readyAt: hoursAgo(h),
        promptVersion: "old-prompts",
      }
      : {}),
  });
}
for (let m = 0; m < 6; m++) {
  await store.recordRun({
    id: `p${m}`,
    kind: "feed-poll",
    trigger: "cron",
    startedAt: hoursAgo(m * 0.25),
    durationMs: 900 + 40 * m,
    polled: 2,
    queued: m === 0 ? 1 : 0,
    failed: 0,
  });
}
await store.recordDownload(rita.id);
await store.recordDownload(paul.id);

const handlers = createHandlers(ctx, {
  feedTransport: () =>
    Promise.resolve(new Response(RSS, { headers: { "content-type": "application/rss+xml" } })),
  fetchArticle: (url) =>
    Promise.resolve({
      url,
      title: "An article sent from the account page",
      author: "Harness",
      publishedAt: "2026-09-26T06:00:00.000Z",
      lead: "Lead.",
      body: "Body text.",
    }),
});
const { fetch } = createApp(ctx, handlers);
Deno.serve(
  {
    port,
    hostname: "localhost",
    onListen: ({ port: assignedPort }) => {
      console.log(`READY port=${assignedPort} base=http://localhost:${assignedPort}`);
      console.log(`account harness: http://localhost:${assignedPort}/  admin token: harness-admin`);
    },
  },
  fetch,
);
