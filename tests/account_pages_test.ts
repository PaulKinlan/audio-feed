/**
 * The login and account pages, the admin page's session states, and the shared
 * shell (audio-feed-8fc). The passkey ceremonies themselves are driven in a real
 * browser (docs/evidence/audio-feed-8fc); these pin the server-side gates and
 * what each page promises.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { makeSource, makeUser } from "./fixtures.ts";
import type { User } from "../src/types.ts";

const BASE = "https://audio.example.com";

function app(overrides: Partial<AppConfig> = {}) {
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    ...overrides,
  };
  const ctx = { config, stores };
  return { fetch: createApp(ctx, createHandlers(ctx)).fetch, stores };
}

async function seed(stores: Stores, overrides: Partial<User> = {}): Promise<User> {
  const user = makeUser({ id: "user-1", email: "reader@example.com", ...overrides });
  await stores.metadata.putUser(user);
  return user;
}

async function get(
  fetch: (r: Request) => Promise<Response>,
  path: string,
  stores?: Stores,
  userId?: string,
) {
  const headers: Record<string, string> = {};
  if (stores && userId) {
    headers.cookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, userId)}`;
  }
  return fetch(new Request(`${BASE}${path}`, { headers }));
}

Deno.test("GET /account with no session redirects to /login (audio-feed-8fc)", async () => {
  const { fetch } = app();
  const res = await get(fetch, "/account");
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/login?next=%2Faccount");
});

Deno.test("GET /account shows the signed-in user's own account, uncached (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { displayName: "<b>Reader</b>", voice: "Kore" });
  const other = await seed(stores, { id: "user-2", email: "other@example.com" });
  await stores.metadata.putSource(makeSource({ id: "mine", userId: me.id, title: "My Blog" }));
  await stores.metadata.putSource(makeSource({ id: "theirs", userId: other.id, title: "Theirs" }));
  await stores.metadata.putCredential({
    id: "cred-1",
    userId: me.id,
    publicKey: "pk",
    counter: 0,
    name: "Passkey added 2026-09-26",
    createdAt: "2026-09-26T00:00:00.000Z",
  });

  const res = await get(fetch, "/account", stores, me.id);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  const html = await res.text();
  assertStringIncludes(html, `${BASE}/feed/${me.feedToken}/master.xml`);
  assertStringIncludes(html, "My Blog");
  assertStringIncludes(html, "Passkey added 2026-09-26");
  assertStringIncludes(html, "&lt;b&gt;Reader&lt;/b&gt;");
  assert(!html.includes("<b>Reader</b>"), "display name is escaped");
  assert(!html.includes("Theirs"), "another user's source never appears");
  assert(!html.includes(other.feedToken), "another user's token never appears");
  assert(/<option value="Kore" selected>/.test(html), "the saved voice is selected");
});

Deno.test("GET /account tells a pending user why nothing is generated (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { status: "pending" });
  const html = await (await get(fetch, "/account", stores, me.id)).text();
  assertStringIncludes(html, "waiting for approval");
});

Deno.test("GET /login offers a passkey and a setup panel, uncached (audio-feed-8fc)", async () => {
  const { fetch } = app();
  const res = await get(fetch, "/login");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  const html = await res.text();
  assertStringIncludes(html, 'id="signIn"');
  assertStringIncludes(html, 'id="setupPanel"');
  // The setup secret is read from the fragment and scrubbed from history.
  assertStringIncludes(html, "location.hash");
  assertStringIncludes(html, "history.replaceState");
  assertEquals(/\.innerHTML\s*=/.test(html), false, "no innerHTML assignment");
});

Deno.test("GET /login only follows same-site next paths (audio-feed-8fc)", async () => {
  const { fetch } = app();
  const html = await (await get(fetch, "/login?next=//evil.example/x")).text();
  assert(!html.includes("evil.example"), "a protocol-relative next is dropped");
  const ok = await (await get(fetch, "/login?next=%2Fadmin")).text();
  assertStringIncludes(ok, '"/admin"');
});

Deno.test("GET /admin: a signed-in non-admin gets 403 (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores);
  const res = await get(fetch, "/admin", stores, me.id);
  assertEquals(res.status, 403);
  const html = await res.text();
  assertStringIncludes(html, "reader@example.com");
  assert(!html.includes('id="usersBody"'), "no console for a non-admin");
});

Deno.test("GET /admin: a signed-out visitor is offered sign-in, token controls removed (audio-feed-8fc, audio-feed-0jp)", async () => {
  const { fetch } = app();
  const res = await get(fetch, "/admin");
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'href="/login?next=%2Fadmin"');
  assertEquals(html.includes("Use admin token instead"), false);
  assertEquals(html.includes('id="adminToken"'), false);
  assertStringIncludes(html, "const SIGNED_IN = false");
});

Deno.test("GET /admin: an admin session gets the console, signed in (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const admin = await seed(stores, { id: "admin-1", isAdmin: true, displayName: "Paul" });
  const res = await get(fetch, "/admin", stores, admin.id);
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "const SIGNED_IN = true");
  assertStringIncludes(html, 'id="usersBody"');
  assertStringIncludes(html, "Sign out");
});

Deno.test("every page shares one shell and the player's palette (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { isAdmin: true });
  for (const path of ["/", "/login", "/account", "/admin"]) {
    const html = await (await get(fetch, path, stores, me.id)).text();
    assertStringIncludes(html, 'class="site-header"', path);
    assertStringIncludes(html, 'class="site-footer"', path);
    // Dark mode is the player's (src/routes/listen.ts) near-black and violet.
    assertStringIncludes(html, "--bg: #0a0a0c", path);
    assertStringIncludes(html, "--accent: #a78bfa", path);
  }
});

Deno.test("the homepage header knows who is signed in, and is then private (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { displayName: "Reader One" });
  const anon = await get(fetch, "/");
  assertStringIncludes(await anon.text(), 'href="/login"');
  assertStringIncludes(anon.headers.get("vary") ?? "", "Cookie");

  const signed = await get(fetch, "/", stores, me.id);
  assertEquals(signed.headers.get("cache-control"), "private, no-store");
  const html = await signed.text();
  assertStringIncludes(html, "Reader One");
  assertStringIncludes(html, 'href="/account"');
  assertStringIncludes(html, 'action="/api/auth/logout"');
});
