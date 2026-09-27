import { assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("GET /account: renders draggable bookmarklet button (audio-feed-ep1)", async () => {
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
  assertStringIncludes(html, "link[rel=");
  assertStringIncludes(html, "/account?add=");
});

Deno.test("GET /account?add=<url>: renders prefilled quick-add panel for single article (audio-feed-ep1)", async () => {
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

  // Quick-add panel is present
  assertStringIncludes(html, 'id="quickAddPanel"');
  assertStringIncludes(html, targetUrl);
  assertStringIncludes(html, targetTitle);
  assertStringIncludes(html, 'id="quickSingleBtn"');

  // When no feed is provided, feed subscribe option is not shown
  assertEquals(html.includes("Option 2: Subscribe to RSS feed"), false);
});

Deno.test("GET /account?add=<url>&feed=<feed>: renders both single page and RSS subscribe options (audio-feed-ep1)", async () => {
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
  assertStringIncludes(html, "Option 1: Queue this single page");
  assertStringIncludes(html, "Option 2: Subscribe to RSS feed");
  assertStringIncludes(html, feedUrl);
  assertStringIncludes(html, 'id="quickSingleBtn"');
  assertStringIncludes(html, 'id="quickSubscribeBtn"');
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
