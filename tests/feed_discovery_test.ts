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
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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

Deno.test("discoverFeeds: a cross-host redirect is refused (audio-feed-oq4pz)", async () => {
  const stubTransport = () => {
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/other" },
      }),
    );
  };

  await assertRejects(
    () => discoverFeeds("https://example.com/start", { transport: stubTransport }),
    IngestError,
    "Cross-host redirect is not allowed for feed discovery.",
  );
});

Deno.test("POST /api/account/discover-feed: needs a session (audio-feed-6hw, audio-feed-oq4pz)", async () => {
  const { fetch } = await app();

  const res = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: PAGE }),
    }),
  );
  assertEquals(res.status, 401);
});

Deno.test("GET /api/account/discover-feed: GET is refused with 405 and causes no side effect (audio-feed-oq4pz)", async () => {
  let called = false;
  const { fetch, session } = await app(() => {
    called = true;
    return Promise.resolve({ url: PAGE, title: "", feeds: [] });
  });

  const res = await fetch(
    new Request(`${BASE}/api/account/discover-feed?url=${encodeURIComponent(PAGE)}`, {
      headers: { cookie: `__Host-af_session=${session}` },
    }),
  );
  assertEquals(res.status, 405);
  assertEquals(called, false, "GET must not trigger outbound fetch");
});

Deno.test("POST /api/account/discover-feed: a cross-origin request is refused (audio-feed-6hw, audio-feed-oq4pz)", async () => {
  const { fetch, session } = await app();
  const headers = {
    cookie: `__Host-af_session=${session}`,
    "content-type": "application/json",
  };

  const crossSite = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers: { ...headers, "origin": "https://evil.example" },
      body: JSON.stringify({ url: PAGE }),
    }),
  );
  assertEquals(crossSite.status, 403);
});

Deno.test("POST /api/account/discover-feed: same-origin client gets the feeds (audio-feed-6hw, audio-feed-oq4pz)", async () => {
  const { fetch, session } = await app(() =>
    Promise.resolve({
      url: PAGE,
      title: "My Blog",
      feeds: [{ url: "https://example.com/feed.xml", title: "RSS", type: "application/rss+xml" }],
    })
  );
  const headers = {
    cookie: `__Host-af_session=${session}`,
    origin: BASE,
    "content-type": "application/json",
  };

  const sameOrigin = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: PAGE }),
    }),
  );
  assertEquals(sameOrigin.status, 200);
  assertEquals(await sameOrigin.json(), {
    url: PAGE,
    title: "My Blog",
    feeds: [{ url: "https://example.com/feed.xml", title: "RSS", type: "application/rss+xml" }],
  });
  assertEquals(sameOrigin.headers.get("cache-control"), "no-store");
});

Deno.test("POST /api/account/discover-feed: validates the URL before it reads anything (audio-feed-6hw, audio-feed-oq4pz)", async () => {
  let called = false;
  const { fetch, session } = await app(() => {
    called = true;
    return Promise.resolve({ url: PAGE, title: "", feeds: [] });
  });
  const headers = {
    cookie: `__Host-af_session=${session}`,
    origin: BASE,
    "content-type": "application/json",
  };

  const missing = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    }),
  );
  assertEquals(missing.status, 400);

  const hostile = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "javascript:alert(1)" }),
    }),
  );
  assertEquals(hostile.status, 400);

  const privateTarget = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "http://127.0.0.1/f" }),
    }),
  );
  assertEquals(privateTarget.status, 400);
  assertEquals(called, false, "the read is refused before the seam is reached");
});

Deno.test("POST /api/account/discover-feed: rate limits repeated discovery requests (audio-feed-oq4pz)", async () => {
  const { fetch, session } = await app(() =>
    Promise.resolve({ url: PAGE, title: "Test", feeds: [] })
  );
  const headers = {
    cookie: `__Host-af_session=${session}`,
    origin: BASE,
    "content-type": "application/json",
  };

  // 30 allowed requests per window
  for (let i = 0; i < 30; i++) {
    const res = await fetch(
      new Request(`${BASE}/api/account/discover-feed`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: PAGE }),
      }),
    );
    assertEquals(res.status, 200);
  }

  // 31st request exceeds rate limit
  const limited = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: PAGE }),
    }),
  );
  assertEquals(limited.status, 429);
  assertEquals(Boolean(limited.headers.get("retry-after")), true);
  assertStringIncludes(await limited.text(), "Too many feed discovery requests");
});

Deno.test("POST /api/account/discover-feed: a fetch refusal becomes its own status (audio-feed-6hw, audio-feed-oq4pz)", async () => {
  const { fetch, session } = await app(() =>
    Promise.reject(new IngestError(422, "Page is unavailable."))
  );
  const res = await fetch(
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers: {
        cookie: `__Host-af_session=${session}`,
        origin: BASE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: PAGE }),
    }),
  );

  assertEquals(res.status, 422);
  assertEquals(await res.json(), { error: "Page is unavailable." });
});

Deno.test("POST /api/account/discover-feed: only http(s) feeds are ever returned (audio-feed-6hw, audio-feed-oq4pz)", async () => {
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
    new Request(`${BASE}/api/account/discover-feed`, {
      method: "POST",
      headers: {
        cookie: `__Host-af_session=${session}`,
        origin: BASE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: PAGE }),
    }),
  );
  const body = await res.json() as { feeds: DiscoveredFeed[] };

  assertEquals(body.feeds.map((f) => f.url), ["https://example.com/ok.xml"]);
});
