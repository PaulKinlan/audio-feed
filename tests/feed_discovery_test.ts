/**
 * Feed autodiscovery (audio-feed-6hw).
 *
 * Three layers, because the security claim needs all three:
 *   1. `discoverFeedLinks` — the shapes, and the http(s)-only filter, pure.
 *   2. `discoverFeeds` — the fetch: the caps and refusals article/feed fetching
 *      already enforces (2 MiB, 5 redirects, 15 s, content-type), against a
 *      stubbed transport so the assertions are about THIS code, not the network.
 *   3. `GET /api/account/discover-feed` — the wall (401/403) and the response
 *      contract: a page can only ever read back http(s) feed URLs.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import {
  type DiscoveredFeed,
  discoverFeedLinks,
  discoverFeeds,
  IngestError,
} from "../src/ingest/url.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const PAGE = "https://example.com/blog/post";
const htmlResponse = (body: string, contentType = "text/html; charset=utf-8") =>
  new Response(body, { headers: { "content-type": contentType } });

// -- 1. the shapes, pure ------------------------------------------------------

Deno.test("discoverFeedLinks: finds the declared shapes and resolves relative hrefs (audio-feed-6hw)", () => {
  const found = discoverFeedLinks(
    `<html><head><title>My Blog</title>
       <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS">
       <link rel="alternate stylesheet" type="application/atom+xml" href="//cdn.example.com/atom.xml">
       <link rel="alternate" type="application/feed+json" href="https://example.com/feed.json">
       <link rel="alternate" type="application/xml" href="/rss">
       <a href="/news.rss">RSS</a>
     </head><body>hi</body></html>`,
    PAGE,
  );

  assertEquals(found.url, PAGE);
  assertEquals(found.title, "My Blog");
  assertEquals(found.feeds.map((f) => f.url), [
    "https://example.com/feed.xml",
    "https://cdn.example.com/atom.xml",
    "https://example.com/feed.json",
    "https://example.com/rss",
    "https://example.com/news.rss",
  ]);
  assertEquals(found.feeds[0]!.title, "RSS");
  assertEquals(found.feeds[0]!.type, "application/rss+xml");
  // An anchor with no declared type still gets a usable one from its name.
  assertEquals(found.feeds[4]!.type, "application/rss+xml");
});

Deno.test("discoverFeedLinks: declared links outrank anchors, duplicates collapse, list is capped (audio-feed-6hw)", () => {
  const anchors = Array.from(
    { length: 10 },
    (_, i) => `<a href="/feed-${i}.xml">feed ${i}</a>`,
  ).join("");
  const found = discoverFeedLinks(
    `<html><head><link rel="alternate" type="text/xml" href="/declared.xml"></head>
     <body><a href="/early.xml">early anchor</a>${anchors}</body></html>`,
    PAGE,
  );

  // The declared feed is first even though an anchor appears earlier in the DOM.
  assertEquals(found.feeds[0]!.url, "https://example.com/declared.xml");
  assertEquals(found.feeds.length, 8, "capped, not a crawler");
  assertEquals(new Set(found.feeds.map((f) => f.url)).size, found.feeds.length);

  const dupes = discoverFeedLinks(
    `<link rel="alternate" type="application/rss+xml" href="/feed.xml">
     <link rel="alternate" type="application/atom+xml" href="/feed.xml">`,
    PAGE,
  );
  assertEquals(dupes.feeds.length, 1);
});

Deno.test("discoverFeedLinks: javascript:, data:, credentialed, ported and private candidates are dropped (audio-feed-6hw)", () => {
  const found = discoverFeedLinks(
    `<html><head>
       <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
       <link rel="alternate" type="application/rss+xml" href="data:text/xml,<rss/>">
       <link rel="alternate" type="application/rss+xml" href="https://user:pass@example.com/f.xml">
       <link rel="alternate" type="application/rss+xml" href="http://example.com:8080/f.xml">
       <link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/f.xml">
       <link rel="alternate" type="application/rss+xml" href="http://10.0.0.5/f.xml">
       <link rel="alternate" type="application/rss+xml" href="http://localhost/f.xml">
       <link rel="alternate" type="application/rss+xml" href="/ok.xml">
     </head></html>`,
    PAGE,
  );

  assertEquals(found.feeds.map((f) => f.url), ["https://example.com/ok.xml"]);
});

// -- 2. the fetch: caps and refusals -----------------------------------------

Deno.test("discoverFeeds: parses an HTML page through the bounded read (audio-feed-6hw)", async () => {
  let asked = "";
  const found = await discoverFeeds(PAGE, {
    transport: (url) => {
      asked = url.href;
      return Promise.resolve(
        htmlResponse(
          `<html><head><link rel="alternate" type="application/rss+xml" href="/f.xml"></head></html>`,
        ),
      );
    },
  });

  assertEquals(asked, PAGE);
  assertEquals(found.feeds, [{
    url: "https://example.com/f.xml",
    title: "",
    type: "application/rss+xml",
  }]);
});

Deno.test("discoverFeeds: a URL that IS a feed answers with itself (audio-feed-6hw)", async () => {
  const feedUrl = "https://example.com/feed.xml";
  const found = await discoverFeeds(feedUrl, {
    transport: () =>
      Promise.resolve(
        htmlResponse(
          `<?xml version="1.0"?><rss version="2.0"><channel/></rss>`,
          "application/rss+xml",
        ),
      ),
  });

  assertEquals(found.feeds, [{
    url: feedUrl,
    title: "",
    type: "application/rss+xml",
  }]);
});

Deno.test("discoverFeeds: follows a redirect and refuses the chain past five hops (audio-feed-6hw)", async () => {
  let hops = 0;
  const redirected = await discoverFeeds(PAGE, {
    transport: () => {
      hops++;
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: `/hop-${hops}` } }),
      );
    },
  }).catch((error: unknown) => error);

  assert(redirected instanceof IngestError);
  assertEquals((redirected as IngestError).status, 422);
  assertStringIncludes((redirected as IngestError).message, "redirect");
  assertEquals(hops, 6, "initial request plus five follows");

  let first = true;
  const landed = await discoverFeeds(PAGE, {
    transport: () => {
      if (first) {
        first = false;
        return Promise.resolve(
          new Response(null, { status: 301, headers: { location: "https://example.com/moved" } }),
        );
      }
      return Promise.resolve(
        htmlResponse(`<link rel="alternate" type="application/rss+xml" href="/feed.xml">`),
      );
    },
  });
  assertEquals(landed.url, "https://example.com/moved");
  assertEquals(landed.feeds[0]!.url, "https://example.com/feed.xml");
});

Deno.test("discoverFeeds: a redirect to a private address is refused, not followed (audio-feed-6hw)", async () => {
  const refused = await discoverFeeds(PAGE, {
    transport: () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/f" } }),
      ),
  }).catch((error: unknown) => error);

  assert(refused instanceof IngestError);
  assertEquals((refused as IngestError).status, 400);
});

Deno.test("discoverFeeds: a private target never reaches the transport (audio-feed-6hw)", async () => {
  let called = false;
  const refused = await discoverFeeds("http://127.0.0.1/feed", {
    transport: () => {
      called = true;
      return Promise.resolve(htmlResponse(""));
    },
  }).catch((error: unknown) => error);

  assert(refused instanceof IngestError);
  assertEquals((refused as IngestError).status, 400);
  assertEquals(called, false);
});

Deno.test("discoverFeeds: non-HTML is refused and an oversized page is refused (audio-feed-6hw)", async () => {
  const pdf = await discoverFeeds(PAGE, {
    transport: () => Promise.resolve(htmlResponse("%PDF-1.4", "application/pdf")),
  }).catch((error: unknown) => error);
  assert(pdf instanceof IngestError);
  assertEquals((pdf as IngestError).status, 422);

  const big = await discoverFeeds(PAGE, {
    transport: () =>
      Promise.resolve(
        new Response("<html></html>", {
          headers: { "content-type": "text/html", "content-length": String(3 * 1024 * 1024) },
        }),
      ),
  }).catch((error: unknown) => error);
  assert(big instanceof IngestError);
  assertEquals((big as IngestError).status, 413);
});

Deno.test("discoverFeeds: a page whose every candidate is refused answers with an empty list (audio-feed-6hw)", async () => {
  const found = await discoverFeeds(PAGE, {
    transport: () =>
      Promise.resolve(
        htmlResponse(
          `<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
           <link rel="alternate" type="application/rss+xml" href="http://10.0.0.1/f.xml">`,
        ),
      ),
  });

  assertEquals(found.feeds, []);
});

Deno.test("discoverFeeds: a stalled read times out as 504 (audio-feed-6hw)", async () => {
  const stalled = await discoverFeeds(PAGE, {
    timeoutMs: 1,
    transport: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return htmlResponse("<html></html>");
    },
  }).catch((error: unknown) => error);

  assert(stalled instanceof IngestError);
  assertEquals((stalled as IngestError).status, 504);
});

// -- 3. the endpoint wall and contract ---------------------------------------

const BASE = "https://audio.example.com";

async function app(
  discoverFeeds?: (url: string) => Promise<{
    url: string;
    title: string;
    feeds: DiscoveredFeed[];
  }>,
) {
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx, {
    discoverFeeds: discoverFeeds ? (url) => discoverFeeds(url) : undefined,
  });
  const { fetch } = createApp(ctx, handlers);

  const rawUser = await createUser(stores.metadata, {
    email: "discover@example.com",
    displayName: "Discover",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);
  return { fetch, session };
}

Deno.test("GET /api/account/discover-feed: needs a session (audio-feed-6hw)", async () => {
  const { fetch } = await app();

  const res = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`),
  );
  assertEquals(res.status, 401);
});

Deno.test("GET /api/account/discover-feed: a cross-site read is refused (audio-feed-6hw)", async () => {
  const { fetch, session } = await app();
  const headers = { cookie: `__Host-af_session=${session}` };

  // An attacker page's fetch carries both of these; a page cannot remove them.
  const crossSite = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, {
      headers: { ...headers, "sec-fetch-site": "cross-site", "origin": "https://evil.example" },
    }),
  );
  assertEquals(crossSite.status, 403);

  // A cross-site <img> style request carries no Origin, but the fetch metadata stays.
  const noOrigin = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, {
      headers: { ...headers, "sec-fetch-site": "cross-site" },
    }),
  );
  assertEquals(noOrigin.status, 403);

  const foreignOrigin = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, {
      headers: { ...headers, "origin": "https://evil.example" },
    }),
  );
  assertEquals(foreignOrigin.status, 403);
});

Deno.test("GET /api/account/discover-feed: same-origin and header-less clients get the feeds (audio-feed-6hw)", async () => {
  const { fetch, session } = await app(() =>
    Promise.resolve({
      url: PAGE,
      title: "My Blog",
      feeds: [{ url: "https://example.com/feed.xml", title: "RSS", type: "application/rss+xml" }],
    })
  );
  const headers = { cookie: `__Host-af_session=${session}` };

  // What the browser sends on the account page's own fetch (no Origin on a GET).
  const sameOrigin = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, {
      headers: { ...headers, "sec-fetch-site": "same-origin" },
    }),
  );
  assertEquals(sameOrigin.status, 200);
  assertEquals(await sameOrigin.json(), {
    url: PAGE,
    title: "My Blog",
    feeds: [{ url: "https://example.com/feed.xml", title: "RSS", type: "application/rss+xml" }],
  });
  assertEquals(sameOrigin.headers.get("cache-control"), "no-store");

  // curl/tests: no fetch metadata and no Origin, so no cross-site page exists.
  const bare = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, { headers }),
  );
  assertEquals(bare.status, 200);
});

Deno.test("GET /api/account/discover-feed: validates the URL before it reads anything (audio-feed-6hw)", async () => {
  let called = false;
  const { fetch, session } = await app(() => {
    called = true;
    return Promise.resolve({ url: PAGE, title: "", feeds: [] });
  });
  const headers = { cookie: `__Host-af_session=${session}` };

  const missing = await fetch(new Request(`${BASE}/api/account/discover-feed`, { headers }));
  assertEquals(missing.status, 400);

  const hostile = await fetch(
    new Request(
      `${BASE}/api/account/discover-feed?url=${encodeURIComponent("javascript:alert(1)")}`,
      {
        headers,
      },
    ),
  );
  assertEquals(hostile.status, 400);

  const privateTarget = await fetch(
    new Request(
      `${BASE}/api/account/discover-feed?url=${encodeURIComponent("http://127.0.0.1/f")}`,
      {
        headers,
      },
    ),
  );
  assertEquals(privateTarget.status, 400);
  assertEquals(called, false, "the read is refused before the seam is reached");
});

Deno.test("GET /api/account/discover-feed: a fetch refusal becomes its own status (audio-feed-6hw)", async () => {
  const { fetch, session } = await app(() =>
    Promise.reject(new IngestError(422, "Page is unavailable."))
  );
  const res = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, {
      headers: { cookie: `__Host-af_session=${session}` },
    }),
  );

  assertEquals(res.status, 422);
  assertEquals(await res.json(), { error: "Page is unavailable." });
});

Deno.test("GET /api/account/discover-feed: only http(s) feeds are ever returned (audio-feed-6hw)", async () => {
  const { fetch, session } = await app(() =>
    Promise.resolve({
      url: PAGE,
      title: "",
      feeds: [
        { url: "javascript:alert(1)", title: "hostile", type: "" },
        { url: "http://127.0.0.1/f.xml", title: "private", type: "" },
        { url: "https://example.com/ok.xml", title: "ok", type: "application/rss+xml" },
      ],
    })
  );

  const res = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, {
      headers: { cookie: `__Host-af_session=${session}` },
    }),
  );
  const body = await res.json() as { feeds: DiscoveredFeed[] };

  assertEquals(body.feeds.map((f) => f.url), ["https://example.com/ok.xml"]);
});
