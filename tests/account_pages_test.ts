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
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
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

/** Elements HTML lets an author leave unclosed. */
const OPTIONAL_END_TAGS = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "option",
  "optgroup",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "rt",
  "rp",
]);

/** Elements that never take an end tag. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Every tag that closes the wrong element or is never closed, in document order.
 *
 * Comments and the bodies of `<script>`/`<style>` are dropped first: neither contributes
 * elements to the tree and their contents are text. A scanner this small is enough because the
 * pages are server-rendered from template literals and `deno test` has no HTML parser; it is
 * deliberately pointed at the kit pages below rather than at arbitrary HTML.
 */
export function tagNestingProblems(html: string): string[] {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const problems: string[] = [];
  const open: string[] = [];
  for (
    const [, closing, rawTag, selfClose] of markup.matchAll(
      /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g,
    )
  ) {
    const tag = rawTag!.toLowerCase();
    if (VOID_TAGS.has(tag) || selfClose === "/") continue;
    if (!closing) {
      open.push(tag);
      continue;
    }
    let at = open.length - 1;
    while (at >= 0 && open[at] !== tag && OPTIONAL_END_TAGS.has(open[at]!)) at--;
    // Either the loop found the matching open element (truncate to and including it) or it stopped
    // on an element that is neither the closer's own element nor one whose end tag may be omitted -
    // which is the mismatch this function exists to report. Checking only `at < 0` here let the
    // stale `</div>` through: the loop stopped on `fieldset`, and truncating there looked like a
    // match. The mutant run is what caught it (a check that cannot fail is a false green).
    if (at < 0 || open[at] !== tag) {
      problems.push(`</${tag}> closes <${open[open.length - 1] ?? "nothing"}>`);
      continue;
    }
    open.length = at;
  }
  for (const tag of open) problems.push(`<${tag}> never closed`);
  return problems;
}

/**
 * RENDERED MARKUP MUST ACTUALLY NEST (audio-feed-lma7). A one-line markup error — a stale
 * `</div>` left behind when `<div class="choices">` became `<fieldset class="choices">`
 * (audio-feed-dc2y) — closed `div.wrap` in the middle of the send form, so every later
 * `section.panel` on /account landed as a SIBLING of the page column: full viewport width with
 * none of the wrap's max-width or gutter (measured at 390px: left 0, right 390, while /login and
 * the admin pages were correct). Nothing about the response status or the page's text changes
 * when a tag is mismatched, so the markup itself is the only place the check can live; and
 * because the defect only shows up in the DOM, per-element string assertions cannot see it.
 */
Deno.test("every kit page's markup actually nests its tags (audio-feed-lma7)", async () => {
  const { fetch, stores } = app();
  await seed(stores, { isAdmin: true });
  // Every page that renders through the shared shell: the account page (whose send form carried
  // the stale closer), the login page, and the admin console with its subpages. A tag that
  // escapes the page column breaks the layout of whatever follows it, so the whole set is walked.
  // /login is fetched signed OUT: it redirects a signed-in visitor, so a cookie would test the
  // redirect rather than the page.
  const pages: Array<[string, boolean]> = [
    ["/account", true],
    ["/login", false],
    ["/admin", true],
    ["/admin/subscribers", true],
  ];
  for (const [path, signedIn] of pages) {
    const res = signedIn ? await get(fetch, path, stores, "user-1") : await get(fetch, path);
    assertEquals(res.status, 200, `${path} should render`);
    assertEquals(tagNestingProblems(await res.text()), [], `${path} markup`);
  }
});

Deno.test("GET /account annotates the send-article form as an agent tool (audio-feed-dc2y)", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "user-1", displayName: "Paul", status: "approved", feedToken: "token-user-1" }),
  );
  const res = await get(fetch, "/account", stores, "user-1");
  assertEquals(res.status, 200);
  const html = await res.text();

  // The page's core action, declared as a tool: the form, the URL parameter, and the narration
  // style. The guidance is explicit that a parameter description for a GROUP of controls attaches
  // through the nearest parent fieldset, which is why the radio group is one (audio-feed-dc2y).
  assertStringIncludes(html, 'toolname="send_article"');
  assertStringIncludes(html, 'toolparamdescription="Public http(s) URL of the article to narrate"');
  assertStringIncludes(html, '<fieldset class="choices"');
  assertStringIncludes(html, 'toolparamdescription="Narration style');

  // Unchanged behaviour that the annotations must not have disturbed.
  assertStringIncludes(html, 'id="sendUrl"');
  assertStringIncludes(html, 'name="sendMode"');
});

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
  // The picker became radio cards with an audition player per voice
  // (audio-feed-msw); the saved voice is still the one that comes up chosen.
  assert(/name="voice" value="Kore" checked/.test(html), "the saved voice is checked");
});

Deno.test("GET /account renders Retry failed button and per-episode Retry button on failed rows (audio-feed-6y9)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { displayName: "Paul", status: "approved" });
  await stores.metadata.putSource(makeSource({ id: "mine", userId: me.id, title: "My Blog" }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-ready",
    userId: me.id,
    sourceId: "mine",
    title: "Ready Episode",
    status: "ready",
    audioKey: "audio/ready.wav",
  }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "ep-fail",
    userId: me.id,
    sourceId: "mine",
    title: "Failed Episode",
    status: "failed",
    error: "Gemini quota exceeded",
  }));

  const res = await get(fetch, "/account", stores, me.id);
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(html, 'id="retryFailed"');
  assertStringIncludes(html, "Retry failed (1)");
  assertStringIncludes(html, 'data-retry-episode="ep-fail"');
  assertStringIncludes(html, "Gemini quota exceeded");
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
  assertStringIncludes(html, 'href="/login?next=%2Fadmin#bootstrap"');
  assertStringIncludes(html, "Bootstrap passkey");
  assertEquals(html.includes("Use admin token instead"), false);
  assertEquals(html.includes('id="adminToken"'), false);
  // audio-feed-3xq part 4a: the session flag reaches the client through the #admin-data
  // island, not an interpolated JS constant.
  assertStringIncludes(html, '"signedIn":false');
});

Deno.test("GET /login: renders Admin bootstrap accordion panel (audio-feed-8eh)", async () => {
  const { fetch } = app();
  const res = await get(fetch, "/login");
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'id="bootstrapDetails"');
  assertStringIncludes(html, "Admin bootstrap");
  assertStringIncludes(html, 'id="bootstrapEmail"');
  assertStringIncludes(html, 'id="bootstrapToken"');
  assertStringIncludes(html, 'id="bootstrapSubmit"');
});

Deno.test("GET /admin: an admin session gets the console, signed in (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const admin = await seed(stores, { id: "admin-1", isAdmin: true, displayName: "Paul" });
  const res = await get(fetch, "/admin", stores, admin.id);
  assertEquals(res.status, 200);
  const html = await res.text();
  // audio-feed-3xq part 4a: the session flag rides in the #admin-data island.
  assertStringIncludes(html, '"signedIn":true');
  assertStringIncludes(html, 'id="usersBody"');
  assertStringIncludes(html, "Sign out");
});

Deno.test("every page shares one shell and the player's palette (audio-feed-8fc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { isAdmin: true });
  const anon = await (await get(fetch, "/")).text();
  assertStringIncludes(anon, 'class="site-header"', "/");
  assertStringIncludes(anon, 'class="site-footer"', "/");
  assertStringIncludes(anon, "--bg: #0a0a0c", "/");
  assertStringIncludes(anon, "--accent: #a78bfa", "/");

  for (const path of ["/login", "/account", "/admin"]) {
    const html = await (await get(fetch, path, stores, me.id)).text();
    assertStringIncludes(html, 'class="site-header"', path);
    assertStringIncludes(html, 'class="site-footer"', path);
    // Dark mode is the player's (src/routes/listen.ts) near-black and violet.
    assertStringIncludes(html, "--bg: #0a0a0c", path);
    assertStringIncludes(html, "--accent: #a78bfa", path);
  }
});

Deno.test("the homepage redirects signed-in users to /account, and logged-out is private (audio-feed-8fc, audio-feed-irgu)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { displayName: "Reader One" });
  const anon = await get(fetch, "/");
  assertStringIncludes(await anon.text(), 'href="/login"');
  assertStringIncludes(anon.headers.get("vary") ?? "", "Cookie");

  const signed = await get(fetch, "/", stores, me.id);
  assertEquals(signed.status, 303);
  assertEquals(signed.headers.get("location"), "/account");
  assertEquals(signed.headers.get("cache-control"), "private, no-store");
  assertStringIncludes(signed.headers.get("vary") ?? "", "Cookie");
});

Deno.test("GET /account renders inline audio player for ready episodes (audio-feed-w2zc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { id: "user-audio-test", displayName: "Listener" });
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-ready-1",
      userId: me.id,
      title: "Playable Episode One",
      status: "ready",
      audioKey: "user-audio-test/direct/ep-ready-1.mp3",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-pending-1",
      userId: me.id,
      title: "Pending Episode",
      status: "pending",
    }),
  );

  const res = await get(fetch, "/account", stores, me.id);
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(
    html,
    '<audio controls preload="none" class="ep-audio" src="/audio/user-audio-test/direct/ep-ready-1.mp3"></audio>',
  );
  assertStringIncludes(html, "Playable Episode One");
  assertStringIncludes(html, "Pending Episode");
});

Deno.test("GET /account supports episode pagination via limit query parameter (audio-feed-w2zc)", async () => {
  const { fetch, stores } = app();
  const me = await seed(stores, { id: "user-paginated", displayName: "Power Listener" });

  // Seed 15 episodes
  for (let i = 1; i <= 15; i++) {
    const num = String(i).padStart(2, "0");
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-${num}`,
        userId: me.id,
        title: `Episode Number ${num}`,
        status: "ready",
        createdAt: new Date(Date.now() - (15 - i) * 60_000).toISOString(),
      }),
    );
  }

  // Default GET /account fetches 10 episodes and offers "Show more episodes"
  const resDefault = await get(fetch, "/account", stores, me.id);
  assertEquals(resDefault.status, 200);
  const htmlDefault = await resDefault.text();
  assertStringIncludes(htmlDefault, 'id="loadMoreEpisodes"');
  assertStringIncludes(htmlDefault, 'href="/account?limit=25#episodes-h"');
  assertStringIncludes(htmlDefault, "Show more episodes");

  // GET /account?limit=25 fetches all 15 episodes and shows "Show fewer"
  const resMore = await get(fetch, "/account?limit=25", stores, me.id);
  assertEquals(resMore.status, 200);
  const htmlMore = await resMore.text();
  assertStringIncludes(htmlMore, "Episode Number 01");
  assertStringIncludes(htmlMore, "Episode Number 15");
  assertStringIncludes(htmlMore, 'id="showFewerEpisodes"');
  assertStringIncludes(htmlMore, 'href="/account#episodes-h"');
  assert(
    !htmlMore.includes('id="loadMoreEpisodes"'),
    "no loadMoreEpisodes when all episodes fit in limit",
  );
});
