/**
 * Route gates for sign-in, accounts and admin sessions (audio-feed-8fc).
 *
 * Every gate the bead names gets a request here: no session, the wrong user, a
 * non-admin on admin routes, and a missing or foreign Origin on a cookie-
 * authenticated state change. Sessions are minted with `createSession` directly;
 * the passkey ceremony itself is proven in a real browser (docs/evidence).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, hashSecret, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { makeSource, makeUser } from "./fixtures.ts";
import type { User } from "../src/types.ts";

const BASE = "https://audio.example.com";
const EVIL = "https://evil.example";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Sample</title>
<link>https://example.com</link><item><title>Post 1</title><link>https://example.com/p1</link>
<pubDate>Mon, 01 Sep 2026 06:00:00 +0000</pubDate></item></channel></rss>`;

function app(overrides: Partial<AppConfig> = {}) {
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    ...overrides,
  };
  const ctx = { config, stores };
  const handlers = createHandlers(ctx, {
    feedTransport: () =>
      Promise.resolve(new Response(RSS, { headers: { "content-type": "application/rss+xml" } })),
    fetchArticle: (url) =>
      Promise.resolve({
        url,
        title: "Article",
        author: "A",
        publishedAt: "2026-09-01T06:00:00.000Z",
        lead: "Lead",
        body: "Body.",
      }),
  });
  return { fetch: createApp(ctx, handlers).fetch, stores };
}

async function seed(stores: Stores, overrides: Partial<User> = {}): Promise<User> {
  const user = makeUser({ id: "user-1", email: "reader@example.com", ...overrides });
  await stores.metadata.putUser(user);
  return user;
}

async function cookieFor(stores: Stores, userId: string): Promise<string> {
  return `${SESSION_COOKIE}=${await createSession(stores.metadata, userId)}`;
}

function call(
  path: string,
  opts: {
    method?: string;
    cookie?: string;
    origin?: string | null;
    json?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
}

function clientData(type: string, challenge: string): string {
  const json = JSON.stringify({ type, challenge, origin: BASE });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// -- account: no session, wrong Origin, wrong user ---------------------------

Deno.test("account profile: no session is 401 (audio-feed-8fc)", async () => {
  const { fetch } = app();
  const res = await fetch(
    call("/api/account/profile", { json: { displayName: "X" }, origin: BASE }),
  );
  assertEquals(res.status, 401);
});

Deno.test("account profile: a missing or foreign Origin is refused (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);
  for (const origin of [null, EVIL, "https://audio.example.com.evil.example"]) {
    const res = await fetch(
      call("/api/account/profile", { json: { displayName: "Hacked" }, cookie, origin }),
    );
    assertEquals(res.status, 403, `origin ${origin}`);
  }
  assertEquals((await stores.metadata.getUser(user.id))?.displayName, user.displayName);
});

Deno.test("account profile: edits persist, and an unknown voice is refused (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);
  const ok = await fetch(
    call("/api/account/profile", {
      json: { displayName: "New Name", voice: "Kore" },
      cookie,
      origin: BASE,
    }),
  );
  assertEquals(ok.status, 200);
  const saved = await stores.metadata.getUser(user.id);
  assertEquals([saved?.displayName, saved?.voice], ["New Name", "Kore"]);

  const bad = await fetch(
    call("/api/account/profile", { json: { voice: "Nobody" }, cookie, origin: BASE }),
  );
  assertEquals(bad.status, 400);
  const cleared = await fetch(
    call("/api/account/profile", { json: { voice: "" }, cookie, origin: BASE }),
  );
  assertEquals(cleared.status, 200);
  assertEquals((await stores.metadata.getUser(user.id))?.voice, undefined);
});

Deno.test("account rotate-token: the old feed token stops resolving (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);
  const res = await fetch(call("/api/account/rotate-token", { json: {}, cookie, origin: BASE }));
  assertEquals(res.status, 200);
  assertEquals(await stores.metadata.getUserByFeedToken(user.feedToken), null);
  const body = await res.json();
  assertEquals((await stores.metadata.getUserByFeedToken(body.feedToken))?.id, user.id);
});

Deno.test("account sources: add queues, and a pending user may not spend (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const pending = await seed(stores, { id: "user-2", email: "p@example.com", status: "pending" });
  const res = await fetch(call("/api/account/sources", {
    json: { feedUrl: "https://example.com/feed.xml", modes: ["direct"] },
    cookie: await cookieFor(stores, user.id),
    origin: BASE,
  }));
  assertEquals(res.status, 201);
  assertEquals((await stores.metadata.listSources(user.id)).length, 1);

  const refused = await fetch(call("/api/account/sources", {
    json: { feedUrl: "https://example.com/feed.xml" },
    cookie: await cookieFor(stores, pending.id),
    origin: BASE,
  }));
  assertEquals(refused.status, 403);
});

Deno.test("account sources: another user's source is 404 and untouched (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores);
  const other = await seed(stores, { id: "user-2", email: "o@example.com" });
  await stores.metadata.putSource(makeSource({ id: "theirs", userId: other.id }));
  await stores.metadata.putSource(makeSource({ id: "mine", userId: me.id }));
  const cookie = await cookieFor(stores, me.id);

  const foreign = await fetch(
    call("/api/account/sources/theirs", { method: "DELETE", cookie, origin: BASE }),
  );
  assertEquals(foreign.status, 404);
  assert(await stores.metadata.getSource(other.id, "theirs"));

  const noOrigin = await fetch(call("/api/account/sources/mine", { method: "DELETE", cookie }));
  assertEquals(noOrigin.status, 403);
  const own = await fetch(
    call("/api/account/sources/mine", { method: "DELETE", cookie, origin: BASE }),
  );
  assertEquals(own.status, 200);
  assertEquals(await stores.metadata.getSource(me.id, "mine"), null);
});

Deno.test("account passkeys: not another user's, and never the last one (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores);
  const other = await seed(stores, { id: "user-2", email: "o@example.com" });
  const cred = (id: string, userId: string, at: string) => ({
    id,
    userId,
    publicKey: "pk",
    counter: 0,
    name: id,
    createdAt: at,
  });
  await stores.metadata.putCredential(cred("mine-1", me.id, "2026-09-01T00:00:00.000Z"));
  await stores.metadata.putCredential(cred("mine-2", me.id, "2026-09-02T00:00:00.000Z"));
  await stores.metadata.putCredential(cred("theirs", other.id, "2026-09-01T00:00:00.000Z"));
  const cookie = await cookieFor(stores, me.id);
  const del = (id: string) =>
    fetch(call(`/api/account/passkeys/${id}`, { method: "DELETE", cookie, origin: BASE }));

  assertEquals((await del("theirs")).status, 404);
  assert(await stores.metadata.getCredential("theirs"));
  assertEquals((await del("mine-1")).status, 200);
  assertEquals((await del("mine-2")).status, 409, "the last passkey is the only way back in");
  assert(await stores.metadata.getCredential("mine-2"));
});

// -- sessions ------------------------------------------------------------------

Deno.test("sign out deletes the session; the cookie is dead afterwards (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);

  assertEquals((await fetch(call("/api/auth/logout", { json: {}, cookie }))).status, 403);
  const res = await fetch(call("/api/auth/logout", { json: {}, cookie, origin: BASE }));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "Max-Age=0");
  const after = await fetch(
    call("/api/account/profile", { json: { displayName: "Z" }, cookie, origin: BASE }),
  );
  assertEquals(after.status, 401);
});

Deno.test("an expired session is signed out (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const secret = "expired-secret";
  await stores.metadata.putSession({
    idHash: await hashSecret(secret),
    userId: user.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
  });
  const res = await fetch(call("/api/account/profile", {
    json: { displayName: "Z" },
    cookie: `${SESSION_COOKIE}=${secret}`,
    origin: BASE,
  }));
  assertEquals(res.status, 401);
  assertEquals(await stores.metadata.getSession(await hashSecret(secret)), null);
});

Deno.test("session store holds only the hash of the cookie secret (audio-feed-8fc)", async () => {
  const { stores } = app();
  const secret = await createSession(stores.metadata, "user-1");
  assertEquals(await stores.metadata.getSession(secret), null);
  assert(await stores.metadata.getSession(await hashSecret(secret)));
});

// -- admin: session OR token ---------------------------------------------------

Deno.test("admin API: a non-admin session is 403 (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);
  assertEquals((await fetch(call("/api/admin/users", { cookie }))).status, 403);
  assertEquals(
    (await fetch(
      call(`/api/admin/users/${user.id}/role`, { json: { isAdmin: true }, cookie, origin: BASE }),
    )).status,
    403,
  );
  assertEquals((await stores.metadata.getUser(user.id))?.isAdmin, false);
});

Deno.test("admin API: an admin session reads freely and writes only same-origin (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const admin = await seed(stores, { id: "admin-1", email: "admin@example.com", isAdmin: true });
  const target = await seed(stores, { id: "user-2", email: "t@example.com", status: "pending" });
  const cookie = await cookieFor(stores, admin.id);

  assertEquals((await fetch(call("/api/admin/users", { cookie }))).status, 200);
  for (const origin of [null, EVIL]) {
    const res = await fetch(
      call(`/api/admin/users/${target.id}/approve`, { method: "POST", cookie, origin }),
    );
    assertEquals(res.status, 403, `origin ${origin}`);
  }
  assertEquals((await stores.metadata.getUser(target.id))?.status, "pending");
  const ok = await fetch(
    call(`/api/admin/users/${target.id}/approve`, { method: "POST", cookie, origin: BASE }),
  );
  assertEquals(ok.status, 200);
});

Deno.test("admin API: a suspended admin is no admin (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const admin = await seed(stores, { id: "admin-1", isAdmin: true, status: "suspended" });
  assertEquals(
    (await fetch(call("/api/admin/users", { cookie: await cookieFor(stores, admin.id) }))).status,
    403,
  );
});

Deno.test("admin API: an admin session works without ADMIN_TOKEN; the token still works (audio-feed-8fc)", async () => {
  const unset = app({ adminToken: undefined });
  const admin = await seed(unset.stores, { id: "admin-1", isAdmin: true });
  assertEquals(
    (await unset.fetch(
      call("/api/admin/users", { cookie: await cookieFor(unset.stores, admin.id) }),
    )).status,
    200,
  );
  assertEquals((await unset.fetch(call("/api/admin/users"))).status, 403);

  const set = app();
  assertEquals(
    (await set.fetch(call("/api/admin/users", { headers: { "x-admin-token": "admin-secret" } })))
      .status,
    200,
  );
  assertEquals(
    (await set.fetch(call("/api/admin/users", { headers: { "x-admin-token": "wrong" } }))).status,
    401,
  );
});

Deno.test("admin role: promote another user, but never demote yourself (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const admin = await seed(stores, { id: "admin-1", email: "admin@example.com", isAdmin: true });
  const other = await seed(stores, { id: "user-2", email: "o@example.com" });
  const cookie = await cookieFor(stores, admin.id);
  const role = (id: string, isAdmin: boolean) =>
    fetch(call(`/api/admin/users/${id}/role`, { json: { isAdmin }, cookie, origin: BASE }));

  assertEquals((await role(other.id, true)).status, 200);
  assertEquals((await stores.metadata.getUser(other.id))?.isAdmin, true);
  assertEquals((await role(admin.id, false)).status, 409);
  assertEquals((await stores.metadata.getUser(admin.id))?.isAdmin, true);
});

Deno.test("admin create user can make an admin (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const res = await fetch(call("/api/admin/users", {
    json: { email: "new@example.com", isAdmin: true },
    headers: { "x-admin-token": "admin-secret" },
  }));
  assertEquals(res.status, 201);
  assertEquals((await stores.metadata.getUserByEmail("new@example.com"))?.isAdmin, true);
});

// -- setup links ----------------------------------------------------------------

Deno.test("setup link: admin-only, fragment-borne, stored hashed (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);
  assertEquals(
    (await fetch(
      call(`/api/admin/users/${user.id}/setup-link`, { method: "POST", cookie, origin: BASE }),
    )).status,
    403,
  );
  assertEquals(
    (await fetch(call(`/api/admin/users/nobody/setup-link`, {
      method: "POST",
      headers: { "x-admin-token": "admin-secret" },
    }))).status,
    404,
  );

  const res = await fetch(call(`/api/admin/users/${user.id}/setup-link`, {
    method: "POST",
    headers: { "x-admin-token": "admin-secret" },
  }));
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("location"), null);
  const body = await res.json();
  assertMatch(body.url, /^https:\/\/audio\.example\.com\/login#setup=[A-Za-z0-9_-]{43}$/);
  const token = body.url.split("#setup=")[1];
  assertEquals(await stores.metadata.getSetupLink(token), null, "never stored in the clear");
  assertEquals((await stores.metadata.getSetupLink(await hashSecret(token)))?.userId, user.id);
  const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
  assert(days > 6.9 && days <= 7, `expires in 7 days, got ${days}`);
});

Deno.test("register options: a live setup link names its user and is not consumed (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const issued = await (await fetch(call(`/api/admin/users/${user.id}/setup-link`, {
    method: "POST",
    headers: { "x-admin-token": "admin-secret" },
  }))).json();
  const setupToken = issued.url.split("#setup=")[1];

  const res = await fetch(
    call("/api/auth/register/options", { json: { setupToken }, origin: BASE }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.user.email, user.email);
  assertEquals(body.options.rp.id, "audio.example.com");
  assertEquals(body.options.authenticatorSelection.residentKey, "required");
  assert(await stores.metadata.getSetupLink(await hashSecret(setupToken)), "still usable");

  const noOrigin = await fetch(call("/api/auth/register/options", { json: { setupToken } }));
  assertEquals(noOrigin.status, 403);
});

Deno.test("register options: unknown, used and expired setup links are refused (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const expired = "expired-setup-token";
  await stores.metadata.putSetupLink({
    tokenHash: await hashSecret(expired),
    userId: user.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
    issuedBy: "admin",
  });
  for (const setupToken of ["never-issued", expired]) {
    const res = await fetch(
      call("/api/auth/register/options", { json: { setupToken }, origin: BASE }),
    );
    assertEquals(res.status, 400, setupToken);
  }
  const anonymous = await fetch(call("/api/auth/register/options", { json: {}, origin: BASE }));
  assertEquals(anonymous.status, 401, "no link and no session");
  const signedIn = await fetch(call("/api/auth/register/options", {
    json: {},
    origin: BASE,
    cookie: await cookieFor(stores, user.id),
  }));
  assertEquals(signedIn.status, 200, "a signed-in user may add another passkey");
});

// -- passkey verification refusals ------------------------------------------------

Deno.test("login: options mint a challenge; bogus and replayed responses are 400 (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const options = await (await fetch(call("/api/auth/login/options", { json: {}, origin: BASE })))
    .json();
  assert(typeof options.challenge === "string" && options.challenge.length > 20);
  assertEquals(options.rpId, "audio.example.com");

  const bogus = await fetch(
    call("/api/auth/login/verify", { json: { nonsense: true }, origin: BASE }),
  );
  assertEquals(bogus.status, 400);

  // A register-purpose challenge cannot finish a sign-in, and is spent by the try.
  await stores.metadata.putChallenge({
    challenge: "reg-chal",
    purpose: "register",
    userId: "user-1",
    expiresAt: "2999-01-01T00:00:00.000Z",
  });
  const crossed = await fetch(call("/api/auth/login/verify", {
    json: {
      id: "x",
      rawId: "x",
      type: "public-key",
      response: { clientDataJSON: clientData("webauthn.get", "reg-chal") },
    },
    origin: BASE,
  }));
  assertEquals(crossed.status, 400);
  assertEquals(await stores.metadata.consumeChallenge("reg-chal"), null);
  assertEquals(crossed.headers.get("set-cookie"), null);
});

Deno.test("register verify: an unknown challenge is 400 and sets no cookie (audio-feed-8fc)", async () => {
  const { fetch } = app();
  const res = await fetch(call("/api/auth/register/verify", {
    json: {
      id: "x",
      rawId: "x",
      type: "public-key",
      response: { clientDataJSON: clientData("webauthn.create", "nope"), attestationObject: "" },
    },
    origin: BASE,
  }));
  assertEquals(res.status, 400);
  assertEquals(res.headers.get("set-cookie"), null);
});

// -- Send to Audio without a token ------------------------------------------------

Deno.test("ingest: a signed-in user sends without a token, same-origin only (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);
  const body = { url: "https://example.com/a", mode: "direct" };
  const foreign = await fetch(call("/api/ingest", { json: body, cookie, origin: EVIL }));
  assertEquals(foreign.status, 403);
  const ok = await fetch(call("/api/ingest", { json: body, cookie, origin: BASE }));
  assertEquals(ok.status, 202);
  const tokenOnly = await fetch(
    call("/api/ingest", { json: body, headers: { "x-feed-token": user.feedToken } }),
  );
  assertEquals(tokenOnly.status, 202, "the token path is unchanged");
});

Deno.test("sign out from a no-referrer page: Origin null counts only when the browser says same-origin (audio-feed-8fc)", async () => {
  // A form POST from a page served with Referrer-Policy: no-referrer carries
  // `Origin: null`. Sec-Fetch-Site is browser-set and cannot be forged by a page.
  const { fetch, stores } = app();
  const user = await seed(stores);
  const cookie = await cookieFor(stores, user.id);
  const logout = (site: string) =>
    fetch(call("/api/auth/logout", {
      method: "POST",
      cookie,
      origin: "null",
      headers: { "sec-fetch-site": site },
    }));
  assertEquals((await logout("cross-site")).status, 403);
  assertEquals((await logout("same-site")).status, 403);
  const ok = await logout("same-origin");
  assertEquals(ok.status, 303);
  assertEquals(ok.headers.get("location"), "/");
});
