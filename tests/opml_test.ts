/**
 * Tests for OPML 2.0 import/export and bulk failed-episode triage in `/account`.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp, type AppContext } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import {
  MAX_OPML_BYTES,
  MAX_OPML_FEEDS,
  parseOpml,
  renderOpml,
  xmlEscape,
} from "../src/ingest/opml.ts";
import { MAX_BULK_FAILED_DELETE, MAX_BULK_FAILED_RETRY } from "../src/compose/account.ts";
import { OPML_IMPORT_RATE } from "../src/routes/account_api.ts";
import { bytes, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { INBOX_SOURCE_ID, type User } from "../src/types.ts";

const BASE = "https://audio.example.com";
const EVIL = "https://evil.example";

const VALID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Sample Feed</title><link>https://example.com</link>
<item><title>Post One</title><link>https://example.com/post-1</link>
<pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate></item></channel></rss>`;

function createTestHarness(opts: {
  feedTransport?: (url: URL, signal: AbortSignal) => Promise<Response>;
  triggerSynthesis?: AppContext["triggerSynthesis"];
  configOverrides?: Partial<AppConfig>;
} = {}) {
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    ...opts.configOverrides,
  };
  const fetchedFeedUrls: string[] = [];
  const ctx: AppContext = {
    config,
    stores,
    ...(opts.triggerSynthesis ? { triggerSynthesis: opts.triggerSynthesis } : {}),
  };
  const handlers = createHandlers(ctx, {
    feedTransport: opts.feedTransport ?? ((url) => {
      fetchedFeedUrls.push(url.href);
      return Promise.resolve(
        new Response(VALID_RSS, { headers: { "content-type": "application/rss+xml" } }),
      );
    }),
    fetchArticle: (url) =>
      Promise.resolve({
        url,
        title: "Article Title",
        author: "Author",
        publishedAt: "2026-09-01T06:00:00.000Z",
        lead: "Lead paragraph.",
        body: "Body paragraph with enough content to narrate cleanly.",
      }),
  });
  const { fetch } = createApp(ctx, handlers);

  const seedUser = async (overrides: Partial<User> = {}) => {
    const user = makeUser({ id: "user-1", email: "reader@example.com", ...overrides });
    await stores.metadata.putUser(user);
    return user;
  };
  const cookieFor = async (userId: string) =>
    `${SESSION_COOKIE}=${await createSession(stores.metadata, userId)}`;

  return { fetch, stores, ctx, fetchedFeedUrls, seedUser, cookieFor };
}

// ---------------------------------------------------------------------------
// 1. Unit tests: parseOpml & renderOpml
// ---------------------------------------------------------------------------

Deno.test("parseOpml: extracts nested outlines, case-insensitive attributes, and decodes XML entities", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Feeds</title></head>
  <body>
    <outline text="Tech">
      <outline type="rss" text="Tom&apos;s &amp; Jerry&apos;s &lt;Blog&gt;" title="Tom&apos;s &quot;Tech&quot; Blog" xmlUrl="https://Example.COM/feed.xml?a=1&amp;b=2#frag" htmlUrl="https://example.com/" />
      <OUTLINE XMLURL="https://blog.example.org/atom.xml" TEXT="Upper Case Feed" HTMLURL="javascript:alert(1)" />
    </outline>
    <outline text="Empty Folder" />
  </body>
</opml>`;

  const parsed = parseOpml(xml);
  assertEquals(parsed.hasOpmlStructure, true);
  assertEquals(parsed.invalid, []);
  assertEquals(parsed.duplicates, 0);
  assertEquals(parsed.truncated, 0);
  assertEquals(parsed.feeds, [
    {
      xmlUrl: "https://example.com/feed.xml?a=1&b=2",
      title: 'Tom\'s "Tech" Blog',
      text: "Tom's & Jerry's <Blog>",
      htmlUrl: "https://example.com/",
    },
    {
      xmlUrl: "https://blog.example.org/atom.xml",
      title: "Upper Case Feed",
      text: "Upper Case Feed",
    },
  ]);
});

Deno.test("parseOpml: deduplicates normalized URLs, strips non-http(s) schemes, and caps at MAX_OPML_FEEDS", () => {
  const lines: string[] = [
    `<outline text="Dup 1" xmlUrl="https://example.com/feed.xml" />`,
    `<outline text="Dup 2" xmlUrl="https://EXAMPLE.COM:443/feed.xml#top" />`,
    `<outline text="XSS" xmlUrl="javascript:alert(1)" />`,
    `<outline text="File" xmlUrl="file:///etc/passwd" />`,
    `<outline text="FTP" xmlUrl="ftp://example.com/rss.xml" />`,
    `<outline text="Data" xmlUrl="data:text/xml,%3Crss/%3E" />`,
    `<outline text="Malformed" xmlUrl="not a url" />`,
  ];
  for (let i = 1; i <= MAX_OPML_FEEDS + 15; i++) {
    lines.push(`<outline text="Feed ${i}" xmlUrl="https://feeds.example.com/${i}.xml" />`);
  }
  const xml = `<?xml version="1.0"?><opml version="2.0"><body>${lines.join("\n")}</body></opml>`;

  const parsed = parseOpml(xml);
  assertEquals(parsed.feeds.length, MAX_OPML_FEEDS);
  assertEquals(parsed.duplicates, 1);
  // 1 (dup-1) + (MAX_OPML_FEEDS + 15) = MAX_OPML_FEEDS + 16 unique valid URLs => 16 truncated
  assertEquals(parsed.truncated, 16);
  assertEquals(parsed.invalid.length, 5);
  assert(
    parsed.feeds.every((f) => f.xmlUrl.startsWith("https://") || f.xmlUrl.startsWith("http://")),
    "every extracted feed URL must be http(s)",
  );
});

Deno.test("parseOpml: resists XXE entities and deeply nested outlines without crashing", () => {
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<opml version="2.0"><body><outline text="&secret;" xmlUrl="https://example.com/feed.xml" /></body></opml>`;
  const xxeParsed = parseOpml(xxe);
  assertEquals(xxeParsed.feeds.length, 1);
  assert(!xxeParsed.feeds[0]!.title?.includes("root:"), "XXE entity must never be expanded");

  const depth = 400;
  const nested = `<opml version="2.0"><body>${"<outline text='f'>".repeat(depth)}<outline text="Deep" xmlUrl="https://example.com/deep.xml" />${"</outline>".repeat(depth)}</body></opml>`;
  const deepParsed = parseOpml(nested);
  assertEquals(deepParsed.feeds.length, 1);
  assertEquals(deepParsed.feeds[0]!.xmlUrl, "https://example.com/deep.xml");
});

Deno.test("renderOpml: XML-escapes XSS payloads, skips inbox, and round-trips through parseOpml", () => {
  const xssTitle = 'Blog & "News" <script>alert(\'xss\')</script>\u0000';
  const sources = [
    makeSource({
      id: INBOX_SOURCE_ID,
      userId: "u1",
      title: "Send to Audio",
      feedUrl: undefined,
    }),
    makeSource({
      id: "src-1",
      userId: "u1",
      title: xssTitle,
      feedUrl: "https://example.com/feed.xml?a=1&b=2",
      siteUrl: "https://example.com/?x=1&y=2",
    }),
    makeSource({
      id: "src-2",
      userId: "u1",
      title: "Second Feed",
      feedUrl: "https://second.example.org/rss",
      siteUrl: "javascript:alert(1)",
    }),
  ];

  const xml = renderOpml(sources, {
    title: 'Paul & <Friends> "Feed"',
    ownerName: "Paul <Admin>",
    ownerEmail: "paul+tag@example.com",
    dateCreated: new Date("2026-11-27T12:00:00.000Z"),
  });

  assertStringIncludes(xml, '<?xml version="1.0" encoding="UTF-8"?>');
  assertStringIncludes(xml, '<opml version="2.0">');
  assertStringIncludes(xml, "<title>Paul &amp; &lt;Friends&gt; &quot;Feed&quot;</title>");
  assertStringIncludes(xml, "<ownerName>Paul &lt;Admin&gt;</ownerName>");
  assertStringIncludes(xml, "<ownerEmail>paul+tag@example.com</ownerEmail>");
  assert(!xml.includes("<script>"), "raw <script> tag must never appear unescaped in XML");
  assert(!xml.includes("Send to Audio"), "synthetic inbox source must be omitted from OPML");
  assert(!xml.includes("javascript:"), "non-http(s) siteUrl must be omitted from OPML");
  assert(!xml.includes("\u0000"), "illegal XML control chars must be stripped");
  assertEquals(xmlEscape(`&<>"'\u0007`), "&amp;&lt;&gt;&quot;&apos;");

  const reparsed = parseOpml(xml);
  assertEquals(reparsed.feeds.length, 2);
  assertEquals(reparsed.feeds[0]!.xmlUrl, "https://example.com/feed.xml?a=1&b=2");
  assertEquals(reparsed.feeds[0]!.title, `Blog & "News" <script>alert('xss')</script>`);
  assertEquals(reparsed.feeds[0]!.htmlUrl, "https://example.com/?x=1&y=2");
  assertEquals(reparsed.feeds[1]!.xmlUrl, "https://second.example.org/rss");
  assertEquals(reparsed.feeds[1]!.htmlUrl, undefined);
});

// ---------------------------------------------------------------------------
// 2. HTTP tests: GET /api/account/sources/opml
// ---------------------------------------------------------------------------

Deno.test("GET /api/account/sources/opml: enforces session auth, sameSiteRead wall, headers, and user scoping", async () => {
  const t = createTestHarness();
  const me = await t.seedUser({ id: "user-1", displayName: "Paul & Co", email: "paul@example.com" });
  const other = await t.seedUser({ id: "user-2", email: "other@example.com" });
  await t.stores.metadata.putSource(makeSource({ id: INBOX_SOURCE_ID, userId: me.id, title: "Inbox", feedUrl: undefined }));
  await t.stores.metadata.putSource(makeSource({ id: "mine", userId: me.id, title: 'My "Blog" <1>', feedUrl: "https://mine.example.com/rss.xml" }));
  await t.stores.metadata.putSource(makeSource({ id: "theirs", userId: other.id, title: "Secret Blog", feedUrl: "https://secret.example.com/rss.xml" }));

  // Signed out -> 401
  const unauth = await t.fetch(new Request(`${BASE}/api/account/sources/opml`));
  assertEquals(unauth.status, 401);

  const cookie = await t.cookieFor(me.id);

  // Cross-site / same-site / foreign Origin -> 403
  for (
    const headers of [
      { cookie, "sec-fetch-site": "cross-site" },
      { cookie, "sec-fetch-site": "same-site" },
      { cookie, origin: EVIL },
    ]
  ) {
    const refused = await t.fetch(new Request(`${BASE}/api/account/sources/opml`, { headers }));
    assertEquals(refused.status, 403);
  }

  // Same-origin download -> 200 with exact XML headers
  const ok = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    }),
  );
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("content-type"), "application/xml; charset=utf-8");
  assertEquals(
    ok.headers.get("content-disposition"),
    'attachment; filename="audio-feed-subscriptions.opml"',
  );
  assertEquals(ok.headers.get("cache-control"), "private, no-store");

  const body = await ok.text();
  assertStringIncludes(body, "https://mine.example.com/rss.xml");
  assertStringIncludes(body, "My &quot;Blog&quot; &lt;1&gt;");
  assertStringIncludes(body, "<ownerEmail>paul@example.com</ownerEmail>");
  assert(!body.includes("secret.example.com"), "another user's feed must never be exported");
  assert(!body.includes("Inbox"), "inbox source without feedUrl must not be exported");
});

// ---------------------------------------------------------------------------
// 3. HTTP tests: POST /api/account/sources/opml
// ---------------------------------------------------------------------------

Deno.test("POST /api/account/sources/opml: enforces auth, CSRF, approval, and 512 KiB body cap", async () => {
  const t = createTestHarness();
  const approved = await t.seedUser({ id: "user-1", status: "approved" });
  const pending = await t.seedUser({ id: "user-2", email: "pending@example.com", status: "pending" });
  const cookie = await t.cookieFor(approved.id);
  const sample = `<opml version="2.0"><body><outline text="A" xmlUrl="https://example.com/a.xml" /></body></opml>`;

  // No session -> 401
  assertEquals(
    (await t.fetch(
      new Request(`${BASE}/api/account/sources/opml`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ opml: sample }),
      }),
    )).status,
    401,
  );

  // Missing or cross-origin Origin -> 403
  for (const origin of [null, EVIL]) {
    const headers: Record<string, string> = { cookie, "content-type": "application/json" };
    if (origin) headers.origin = origin;
    assertEquals(
      (await t.fetch(
        new Request(`${BASE}/api/account/sources/opml`, {
          method: "POST",
          headers,
          body: JSON.stringify({ opml: sample }),
        }),
      )).status,
      403,
    );
  }

  // Pending user -> 403
  assertEquals(
    (await t.fetch(
      new Request(`${BASE}/api/account/sources/opml`, {
        method: "POST",
        headers: {
          cookie: await t.cookieFor(pending.id),
          origin: BASE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ opml: sample }),
      }),
    )).status,
    403,
  );

  // Oversized body (> 512 KiB) -> 413
  const huge = JSON.stringify({ opml: "x".repeat(MAX_OPML_BYTES + 1024) });
  const overRes = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: huge,
    }),
  );
  assertEquals(overRes.status, 413);

  // Streamed oversized body without Content-Length -> 413
  const encoded = new TextEncoder().encode(huge);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const streamedRes = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: stream,
      // @ts-ignore duplex required by Node undici for ReadableStream request bodies
      duplex: "half",
    }),
  );
  assertEquals(streamedRes.status, 413);

  // Non-OPML content & invalid mode -> 400
  const nonOpml = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ opml: "just plain text, not opml" }),
    }),
  );
  assertEquals(nonOpml.status, 400);

  const badMode = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ opml: sample, mode: "invalid" }),
    }),
  );
  assertEquals(badMode.status, 400);
});

Deno.test("POST /api/account/sources/opml: blocks SSRF/non-http(s), skips existing, respects source cap, and screens store errors", async () => {
  const t = createTestHarness();
  const user = await t.seedUser({ id: "user-1", dailyEpisodeBudget: 3 });
  await t.stores.metadata.putSource(
    makeSource({
      id: "already",
      userId: user.id,
      title: "Already Subscribed",
      feedUrl: "https://existing.example.com/feed.xml",
    }),
  );
  const cookie = await t.cookieFor(user.id);

  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Already" xmlUrl="https://EXISTING.EXAMPLE.COM/feed.xml#frag" />
    <outline text="Loopback" xmlUrl="http://127.0.0.1/feed.xml" />
    <outline text="Localhost" xmlUrl="http://localhost/feed.xml" />
    <outline text="Metadata" xmlUrl="http://169.254.169.254/latest/meta-data" />
    <outline text="Private RFC1918" xmlUrl="http://10.0.0.1/feed.xml" />
    <outline text="IPv6 Loopback" xmlUrl="http://[::1]/feed.xml" />
    <outline text="Credentials" xmlUrl="https://user:pass@example.com/feed.xml" />
    <outline text="Odd Port" xmlUrl="https://example.com:8443/feed.xml" />
    <outline text="XSS Scheme" xmlUrl="javascript:alert(1)" />
    <outline text="File Scheme" xmlUrl="file:///etc/passwd" />
    <outline text="Good One" xmlUrl="https://one.example.com/feed.xml" />
    <outline text="Good One Dup" xmlUrl="https://one.example.com/feed.xml" />
    <outline text="Good Two" xmlUrl="https://two.example.com/feed.xml" />
    <outline text="Over Cap Three" xmlUrl="https://three.example.com/feed.xml" />
    <outline text="Over Cap Four" xmlUrl="https://four.example.com/feed.xml" />
  </body>
</opml>`;

  const res = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ opml, mode: "deepdive" }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();

  // Budget=3, 1 existing => at most 2 new sources added (one + two); three & four fail cap
  assertEquals(body.added, 2);
  assertEquals(body.skipped, 1);
  // 2 invalid schemes + 7 SSRF/port/creds + 2 over source cap = 11 failed
  assertEquals(body.failed.length, 11);
  assertEquals(body.sources.length, 2);
  assertEquals(body.sources[0].modes, ["deepdive"]);

  // Verify zero outbound transport calls were made to SSRF, existing, or over-cap URLs
  assertEquals(t.fetchedFeedUrls, [
    "https://one.example.com/feed.xml",
    "https://two.example.com/feed.xml",
  ]);

  const stored = await t.stores.metadata.listSources(user.id);
  assertEquals(stored.length, 3);
  assert(
    body.failed.some((f: { url: string; reason: string }) =>
      f.url.includes("three.example.com") && f.reason.includes("Source limit reached")
    ),
    "source cap refusal should name the source limit",
  );
});

Deno.test("POST /api/account/sources/opml: screens unexpected store failures without leaking internals", async () => {
  const t = createTestHarness();
  const user = await t.seedUser({ id: "user-1" });
  const cookie = await t.cookieFor(user.id);
  t.stores.metadata.putSource = () =>
    Promise.reject(new Error("D1 internal failure: secret-bucket-path"));

  const opml = `<opml version="2.0"><body><outline text="One" xmlUrl="https://one.example.com/rss.xml" /></body></opml>`;
  const res = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ opml }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.added, 0);
  assertEquals(body.failed.length, 1);
  assertEquals(body.failed[0].reason, "Could not subscribe to that feed.");
  assert(!JSON.stringify(body).includes("secret-bucket-path"));
});

Deno.test("POST /api/account/sources/opml: enforces per-subscriber rate limit with 429 and retry-after", async () => {
  const t = createTestHarness();
  const user = await t.seedUser({ id: "user-1" });
  const cookie = await t.cookieFor(user.id);
  const emptyOpml = `<opml version="2.0"><head><title>Empty</title></head><body /></opml>`;

  for (let i = 0; i < OPML_IMPORT_RATE.maxRequests; i++) {
    const res = await t.fetch(
      new Request(`${BASE}/api/account/sources/opml`, {
        method: "POST",
        headers: { cookie, origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ opml: emptyOpml }),
      }),
    );
    assertEquals(res.status, 200, `request ${i + 1} should be allowed`);
  }

  const throttled = await t.fetch(
    new Request(`${BASE}/api/account/sources/opml`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ opml: emptyOpml }),
    }),
  );
  assertEquals(throttled.status, 429);
  assert(Number(throttled.headers.get("retry-after")) >= 1, "429 must include retry-after");
});

// ---------------------------------------------------------------------------
// 4. HTTP tests: POST /api/account/episodes/bulk-failed
// ---------------------------------------------------------------------------

Deno.test("POST /api/account/episodes/bulk-failed: enforces auth, CSRF, approval, and input validation", async () => {
  const t = createTestHarness();
  const approved = await t.seedUser({ id: "user-1", status: "approved" });
  const pending = await t.seedUser({ id: "user-2", email: "pending@example.com", status: "pending" });
  const cookie = await t.cookieFor(approved.id);

  // Signed out -> 401
  assertEquals(
    (await t.fetch(
      new Request(`${BASE}/api/account/episodes/bulk-failed`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ action: "retry", limit: 5 }),
      }),
    )).status,
    401,
  );

  // Missing / foreign Origin -> 403
  for (const origin of [null, EVIL]) {
    const headers: Record<string, string> = { cookie, "content-type": "application/json" };
    if (origin) headers.origin = origin;
    assertEquals(
      (await t.fetch(
        new Request(`${BASE}/api/account/episodes/bulk-failed`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "delete" }),
        }),
      )).status,
      403,
    );
  }

  // Unapproved user retrying -> 403
  assertEquals(
    (await t.fetch(
      new Request(`${BASE}/api/account/episodes/bulk-failed`, {
        method: "POST",
        headers: {
          cookie: await t.cookieFor(pending.id),
          origin: BASE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "retry", limit: 5 }),
      }),
    )).status,
    403,
  );

  // Invalid action or limit -> 400
  for (const payload of [{ action: "purge" }, {}, { action: "retry", limit: 0 }, { action: "delete", limit: -3 }]) {
    assertEquals(
      (await t.fetch(
        new Request(`${BASE}/api/account/episodes/bulk-failed`, {
          method: "POST",
          headers: { cookie, origin: BASE, "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      )).status,
      400,
    );
  }
});

Deno.test("POST /api/account/episodes/bulk-failed (retry): triggers workflow with fresh:true, respects cap, and isolates users/statuses", async () => {
  const triggered: Array<{ episodeId: string; userId: string; fresh?: boolean }> = [];
  const t = createTestHarness({
    triggerSynthesis: (episodeId, userId, opts) => {
      triggered.push({ episodeId, userId, fresh: opts?.fresh });
      return Promise.resolve();
    },
  });
  const me = await t.seedUser({ id: "user-1" });
  const other = await t.seedUser({ id: "user-2", email: "other@example.com" });
  const cookie = await t.cookieFor(me.id);

  // Seed 30 failed episodes for me + 1 ready + 1 synthesizing + 1 failed for other
  for (let i = 1; i <= 30; i++) {
    await t.stores.metadata.putEpisode(makeEpisode({
      id: `ep-fail-${String(i).padStart(2, "0")}`,
      userId: me.id,
      status: "failed",
      error: "old Deno error",
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    }));
  }
  await t.stores.metadata.putEpisode(makeEpisode({ id: "ep-ready", userId: me.id, status: "ready", audioKey: "audio/user-1/direct/ep-ready.wav" }));
  await t.stores.metadata.putEpisode(makeEpisode({ id: "ep-synth", userId: me.id, status: "synthesizing" }));
  await t.stores.metadata.putEpisode(makeEpisode({ id: "ep-other-fail", userId: other.id, status: "failed", error: "other" }));

  // Ask for limit 999 -> server clamps to MAX_BULK_FAILED_RETRY (25)
  const res = await t.fetch(
    new Request(`${BASE}/api/account/episodes/bulk-failed`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", limit: 999 }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.action, "retry");
  assertEquals(body.retried, MAX_BULK_FAILED_RETRY);
  assertEquals(body.remainingFailed, 5);
  assertEquals(triggered.length, MAX_BULK_FAILED_RETRY);
  assert(triggered.every((call) => call.userId === me.id && call.fresh === true), "every retry must trigger synthesis with { fresh: true }");

  // Ready, synthesizing, and other user's failed episode are untouched
  assertEquals((await t.stores.metadata.getEpisode(me.id, "ep-ready"))?.status, "ready");
  assertEquals((await t.stores.metadata.getEpisode(me.id, "ep-synth"))?.status, "synthesizing");
  assertEquals((await t.stores.metadata.getEpisode(other.id, "ep-other-fail"))?.status, "failed");
});

Deno.test("POST /api/account/episodes/bulk-failed (delete): clears 105 failed episodes & orphan segment blobs without touching ready/pending/synthesizing", async () => {
  const t = createTestHarness();
  const me = await t.seedUser({ id: "user-1" });
  const other = await t.seedUser({ id: "user-2", email: "other@example.com" });
  const cookie = await t.cookieFor(me.id);

  // Seed 105 failed episodes (matching pre-migration Deno backlog) + segment blobs
  for (let i = 1; i <= 105; i++) {
    const id = `ep-old-fail-${String(i).padStart(3, "0")}`;
    await t.stores.metadata.putEpisode(makeEpisode({
      id,
      userId: me.id,
      status: "failed",
      error: "Deno KV migration error",
      audioKey: i === 1 ? `audio/${me.id}/direct/${id}.wav` : undefined,
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
    }));
  }

  // Attach partial audio blob + segment blob to failed episode 1
  const partialAudioKey = `audio/${me.id}/direct/ep-old-fail-001.wav`;
  const segKey = `audio-segments/${me.id}/ep-old-fail-001/abc-1.wav`;
  await t.stores.blobs.put(partialAudioKey, bytes(64), { contentType: "audio/wav" });
  await t.stores.blobs.put(segKey, bytes(64), { contentType: "audio/wav" });
  await t.stores.metadata.putEpisode(makeEpisode({
    id: "ep-old-fail-001",
    userId: me.id,
    status: "synthesizing",
    claimedBy: "w1",
    claimedAt: new Date().toISOString(),
  }));
  await t.stores.metadata.reserveSynthesisSegment(
    me.id,
    "ep-old-fail-001",
    {
      textHash: "abc",
      text: "hello",
      promptVersion: "v1",
      voice: "Kore",
      audioKey: "",
      byteLength: 0,
      owner: "w1",
      claimAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      finalized: false,
    },
    Date.now(),
    60_000,
  );
  await t.stores.metadata.finalizeSynthesisSegment(
    me.id,
    "ep-old-fail-001",
    { textHash: "abc", promptVersion: "v1", voice: "Kore" },
    { audioKey: segKey, byteLength: 64 },
    "w1",
    Date.now(),
    60_000,
  );
  // Transition back to failed with its partial audioKey intact
  await t.stores.metadata.putEpisode(makeEpisode({
    id: "ep-old-fail-001",
    userId: me.id,
    status: "failed",
    error: "failed mid-assembly",
    audioKey: partialAudioKey,
  }));

  // Seed protected episodes that MUST NEVER be deleted
  const readyBlobKey = `audio/${me.id}/direct/ep-ready-keep.wav`;
  await t.stores.blobs.put(readyBlobKey, bytes(128), { contentType: "audio/wav" });
  await t.stores.metadata.putEpisode(makeEpisode({ id: "ep-ready-keep", userId: me.id, status: "ready", audioKey: readyBlobKey }));
  await t.stores.metadata.putEpisode(makeEpisode({ id: "ep-pending-keep", userId: me.id, status: "pending" }));
  await t.stores.metadata.putEpisode(makeEpisode({ id: "ep-synth-keep", userId: me.id, status: "synthesizing" }));
  await t.stores.metadata.putEpisode(makeEpisode({ id: "ep-other-keep", userId: other.id, status: "failed", error: "theirs" }));

  const res = await t.fetch(
    new Request(`${BASE}/api/account/episodes/bulk-failed`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", limit: MAX_BULK_FAILED_DELETE }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.action, "delete");
  assertEquals(body.deleted, 105);
  assertEquals(body.remainingFailed, 0);
  assertEquals(body.deletedBlobs, 2);

  // Failed blobs and segment records are gone
  assertEquals(await t.stores.blobs.head(partialAudioKey), null);
  assertEquals(await t.stores.blobs.head(segKey), null);
  assertEquals(await t.stores.metadata.listSynthesisSegments(me.id, "ep-old-fail-001"), []);

  // Protected episodes and ready audio blob remain completely intact
  assertEquals((await t.stores.metadata.getEpisode(me.id, "ep-ready-keep"))?.status, "ready");
  assert(await t.stores.blobs.head(readyBlobKey) !== null, "ready episode blob must remain untouched");
  assertEquals((await t.stores.metadata.getEpisode(me.id, "ep-pending-keep"))?.status, "pending");
  assertEquals((await t.stores.metadata.getEpisode(me.id, "ep-synth-keep"))?.status, "synthesizing");
  assertEquals((await t.stores.metadata.getEpisode(other.id, "ep-other-keep"))?.status, "failed");
});

Deno.test("POST /api/account/episodes/bulk-failed (delete): caps deletion batch at MAX_BULK_FAILED_DELETE (200)", async () => {
  const t = createTestHarness();
  const me = await t.seedUser({ id: "user-1" });
  const cookie = await t.cookieFor(me.id);
  for (let i = 1; i <= MAX_BULK_FAILED_DELETE + 5; i++) {
    await t.stores.metadata.putEpisode(makeEpisode({
      id: `ep-cap-fail-${String(i).padStart(3, "0")}`,
      userId: me.id,
      status: "failed",
      error: "err",
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
    }));
  }

  const res = await t.fetch(
    new Request(`${BASE}/api/account/episodes/bulk-failed`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", limit: 999 }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.deleted, MAX_BULK_FAILED_DELETE);
  assertEquals(body.remainingFailed, 5);
});

Deno.test("POST /api/account/episodes/bulk-failed (delete): records orphan blob when blob delete throws", async () => {
  const t = createTestHarness();
  const me = await t.seedUser({ id: "user-1" });
  const cookie = await t.cookieFor(me.id);
  const stuckKey = `audio/${me.id}/direct/ep-blob-err.wav`;
  await t.stores.blobs.put(stuckKey, bytes(32), { contentType: "audio/wav" });
  await t.stores.metadata.putEpisode(makeEpisode({
    id: "ep-blob-err",
    userId: me.id,
    status: "failed",
    error: "err",
    audioKey: stuckKey,
  }));
  t.stores.blobs.delete = () => Promise.reject(new Error("R2 transient error"));

  const res = await t.fetch(
    new Request(`${BASE}/api/account/episodes/bulk-failed`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ action: "delete" }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.deleted, 1);
  assertEquals(body.failedBlobs, 1);
  assertEquals(await t.stores.metadata.getEpisode(me.id, "ep-blob-err"), null);
  assertEquals(await t.stores.metadata.listOrphanBlobs(10), [stuckKey]);
});

// ---------------------------------------------------------------------------
// 5. Account page UI & strict CSP / JS syntax checks
// ---------------------------------------------------------------------------

Deno.test("GET /account: renders OPML import/export and bulk failed triage controls cleanly under strict CSP", async () => {
  const t = createTestHarness();
  const me = await t.seedUser({ id: "user-1", displayName: "Paul" });
  const cookie = await t.cookieFor(me.id);

  // Seed 65 failed episodes (proving count > 50 is not truncated to 50)
  for (let i = 1; i <= 65; i++) {
    await t.stores.metadata.putEpisode(makeEpisode({
      id: `ep-fail-${String(i).padStart(2, "0")}`,
      userId: me.id,
      status: "failed",
      error: "Synthesis error",
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    }));
  }

  const res = await t.fetch(new Request(`${BASE}/account`, { headers: { cookie } }));
  assertEquals(res.status, 200);
  const html = await res.text();

  // Feeds tab OPML controls
  assertStringIncludes(html, 'id="exportOpml"');
  assertStringIncludes(html, 'href="/api/account/sources/opml"');
  assertStringIncludes(html, 'id="opmlImportForm"');
  assertStringIncludes(html, 'accept=".opml,.xml,text/xml,application/xml"');
  assertStringIncludes(html, 'id="opmlProgress"');
  assertStringIncludes(html, 'id="opmlResult"');

  // Episodes tab bulk failed controls (visible and showing true count > 50)
  assertStringIncludes(html, 'id="failedTriageBar"');
  assertStringIncludes(html, "65 failed episodes need attention.");
  assertStringIncludes(html, 'id="bulkRetryFailed"');
  assertStringIncludes(html, "Retry up to 10 failed");
  assertStringIncludes(html, 'id="bulkClearFailed"');
  assertStringIncludes(html, "Clear failed (65)");

  // Strict CSP & DOM safety invariants
  assertEquals(/\.innerHTML\s*=/.test(html), false, "no .innerHTML assignment");
  assertEquals(/\sstyle="/i.test(html), false, "no inline style attributes");
  assertEquals(/\son(?:click|change|submit|input)=/i.test(html), false, "no inline event handlers");

  // Validate inline script parses cleanly with zero SyntaxErrors
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !m[0].includes('type="speculationrules"'))
    .map((m) => m[1] ?? "");
  assert(scripts.length >= 1, "expected account inline script");
  for (const body of scripts) {
    new Function(body);
  }

  // Zero failed episodes -> triage bar stays hidden
  const tClean = createTestHarness();
  const cleanUser = await tClean.seedUser({ id: "user-clean" });
  const cleanHtml = await (await tClean.fetch(
    new Request(`${BASE}/account`, { headers: { cookie: await tClean.cookieFor(cleanUser.id) } }),
  )).text();
  assertStringIncludes(cleanHtml, '<div class="failed-triage" id="failedTriageBar" hidden>');
});
