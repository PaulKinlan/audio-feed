import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";

async function setup() {
  const config: AppConfig = {
    port: 8080,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
  };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const handlers = createHandlers(ctx);
  const { fetch } = createApp(ctx, handlers);

  const rawUser = await createUser(stores.metadata, {
    email: "bookmarklet-user@example.com",
    displayName: "Bookmarklet User",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);

  return { ctx, fetch, stores, user, session };
}

/** The bookmarklet href as the page emits it, entities decoded. */
function bookmarkletHrefIn(html: string): string {
  const raw = html.match(/href="(javascript:[^"]*)"/)?.[1] ?? "";
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

Deno.test("GET /account and /: one bookmarklet builder with the widened feed shapes (audio-feed-6hw)", async () => {
  const { fetch, session } = await setup();

  const res = await fetch(
    new Request(`${BASE}/account`, {
      headers: { cookie: `__Host-af_session=${session}` },
    }),
  );
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(html, "Browser Bookmarklet");
  assertStringIncludes(html, 'draggable="true"');
  assertStringIncludes(html, "Add to Audio Feed");
  assertStringIncludes(html, "javascript:(function()");
  assertStringIncludes(html, "/account?add=");

  // ONE builder (audio-feed-6hw): the account page and the front door emit the
  // same href, so a shape fixed for one is fixed for both.
  const home = await fetch(new Request(`${BASE}/`));
  const homeHtml = await home.text();
  const accountHref = bookmarkletHrefIn(html);
  const homeHref = bookmarkletHrefIn(homeHtml);
  assert(accountHref.length > 0, "account page carries a bookmarklet href");
  assertEquals(accountHref, homeHref);

  // The widened shapes: a declared feed of any of these types, or a link that
  // names one, all reach the account page with a feed rather than none.
  for (
    const shape of [
      'link[rel~="alternate"][type*="rss"]',
      'link[rel~="alternate"][type*="atom"]',
      'link[rel~="alternate"][type*="feed"]',
      'link[rel~="alternate"][type*="json"]',
      'link[rel~="alternate"][type*="xml"]',
      'a[href*="/feed"]',
      'a[href$=".xml"]',
    ]
  ) {
    assertStringIncludes(accountHref, shape);
  }
});

Deno.test("GET /account?add=<url>: renders ONE unified card and no second form (audio-feed-6hw)", async () => {
  const { fetch, session } = await setup();

  const targetUrl = "https://example.com/great-article";
  const targetTitle = "A Great Read";

  const res = await fetch(
    new Request(
      `${BASE}/account?add=${encodeURIComponent(targetUrl)}&title=${
        encodeURIComponent(targetTitle)
      }`,
      {
        headers: { cookie: `__Host-af_session=${session}` },
      },
    ),
  );
  assertEquals(res.status, 200);
  const html = await res.text();

  // ONE unified card, and the plain send panel is GONE: the duplicate was the
  // always-on form rendering next to the prefilled panel (audio-feed-6hw).
  assertStringIncludes(html, 'id="quickAddPanel"');
  assertStringIncludes(html, targetUrl);
  assertStringIncludes(html, targetTitle);
  assertStringIncludes(html, 'id="quickSingleBtn"');
  assertEquals(
    html.split('id="quickAddPanel"').length - 1,
    1,
    "exactly one send/queue card when the page arrives with a URL",
  );
  assertEquals(html.includes('id="sendForm"'), false, "no second form");
  assertEquals(html.includes('id="sendUrl"'), false, "no second URL input");

  // No feed was passed, so the subscribe half waits for server-side discovery
  // rather than being shown empty.
  assertStringIncludes(html, 'id="detectedFeed" hidden');
});

Deno.test("GET /account?add=<url>&feed=<feed>: the subscribe choice lives inside the one card (audio-feed-6hw)", async () => {
  const { fetch, session } = await setup();

  const targetUrl = "https://example.com/blog/post-1";
  const targetTitle = "Blog Post 1";
  const feedUrl = "https://example.com/feed.xml";

  const res = await fetch(
    new Request(
      `${BASE}/account?add=${encodeURIComponent(targetUrl)}&title=${
        encodeURIComponent(targetTitle)
      }&feed=${encodeURIComponent(feedUrl)}`,
      { headers: { cookie: `__Host-af_session=${session}` } },
    ),
  );
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(html, 'id="quickAddPanel"');
  assertStringIncludes(html, "Queue this single page");
  assertStringIncludes(html, "Subscribe to the feed");
  assertStringIncludes(html, feedUrl);
  assertStringIncludes(html, 'id="quickSingleBtn"');
  assertStringIncludes(html, 'id="quickSubscribeBtn"');
  assertEquals(html.split('id="quickAddPanel"').length - 1, 1, "still exactly one card");
  assertEquals(html.includes('id="sendForm"'), false, "still no second form");
  // A feed the bookmarklet already found is shown at once, no round trip.
  assertEquals(html.includes('id="detectedFeed" hidden'), false);
});

Deno.test("GET /account: sanitizes hostile HTML in title and rejects invalid URLs (audio-feed-ep1)", async () => {
  const { fetch, session } = await setup();

  // Hostile script in title
  const hostileTitle = "<script>alert('xss')</script>";
  const validUrl = "https://example.com/safe";

  const res = await fetch(
    new Request(
      `${BASE}/account?add=${encodeURIComponent(validUrl)}&title=${
        encodeURIComponent(hostileTitle)
      }`,
      {
        headers: { cookie: `__Host-af_session=${session}` },
      },
    ),
  );
  assertEquals(res.status, 200);
  const html = await res.text();

  assertEquals(
    html.includes("<script>alert('xss')</script>"),
    false,
    "raw script tag must not appear",
  );
  assertStringIncludes(html, "&lt;script&gt;alert('xss')&lt;/script&gt;");

  // Hostile javascript: URL must be rejected and not rendered in quickAddPanel
  const resBadUrl = await fetch(
    new Request(`${BASE}/account?add=javascript:alert(1)`, {
      headers: { cookie: `__Host-af_session=${session}` },
    }),
  );
  const htmlBad = await resBadUrl.text();
  assertEquals(htmlBad.includes('id="quickAddPanel"'), false, "malicious scheme must be ignored");
  assertEquals(
    htmlBad.includes("javascript:alert(1)"),
    false,
    "the bad URL is not rendered at all",
  );
  // Invalid prefill = no prefill: the plain form is the right page, once.
  assertStringIncludes(htmlBad, 'id="sendForm"');
});

Deno.test("GET /add: redirects to /account with query parameters preserved (audio-feed-ep1)", async () => {
  const { fetch } = await setup();

  const res = await fetch(
    new Request(`${BASE}/add?url=https://example.com/post&title=Test`),
  );
  assertEquals(res.status, 303);
  assertEquals(
    res.headers.get("location"),
    `${BASE}/account?url=https://example.com/post&title=Test`,
  );
});

Deno.test("GET /account: signed-out redirect preserves ?add= query parameters to /login (audio-feed-ep1)", async () => {
  const { fetch } = await setup();

  const res = await fetch(
    new Request(`${BASE}/account?add=https://example.com/post&title=Test`),
  );
  assertEquals(res.status, 303);
  const loc = res.headers.get("location") ?? "";
  assertStringIncludes(loc, "/login?next=");
  assertStringIncludes(loc, encodeURIComponent("/account?add=https://example.com/post&title=Test"));
});

Deno.test("GET /: front door renders bookmarklet link (audio-feed-ep1)", async () => {
  const { fetch } = await setup();

  const res = await fetch(new Request(`${BASE}/`));
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(html, "Browser Bookmarklet");
  assertStringIncludes(html, "Add to Audio Feed");
  assertStringIncludes(html, "javascript:(function()");
});

/** The disclosure's code snippet, entities decoded (the same payload the anchor carries). */
function bookmarkletSnippetIn(html: string): string {
  const raw = html.match(
    /<pre class="bookmarklet-snippet u-break-all u-fs-xs"><code>([\s\S]*?)<\/code><\/pre>/,
  )?.[1] ?? "";
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

Deno.test("GET /account explains the CSP refusal and offers the bookmarklet code (audio-feed-kvnw)", async () => {
  const { fetch, session } = await setup();

  const res = await fetch(
    new Request(`${BASE}/account`, {
      headers: { cookie: `__Host-af_session=${session}` },
    }),
  );
  assertEquals(res.status, 200);
  const html = await res.text();

  // The draggable anchor is UNCHANGED: it is the intended install flow (audio-feed-ep1).
  const anchorMatch = html.match(/<a[^>]+class="btn quiet small bookmarklet-btn"[^>]+>/i)?.[0];
  assert(anchorMatch, "the account page must still render the bookmarklet anchor");
  assertStringIncludes(anchorMatch, 'draggable="true"');
  assertStringIncludes(anchorMatch, "javascript:(function()");

  // The honest fallback: the same disclosure the front door got in audio-feed-3asd, because /account is
  // served by the same htmlResponse CSP (src/routes/csp.ts:58) and its javascript: anchor is refused on
  // click for exactly the same reason.
  assertStringIncludes(html, '<details class="bookmarklet-code u-mt-2">');
  assertStringIncludes(html, "<summary>Can’t drag it? Get the bookmarklet code</summary>");
  assertStringIncludes(html, "Content Security Policy");
  assertStringIncludes(html, "<code>javascript:</code>");

  // The snippet must be the SAME payload as the anchor's href (one builder, audio-feed-6hw), or the
  // fallback would install something the draggable button does not.
  const href = bookmarkletHrefIn(html);
  const snippet = bookmarkletSnippetIn(html);
  assert(
    snippet.startsWith("javascript:(function()"),
    "the snippet must carry the bookmarklet source",
  );
  assertEquals(
    snippet,
    href,
    "the disclosure's snippet and the anchor href must be the same payload",
  );
});
