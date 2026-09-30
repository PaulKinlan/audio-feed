// audio-feed-vtiy: W3C Web Share Target API tests
//
// Verifies:
// - Web App Manifest declares share_target with action /share, method GET, and params { title, text, url }
// - extractUrlFromShare extracts valid URLs from url param or text regex
// - handleShare routes authenticated users to /account?add=... with prefilled title
// - handleShare routes unauthenticated users to /login?next=... preserving the add/title parameters

import { assertEquals } from "@std/assert";
import { MANIFEST } from "../src/routes/pwa.ts";
import { extractUrlFromShare, isValidWebUrl } from "../src/routes/share.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";

const BASE = "https://audio.example.com";

Deno.test("share_target: manifest declares W3C Web Share Target member (audio-feed-vtiy)", () => {
  assertEquals(MANIFEST.share_target, {
    action: "/share",
    method: "GET",
    params: {
      title: "title",
      text: "text",
      url: "url",
    },
  });
});

Deno.test("extractUrlFromShare: handles url, text regex, and punctuation stripping (audio-feed-vtiy)", () => {
  // 1. Direct url parameter
  assertEquals(
    extractUrlFromShare("https://example.com/article-1", undefined),
    "https://example.com/article-1",
  );

  // 2. Direct url parameter with surrounding whitespace
  assertEquals(
    extractUrlFromShare("  https://example.com/article-2  ", undefined),
    "https://example.com/article-2",
  );

  // 3. Text parameter containing clean URL
  assertEquals(
    extractUrlFromShare(null, "https://example.com/article-3"),
    "https://example.com/article-3",
  );

  // 4. Android style text parameter with leading text and trailing punctuation
  assertEquals(
    extractUrlFromShare("", "Check out this article: https://example.com/article-4!"),
    "https://example.com/article-4",
  );
  assertEquals(
    extractUrlFromShare(null, "Interesting read (https://example.com/article-5)."),
    "https://example.com/article-5",
  );

  // 5. Invalid / missing targets return null
  assertEquals(extractUrlFromShare(null, null), null);
  assertEquals(extractUrlFromShare("", "Just some plain text without a link"), null);
  assertEquals(extractUrlFromShare("javascript:alert(1)", null), null);
  assertEquals(isValidWebUrl("ftp://example.com/file"), false);
});

Deno.test("handleShare: routes signed-in users directly to /account with prefill params (audio-feed-vtiy)", async () => {
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const rawUser = await createUser(stores.metadata, {
    email: "listener@example.com",
    displayName: "Listener",
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const session = await createSession(stores.metadata, user.id);
  const cookie = `__Host-af_session=${session}`;

  // 1. Share with url and title
  const res1 = await fetch(
    new Request(
      `${BASE}/share?url=${encodeURIComponent("https://example.com/shared-post")}&title=${
        encodeURIComponent("Great Post")
      }`,
      { headers: { cookie }, redirect: "manual" },
    ),
  );
  assertEquals(res1.status, 303);
  assertEquals(
    res1.headers.get("location"),
    `/account?add=${encodeURIComponent("https://example.com/shared-post")}&title=${
      encodeURIComponent("Great Post")
    }`,
  );

  // 2. Share with text containing link
  const res2 = await fetch(
    new Request(
      `${BASE}/share?text=${encodeURIComponent("Read this: https://example.com/from-text")}`,
      { headers: { cookie }, redirect: "manual" },
    ),
  );
  assertEquals(res2.status, 303);
  assertEquals(
    res2.headers.get("location"),
    `/account?add=${encodeURIComponent("https://example.com/from-text")}`,
  );

  // 3. Share with no URL redirects to /account
  const res3 = await fetch(
    new Request(`${BASE}/share?text=NoLinkHere`, { headers: { cookie }, redirect: "manual" }),
  );
  assertEquals(res3.status, 303);
  assertEquals(res3.headers.get("location"), "/account");
});

Deno.test("handleShare: routes signed-out users to /login preserving next parameter (audio-feed-vtiy)", async () => {
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  // 1. Share with valid URL
  const expectedPath = `/account?add=${
    encodeURIComponent("https://example.com/unauth-post")
  }&title=${encodeURIComponent("Unauth Title")}`;
  const res = await fetch(
    new Request(
      `${BASE}/share?url=${encodeURIComponent("https://example.com/unauth-post")}&title=${
        encodeURIComponent("Unauth Title")
      }`,
      { redirect: "manual" },
    ),
  );
  assertEquals(res.status, 303);
  const location = res.headers.get("location") ?? "";
  assertEquals(location, `/login?next=${encodeURIComponent(expectedPath)}`);

  // 2. Share with no URL redirects to /login?next=%2Faccount
  const resNoUrl = await fetch(
    new Request(`${BASE}/share`, { redirect: "manual" }),
  );
  assertEquals(resNoUrl.status, 303);
  assertEquals(resNoUrl.headers.get("location"), `/login?next=${encodeURIComponent("/account")}`);
});

Deno.test("GET /manifest.json serves share_target declaration (audio-feed-vtiy)", async () => {
  const config: AppConfig = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const res = await fetch(new Request(`${BASE}/manifest.json`));
  assertEquals(res.status, 200);
  const manifest = await res.json();
  assertEquals(manifest.share_target, {
    action: "/share",
    method: "GET",
    params: {
      title: "title",
      text: "text",
      url: "url",
    },
  });
});
