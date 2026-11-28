/**
 * The login and account pages, the admin page's session states, and the shared
 * shell (audio-feed-8fc). The passkey ceremonies themselves are driven in a real
 * browser (docs/evidence/audio-feed-8fc); these pin the server-side gates and
 * what each page promises.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parseHTML } from "npm:linkedom@0.18.12";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { safeNext } from "../src/routes/login.ts";
import { jsonForScript } from "../src/routes/html.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { User } from "../src/types.ts";
import {
  CANONICAL_PROOF_ORIGIN,
  CANONICAL_QZ3X_FEED_TOKEN,
  isMutationScratchDir,
  latestProfileActivityMs,
  MUTANT_MARKER_FILE,
  pinQz3xCaptureDeterminism,
  PROFILE_ACTIVITY_AGE_MS,
  STALE_PROFILE_AGE_MS,
  sweepStaleMutationScratch,
  sweepStaleProfiles,
  touchProfileActivity,
  withMutationScratch,
} from "../scripts/proof-helper.ts";

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

/** Root elements whose subtree is foreign content, where a trailing `/` really is self-closing. */
const FOREIGN_ROOTS = new Set(["svg", "math"]);

/**
 * Every tag that closes the wrong element or is never closed, in document order.
 *
 * Comments and the bodies of `<script>`/`<style>` are dropped first: neither contributes
 * elements to the tree and their contents are text. A scanner this small is enough because the
 * pages are server-rendered from template literals and `deno test` has no HTML parser; it is
 * deliberately pointed at the kit pages below rather than at arbitrary HTML.
 *
 * AN UNTERMINATED COMMENT OR SCRIPT IS REPORTED, NOT SKIPPED (review of audio-feed-lma7, P2). The
 * stripping above is a no-op when the terminator is missing, and what is left behind is not "a page
 * with a stray tag": a browser treats everything after the opener as comment or script text, so it
 * never closes `div.wrap` at all while this scanner sees balanced elements and returns CLEAN. That
 * is a false green on the one failure this function exists for, so a leftover opener short-circuits
 * before the tag walk. The check is free of false positives by construction: a properly terminated
 * comment, script or style has already been removed by the replacements above, so anything still
 * starting one of these really is unterminated.
 */
export function tagNestingProblems(html: string): string[] {
  const markup = html
    // A COMMENT ENDS AT FOUR PLACES TO A BROWSER, not one: `-->`, the abrupt `--!>`, and `<!-->` /
    // `<!--->` which are comments with an empty body (HTML's comment-end and
    // abrupt-closing-of-empty-comment states). Knowing only `-->` reported the other three as
    // "unterminated", which a browser does not agree with - reviewer counterexamples R3, R4 and the
    // `<!-->` probe in the second round of this bead's review.
    .replace(/<!--(?:>|->|[\s\S]*?(?:--!>|-->))/g, "")
    .replace(/<script(?=[\s/>])[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style(?=[\s/>])[^>]*>[\s\S]*?<\/style>/gi, "");
  const problems: string[] = [];
  // The opener scan reads a copy with quoted ATTRIBUTE VALUES blanked, so a `<!--` that is attribute
  // DATA is not read as a comment (reviewer counterexample R11). Only `="..."` is blanked rather than
  // every quoted run, so a stray quote in body text cannot blank enough to hide a real opener - the
  // direction that would produce a false GREEN.
  const forOpeners = markup.replace(/="[^"]*"/g, '=""');
  // The delimiter is required, not just the name: custom elements are hyphenated by spec, so
  // `<style-guide>` and `<script-loader>` are legal element names, and a bare `includes("<script")`
  // called both of them an unterminated `<script>`/`<style>`. Found with the scanner probe during the
  // second round of this bead's review - a false RED, the one direction that costs a lane time for
  // nothing. The tightened form keeps every real detection (the probe still flags unterminated
  // `<script>`, `<script `, `<script/` and a trailing `<script`).
  for (
    const [opener, pattern] of [
      ["<!--", /<!--/],
      ["<script", /<script(?=[\s/>]|$)/i],
      ["<style", /<style(?=[\s/>]|$)/i],
    ] as const
  ) {
    if (pattern.test(forOpeners)) {
      problems.push(`unterminated ${opener} (a browser reads the rest of the page as its text)`);
    }
  }
  // SELF-CLOSING IS HONOURED ONLY WHERE THE PARSER HONOURS IT (audio-feed-djdp). A trailing `/`
  // closes an element by itself in SVG/MathML, whose subtrees are foreign content; it is meaningless
  // on a void HTML element, which has no end tag at all. On any OTHER HTML element the parser IGNORES
  // the slash and opens the element - `<section/>` then swallows whatever follows into the section.
  // This walk used to skip every `selfClose === "/"` tag, so `<div class="wrap"><section/></div>`
  // came back CLEAN while a browser silently moved the tree, which is the same class of silent
  // tree change this function exists to catch. The foreign case has to stay honoured in the other
  // direction: these pages emit self-closing SVG children, so treating those as open elements would
  // turn a false green into a false-red generator.
  const open: Array<{ tag: string; foreign: boolean }> = [];
  for (
    const [, closing, rawTag, selfClose] of markup.matchAll(
      /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g,
    )
  ) {
    const tag = rawTag!.toLowerCase();
    if (VOID_TAGS.has(tag)) continue;
    const foreign = open[open.length - 1]?.foreign === true || FOREIGN_ROOTS.has(tag);
    if (!closing && selfClose === "/" && foreign) continue;
    if (!closing) {
      open.push({ tag, foreign });
      continue;
    }
    let at = open.length - 1;
    while (at >= 0 && open[at]!.tag !== tag && OPTIONAL_END_TAGS.has(open[at]!.tag)) at--;
    // Either the loop found the matching open element (truncate to and including it) or it stopped
    // on an element that is neither the closer's own element nor one whose end tag may be omitted -
    // which is the mismatch this function exists to report. Checking only `at < 0` here let the
    // stale `</div>` through: the loop stopped on `fieldset`, and truncating there looked like a
    // match. The mutant run is what caught it (a check that cannot fail is a false green).
    if (at < 0 || open[at]!.tag !== tag) {
      problems.push(`</${tag}> closes <${open[open.length - 1]?.tag ?? "nothing"}>`);
      continue;
    }
    open.length = at;
  }
  for (const { tag } of open) problems.push(`<${tag}> never closed`);
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

/**
 * A scanner is only worth having if the shapes it CANNOT see are pinned, so the cases that matter
 * are asserted here rather than described (review of audio-feed-lma7, P2). The unterminated comment
 * is the one that counted: it is a false GREEN, it was found by review rather than by the gate, and
 * the reviewer flagged it as source-traced rather than executed - which is what this test fixes.
 */
Deno.test("the markup scanner reports each failure shape, including the unterminated comment (audio-feed-lma7)", () => {
  const reports = (html: string) => tagNestingProblems(html).join(" | ");

  // The reviewer's own probe, run rather than traced: a browser reads the section and the closing
  // `</div>` as comment text, so `div.wrap` never closes, while the tags themselves are balanced.
  const probe = `<div class="wrap"><!-- <section class="panel"></section></div>`;
  assert(
    reports(probe).includes("unterminated <!--"),
    `unterminated comment must be reported: ${reports(probe)}`,
  );
  // The same markup with the comment TERMINATED is clean, so the check above is not just "the
  // string contains `<!--`" - it is a check on the terminator.
  assertEquals(tagNestingProblems(`<div class="wrap"><!-- <section class="panel"> --></div>`), []);
  assert(reports(`<script>const a = 1;`).includes("unterminated <script"));
  assert(reports(`<style>.a { color: red; }`).includes("unterminated <style"));
  // A LOOKALIKE NAME IS NOT AN OPENER. Custom elements are hyphenated by spec, so <style-guide> and
  // <script-loader> are legal names, and the first version of the check above called both of them an
  // unterminated <script>/<style> - a false RED, the one direction that costs a lane time for
  // nothing. Found with the scanner probe in the second round of this bead's review, and pinned here
  // so the looseness cannot come back.
  assertEquals(tagNestingProblems(`<style-guide>x</style-guide>`), []);
  assertEquals(tagNestingProblems(`<script-loader src="a.js"></script-loader>`), []);
  // A COMMENT ENDS IN FOUR PLACES, NOT ONE - the reviewer's R3/R4 counterexamples plus the `<!-->`
  // probe. `--!>` is the abrupt comment end and `<!-->` / `<!--->` are empty-body comments, all
  // closed as far as a browser is concerned, so reporting them as "unterminated" was three more
  // false REDS. Only `-->` was known when this was written.
  for (
    const closed of [
      `<div class="wrap"><!--x--!><section></section></div>`,
      `<div class="wrap"><!-- <section></section> --!></div>`,
      `<!--><div><section></section></div>`,
      `<!---><div><section></section></div>`,
    ]
  ) {
    assertEquals(tagNestingProblems(closed), [], `${JSON.stringify(closed)} is a CLOSED comment`);
  }
  // ...and a comment opener that is attribute DATA is not a comment (reviewer R11).
  assertEquals(tagNestingProblems(`<div class="wrap" data-x="<!--">ok</div>`), []);
  // The dangling case must survive all of that, or the three fixes above would have bought quiet
  // with a false green. In this markup the FIRST comment is closed and the second never is.
  assert(
    reports(`<div class="wrap"><!-- closed --><section></section><!-- dangling </div>`).includes(
      "unterminated <!--",
    ),
  );
  // ...while the real openers, in every form the terminator can be missing, are still caught: the
  // delimiter requirement must not have narrowed the detection.
  for (const markup of ["<script>const a = 1;", "<script const a = 1;", "<script/", "<script"]) {
    assert(
      reports(markup).includes("unterminated <script"),
      `${JSON.stringify(markup)} must still be reported`,
    );
  }

  // SELF-CLOSING IS HONOURED ONLY WHERE THE PARSER HONOURS IT (audio-feed-djdp), and the closed
  // direction matters as much as the open one. A `/` on a VOID element is inert and must stay clean;
  // a `/` inside SVG/MathML really does close the element; and a `/` on an ordinary HTML element is
  // IGNORED by the parser, so `<section/>` must be treated as an open section. That last case used to
  // be a documented false green; the four kit pages below are the guard that fixing it did not turn
  // the check into a false-red generator on real markup.
  for (const voidElement of ["<br/>", '<img src="a.png"/>', '<input name="x"/>', "<hr/>"]) {
    assertEquals(
      tagNestingProblems(`<div class="wrap">${voidElement}</div>`),
      [],
      `${voidElement} is a void element and closes itself`,
    );
  }
  assertEquals(tagNestingProblems(`<div class="wrap"><svg><circle/></svg></div>`), []);
  assertEquals(
    tagNestingProblems(
      `<div class="wrap"><svg viewBox="0 0 1 1"><path/><g><rect/></g></svg></div>`,
    ),
    [],
  );
  assertEquals(tagNestingProblems(`<div class="wrap"><math><mi/></math></div>`), []);
  assert(
    reports(`<div class="wrap"><section/></div>`).includes("</div> closes <section>"),
    `a self-closing non-void element is OPEN to a browser: ${
      reports(`<div class="wrap"><section/></div>`)
    }`,
  );
  assert(reports(`<div/>`).includes("<div> never closed"));
  assert(reports(`<section class="panel"/>`).includes("<section> never closed"));
  // The defect this bead exists for, as the smallest reproduction of it.
  assert(reports(`<fieldset class="choices">x</div>`).includes("</div> closes <fieldset>"));
  // Cross-nesting, which a per-kind tag COUNT would call balanced.
  assert(tagNestingProblems(`<div><section></div></section>`).length > 0);
  // A tag written inside a script body or a terminated comment is TEXT, not an element: asserting
  // this direction matters as much as the other, or the scanner becomes a false-red generator.
  assertEquals(tagNestingProblems(`<script>const s = "</div>";</script><p>hi</p>`), []);
  assertEquals(tagNestingProblems(`<p>hi</p><!-- </span></div> -->`), []);
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

/**
 * `?next=` is an open-redirect sink: `renderLoginPage` puts `safeNext`'s output straight
 * into the Continue `<a href>` and into `location.assign(NEXT)` (audio-feed-5w1g5).
 *
 * These rows are the CLASS, not one payload: every character or encoding the URL parser
 * removes, rewrites or reinterprets between the raw string and the host it resolves to.
 * A prefix blacklist checks a different string from the one the browser resolves, so
 * each row that the parser alone neutralises has to be a row here.
 */
const NEXT_REJECTED: readonly (string | null)[] = [
  // Protocol-relative in the raw form.
  "//evil.example",
  "//evil.example/x",
  "///evil.example",
  "//evil.example:8080/x",
  // Backslash is `/` for http(s), so this is the same thing spelled differently.
  "/\\evil.example",
  "/\\/evil.example",
  "\\/evil.example",
  // C0 controls the parser DELETES anywhere in its input: 0x09 tab, 0x0A LF, 0x0D CR.
  // Each turns `/?/evil.example` into `//evil.example`.
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r/evil.example",
  "/\t\\evil.example",
  "/\t\t/evil.example",
  "/\n//evil.example",
  // Dot segments: same-origin as a raw path, but the normalised pathname is `//x`, which
  // is protocol-relative when re-emitted as a reference.
  "/..//evil.example",
  "/.%2e//evil.example",
  "/./\\evil.example",
  // An absolute URL of any scheme: only the origin is what matters.
  "https://evil.example",
  "http://evil.example/x",
  "javascript:alert(1)",
  "data:text/html,x",
  // Not a path at all, and nothing at all.
  "evil.example",
  "account",
  "",
  null,
  "/",
];

const NEXT_KEPT: readonly (readonly [string, string])[] = [
  // Legitimate same-site paths round-trip byte for byte.
  ["/admin", "/admin"],
  ["/account?x=1#y", "/account?x=1#y"],
  ["/a//b", "/a//b"],
  ["/account?next=%2F%2Fevil.example", "/account?next=%2F%2Fevil.example"],
  ["/login?next=/account", "/login?next=/account"],
];

Deno.test("safeNext rejects every parser rewrite that could supply a host (audio-feed-5w1g5)", () => {
  for (const raw of NEXT_REJECTED) {
    assertEquals(safeNext(raw), "/account", `dropped: ${JSON.stringify(raw)}`);
  }
  for (const [raw, want] of NEXT_KEPT) {
    assertEquals(safeNext(raw), want, `kept: ${JSON.stringify(raw)}`);
  }
});

Deno.test("safeNext's output cannot resolve cross-origin on a second parse (audio-feed-5w1g5)", () => {
  // The href is parsed again by the browser, so the emitted reference — not the raw input —
  // is what decides the host. Every accepted candidate must land back on the same site.
  const site = "https://audio.example.com";
  for (const raw of [...NEXT_REJECTED, ...NEXT_KEPT.map(([raw]) => raw)]) {
    assertEquals(
      new URL(safeNext(raw as string | null), site).origin,
      site,
      `emitted reference escapes: ${JSON.stringify(raw)}`,
    );
  }
});

Deno.test("GET /login drops a percent-encoded parser strip in ?next (audio-feed-5w1g5)", async () => {
  const { fetch } = app();
  // searchParams.get() decodes ONCE, so these reach safeNext as the raw control-character
  // forms above. Each was a live redirect at origin/main@155a3386.
  const payloads = [
    "%2F%09%2Fevil.example",
    "%2F%0A%2Fevil.example",
    "%2F%0D%2Fevil.example",
    "%2F%0A%2F%2Fevil.example",
    "%2F..%2F%2Fevil.example",
    "%2F%2Fevil.example",
    "%2F%5Cevil.example",
  ];
  for (const payload of payloads) {
    const html = await (await get(fetch, `/login?next=${payload}`)).text();
    assert(!html.includes("evil.example"), `dropped: ?next=${payload}`);
    assertStringIncludes(html, jsonForScript("/account"), `falls back: ?next=${payload}`);
  }
  const ok = await (await get(fetch, "/login?next=%2Faccount%3Fx%3D1%23y")).text();
  assertStringIncludes(ok, jsonForScript("/account?x=1#y"), "a legitimate next round-trips");
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

Deno.test(
  "every kit page's markup actually nests its tags, and /account keeps all section.panel inside div.wrap (audio-feed-lma7)",
  async () => {
    const { fetch, stores } = app();
    const admin = await seed(stores, {
      id: "admin-lma7",
      email: "admin@example.com",
      isAdmin: true,
      displayName: "Admin Reader",
    });
    await stores.metadata.putSource(makeSource({ id: "src-1", userId: admin.id, title: "Daily" }));
    await stores.metadata.putEpisode(
      makeEpisode({ id: "ep-1", userId: admin.id, title: "Morning Brief", status: "ready" }),
    );

    const pages: Array<{ label: string; res: Promise<Response> }> = [
      { label: "GET /account", res: get(fetch, "/account", stores, admin.id) },
      {
        label: "GET /account?url=...",
        res: get(fetch, "/account?url=https%3A%2F%2Fexample.com%2Fpost", stores, admin.id),
      },
      { label: "GET /login", res: get(fetch, "/login", stores) },
      { label: "GET /admin", res: get(fetch, "/admin", stores, admin.id) },
      { label: "GET /admin/subscribers", res: get(fetch, "/admin/subscribers", stores, admin.id) },
    ];

    for (const page of pages) {
      const res = await page.res;
      assertEquals(res.status, 200, `${page.label} status`);
      const html = await res.text();
      assertEquals(
        tagNestingProblems(html),
        [],
        `${page.label} must have balanced tag nesting`,
      );
    }

    // Pin the exact /account mobile layout invariant: all 6 section.panel blocks live inside
    // <div class="wrap"> (before its closing </div>), and the shell/account CSS carries the
    // mobile padding and margin rules for .wrap and .panel.
    const accountHtml = await (await get(fetch, "/account", stores, admin.id)).text();
    assertStringIncludes(
      accountHtml,
      `<fieldset class="choices" aria-label="How should it sound?"`,
    );
    assert(
      !accountHtml.includes(`data-minutes="15">Deep dive · ~15 min</button>\n      </div>`),
      "choices fieldset must close with </fieldset>, never </div>",
    );

    const wrapOpenIdx = accountHtml.indexOf('<div class="wrap">');
    const mainCloseIdx = accountHtml.indexOf("</main>");
    assert(wrapOpenIdx > 0 && mainCloseIdx > wrapOpenIdx, "expected .wrap inside <main>");
    const wrapRegion = accountHtml.slice(wrapOpenIdx, mainCloseIdx).trim();
    const panelMatches = [...wrapRegion.matchAll(/<section class="panel(?:\s|")/g)];
    assertEquals(
      panelMatches.length,
      6,
      "all 6 section.panel blocks must sit inside <div class='wrap'>",
    );
    assertEquals(
      tagNestingProblems(wrapRegion),
      [],
      "<div class='wrap'> region must close cleanly around all 6 section.panel blocks",
    );

    // Pin the .wrap and .panel CSS rules that supply mobile viewport gutters and panel spacing.
    assertStringIncludes(
      accountHtml,
      ".wrap { max-inline-size: var(--page); margin-inline: auto; padding: 2rem 1rem 3.5rem; }",
    );
    assertStringIncludes(
      accountHtml,
      ".panel {\n    background: var(--surface); border: 1px solid var(--border);\n    border-radius: var(--radius); padding: 1.25rem 1.25rem 1.35rem; margin-block-end: 1rem;\n  }",
    );
  },
);

Deno.test(
  "sweepStaleProfiles spares a stale-root profile with recent internal file activity and reclaims once activity ages out (audio-feed-upby)",
  async () => {
    const sandbox = await Deno.makeTempDir({ prefix: "upby-sweep-test-" });
    // The fixtures below are built inside `sandbox` by explicit path, so the sweep is aimed at that root as an
    // argument instead of the process-global TMPDIR (audio-feed-oyf3g).
    try {
      const now = Date.now();
      const staleRootTime = new Date(now - STALE_PROFILE_AGE_MS - 10 * 60_000);
      const oldActivityTime = new Date(now - PROFILE_ACTIVITY_AGE_MS - 5 * 60_000);

      // Profile A: root directory is 60m old (> 50m STALE_PROFILE_AGE_MS), but touchProfileActivity
      // refreshed its internal heartbeat 2 minutes ago (< 20m PROFILE_ACTIVITY_AGE_MS).
      const activeProfile = join(sandbox, "audiofeed-active-long-run");
      await Deno.mkdir(join(activeProfile, "Default"), { recursive: true });
      await touchProfileActivity(activeProfile, now - 2 * 60_000);
      await Deno.utime(activeProfile, staleRootTime, staleRootTime);

      // Profile B: root directory is 60m old AND its internal file activity is 25m old (> 20m).
      const dormantProfile = join(sandbox, "audiofeed-dormant-stale");
      const dormantDefault = join(dormantProfile, "Default");
      await Deno.mkdir(dormantDefault, { recursive: true });
      const dormantPrefs = join(dormantDefault, "Preferences");
      await Deno.writeTextFile(dormantPrefs, "{}");
      await Deno.utime(dormantPrefs, oldActivityTime, oldActivityTime);
      await Deno.utime(dormantDefault, staleRootTime, staleRootTime);
      await Deno.utime(dormantProfile, staleRootTime, staleRootTime);

      const activeLatest = await latestProfileActivityMs(activeProfile);
      assertEquals(activeLatest, now - 2 * 60_000);

      const swept = await sweepStaleProfiles(
        now,
        STALE_PROFILE_AGE_MS,
        PROFILE_ACTIVITY_AGE_MS,
        sandbox,
      );
      assertEquals(swept, [dormantProfile]);

      const activeStat = await Deno.stat(activeProfile);
      assert(activeStat.isDirectory, "active long-running profile must be spared");
    } finally {
      await Deno.remove(sandbox, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "withMutationScratch writes MUTANT-MARKER at root and sweepStaleMutationScratch reclaims stale mut* scratch while separating unreadable dirs (audio-feed-6pay)",
  async () => {
    const sandbox = await Deno.makeTempDir({ prefix: "6pay-scratch-test-" });
    // Every path this test builds lives inside `sandbox`, and both the scratch allocation and the sweep are
    // aimed at it explicitly rather than through the process-global TMPDIR (audio-feed-oyf3g).
    try {
      let capturedScratch = "";
      const result = await withMutationScratch("6pay-probe", async (scratchDir) => {
        capturedScratch = scratchDir;
        assert(isMutationScratchDir(scratchDir), "scratchDir must be recognised by MUTANT-MARKER");
        const markerFile = join(scratchDir, MUTANT_MARKER_FILE);
        const markerText = await Deno.readTextFile(markerFile);
        assertStringIncludes(markerText, '"label":"6pay-probe"');
        return 42;
      }, sandbox);
      assertEquals(result, 42);
      const existsAfter = await Deno.stat(capturedScratch).then(() => true).catch(() => false);
      assertEquals(existsAfter, false, "withMutationScratch must remove its scratch dir on exit");

      const now = Date.now();
      const staleTime = new Date(now - STALE_PROFILE_AGE_MS - 10 * 60_000);

      // 1. Stale linked-worktree style mut* directory (.git is a file, as created by `git worktree add`)
      const staleMutWorktree = join(sandbox, "mut-12345-M1");
      await Deno.mkdir(staleMutWorktree, { recursive: true });
      const gitFile = join(staleMutWorktree, ".git");
      await Deno.writeTextFile(gitFile, "gitdir: /tmp/somewhere\n");
      await Deno.utime(gitFile, staleTime, staleTime);
      await Deno.utime(staleMutWorktree, staleTime, staleTime);
      assert(isMutationScratchDir(staleMutWorktree));

      // 2. Stale non-mut checkout WITHOUT MUTANT-MARKER (e.g. a real lane worktree) — must be spared!
      const liveWorktree = join(sandbox, "audio-feed-lane-worktree");
      await Deno.mkdir(liveWorktree, { recursive: true });
      const liveGitFile = join(liveWorktree, ".git");
      await Deno.writeTextFile(liveGitFile, "gitdir: /tmp/lane\n");
      await Deno.utime(liveGitFile, staleTime, staleTime);
      await Deno.utime(liveWorktree, staleTime, staleTime);
      assert(!isMutationScratchDir(liveWorktree));

      const report = await sweepStaleMutationScratch(
        now,
        STALE_PROFILE_AGE_MS,
        PROFILE_ACTIVITY_AGE_MS,
        sandbox,
      );
      assertEquals(report.swept, [staleMutWorktree]);
      assertEquals(report.unreadable, []);
      const liveStillThere = await Deno.stat(liveWorktree).then(() => true).catch(() => false);
      assert(liveStillThere, "non-mutant worktree must never be swept");
    } finally {
      await Deno.remove(sandbox, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "pinQz3xCaptureDeterminism pins canonical origin and feedToken for repeatable /account dialog captures (audio-feed-te4l)",
  () => {
    const sampleProofSource = [
      'import { quantiseEvidencePng } from "./evidence-png.ts";',
      'const config: AppConfig = { port: 0, adminToken: "harness-admin" };',
      'const user = await approveUser(stores.metadata, rawUser.id, "qz3x@example.com/feed");',
      'const OUT = new URL("../docs/evidence/audio-feed-qz3x/", import.meta.url).pathname;',
    ].join("\n");

    const pinned = pinQz3xCaptureDeterminism(sampleProofSource, {
      disableQuantiser: true,
      outDir: "/tmp/te4l-run-1",
    });

    assertStringIncludes(
      pinned,
      `publicBaseUrl: ${JSON.stringify(CANONICAL_PROOF_ORIGIN)}`,
    );
    assertStringIncludes(
      pinned,
      `feedToken: ${JSON.stringify(CANONICAL_QZ3X_FEED_TOKEN)}`,
    );
    assertStringIncludes(
      pinned,
      "const quantiseEvidencePng = async (_path: string, _options?: unknown): Promise<void> => {};",
    );
    assertStringIncludes(
      pinned,
      'const OUT = "/tmp/te4l-run-1";',
    );
  },
);

Deno.test(
  "GET /account updates episode Retry/Regenerate in-place without calling location.reload()",
  async () => {
    const { fetch, stores } = app();
    const me = await seed(stores, { displayName: "Paul", status: "approved" });
    await stores.metadata.putSource(makeSource({ id: "mine", userId: me.id, title: "My Blog" }));
    await stores.metadata.putEpisode(makeEpisode({
      id: "ep-fail-inplace",
      userId: me.id,
      sourceId: "mine",
      title: "Failed Episode",
      status: "failed",
      error: "Gemini timeout",
    }));

    const res = await get(fetch, "/account", stores, me.id);
    assertEquals(res.status, 200);
    const html = await res.text();

    assertStringIncludes(html, 'id="episodesList"');
    assertStringIncludes(html, 'data-episode-id="ep-fail-inplace"');
    assertStringIncludes(html, 'data-episode-status="failed"');
    assertStringIncludes(html, '<span class="ep-phase">');
    assertEquals(/\.innerHTML\s*=/.test(html), false, "no innerHTML assignment on /account");

    const start = html.indexOf('const episodesList = $("episodesList");');
    const end = html.indexOf("scheduleEpisodePoll();", start);
    assert(start > 0 && end > start, "episode in-place handler block must exist");
    const block = html.slice(start, end);
    assert(
      !block.includes("location.reload"),
      "Retry / Regenerate / Retry Failed must update the DOM in-place without location.reload()",
    );
    assertStringIncludes(block, "setRowStatus");
    assertStringIncludes(block, "pollEpisodeStatuses");
  },
);

/** Extract non-speculationrules inline scripts from an HTML document and verify syntax. */
function extractInlineScripts(html: string): string[] {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !m[0].includes('type="speculationrules"'))
    .map((m) => m[1] ?? "");
  for (const body of scripts) {
    new Function(body);
  }
  return scripts;
}

/**
 * Mount the server-rendered `/account` HTML inside a `linkedom` document and run its
 * shipped inline `<script>` against a caller-supplied `fetch` implementation.
 */
function mountAccountScript(
  html: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  opts: { hash?: string; search?: string } = {},
) {
  const scripts = extractInlineScripts(html);
  assert(scripts.length >= 1, "expected inline account script");
  const accountScript = scripts.find((s) => s.includes("briefingForm")) ?? scripts[scripts.length - 1]!;
  const parsed = parseHTML(html);
  const { window: win, document: doc } = parsed;

  let reloadCount = 0;
  let assignedUrl: string | null = null;
  const mockLocation = {
    pathname: "/account",
    search: opts.search ?? "",
    hash: opts.hash ?? "",
    reload: () => {
      reloadCount++;
    },
    assign: (url: string) => {
      assignedUrl = url;
    },
  };
  const mockHistory = {
    replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
      if (typeof url === "string") {
        const hashIdx = url.indexOf("#");
        mockLocation.hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
      }
    },
  };
  // linkedom's HTMLSelectElement exposes a getter-only `.value`; polyfill the standard browser setter.
  const selectProto = win.HTMLSelectElement?.prototype;
  if (selectProto) {
    const desc = Object.getOwnPropertyDescriptor(selectProto, "value");
    if (!desc || !desc.set) {
      Object.defineProperty(selectProto, "value", {
        configurable: true,
        get(this: HTMLSelectElement) {
          const opts = [...this.querySelectorAll("option")];
          const chosen = opts.find((o) => o.hasAttribute("selected")) ?? opts[0];
          return chosen ? chosen.getAttribute("value") ?? chosen.textContent ?? "" : "";
        },
        set(this: HTMLSelectElement, next: string) {
          const target = String(next);
          for (const opt of this.querySelectorAll("option")) {
            const val = opt.getAttribute("value") ?? opt.textContent ?? "";
            if (val === target) opt.setAttribute("selected", "");
            else opt.removeAttribute("selected");
          }
        },
      });
    }
  }
  const optionProto = (win as unknown as { HTMLOptionElement?: { prototype: object } })
    .HTMLOptionElement?.prototype;
  if (optionProto) {
    const selDesc = Object.getOwnPropertyDescriptor(optionProto, "selected");
    if (!selDesc || !selDesc.set) {
      Object.defineProperty(optionProto, "selected", {
        configurable: true,
        get(this: HTMLOptionElement) {
          return this.hasAttribute("selected");
        },
        set(this: HTMLOptionElement, flag: boolean) {
          if (flag) this.setAttribute("selected", "");
          else this.removeAttribute("selected");
        },
      });
    }
  }

  // linkedom's HTMLFormElement.elements may not implement namedItem; shim cleanly if missing.
  const ensureFormElements = (root: Document) => {
    for (const form of root.querySelectorAll("form")) {
      const f = form as unknown as {
        elements?: { namedItem?: (name: string) => Element | null };
        reset?: () => void;
      };
      if (!f.elements || typeof f.elements.namedItem !== "function") {
        Object.defineProperty(form, "elements", {
          configurable: true,
          get: () => ({
            namedItem: (name: string) => form.querySelector(`[name="${name}"]`),
          }),
        });
      }
      if (typeof f.reset !== "function") {
        f.reset = () => {};
      }
    }
  };
  ensureFormElements(doc);

  // Polyfill `importNode` if linkedom's Document returns raw nodes or needs cross-doc clone.
  const origImportNode = typeof doc.importNode === "function" ? doc.importNode.bind(doc) : null;
  if (!origImportNode) {
    (doc as unknown as { importNode: (node: Node, deep?: boolean) => Node }).importNode = (
      node: Node,
      deep?: boolean,
    ) => node.cloneNode(Boolean(deep));
  }

  class MockDOMParser {
    parseFromString(markup: string, _mime: string) {
      return parseHTML(markup).document;
    }
  }

  const timers: Array<ReturnType<typeof setInterval>> = [];
  const trackedSetInterval = (fn: () => void, ms: number) => {
    const id = setInterval(fn, ms);
    timers.push(id);
    return id;
  };

  const runner = new Function(
    "window",
    "document",
    "location",
    "history",
    "fetch",
    "DOMParser",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLFormElement",
    "HTMLSelectElement",
    "HTMLDialogElement",
    "addEventListener",
    "removeEventListener",
    "navigator",
    "setInterval",
    "clearInterval",
    accountScript,
  );

  // linkedom constructs <form> as generic HTMLElement; provide a spec-accurate instanceof check.
  const FormCtor = {
    [Symbol.hasInstance]: (el: unknown) =>
      el instanceof win.HTMLElement && (el as HTMLElement).tagName === "FORM",
  };

  runner(
    win,
    doc,
    mockLocation,
    mockHistory,
    fetchImpl,
    MockDOMParser,
    win.Element,
    win.HTMLElement,
    win.HTMLButtonElement,
    FormCtor,
    win.HTMLSelectElement,
    (win as unknown as { HTMLDialogElement?: unknown }).HTMLDialogElement ?? win.HTMLElement,
    win.addEventListener.bind(win),
    win.removeEventListener.bind(win),
    { clipboard: { writeText: () => Promise.resolve() } },
    trackedSetInterval,
    clearInterval,
  );

  const flush = () => new Promise((r) => setTimeout(r, 25));
  const cleanup = () => {
    for (const id of timers) clearInterval(id);
    timers.length = 0;
  };

  return {
    doc,
    win,
    flush,
    cleanup,
    ensureFormElements: () => ensureFormElements(doc),
    getReloadCount: () => reloadCount,
    getAssignedUrl: () => assignedUrl,
  };
}

Deno.test(
  "GET /account renders Morning Briefing card in Settings tab with server-rendered state, strict CSP, and balanced layout",
  async () => {
    const { fetch, stores } = app();
    const configured = await seed(stores, {
      id: "user-briefing-cfg",
      email: "briefing@example.com",
      status: "approved",
      briefing: {
        schedule: "weekly",
        hourUtc: 14,
        mode: "deepdive",
        maxArticles: 10,
        lastGeneratedDate: "2026-11-23",
      },
    });
    const customMax = await seed(stores, {
      id: "user-briefing-custom",
      email: "custom@example.com",
      status: "approved",
      briefing: {
        schedule: "daily",
        hourUtc: 6,
        mode: "direct",
        maxArticles: 5,
      },
    });
    const pendingUser = await seed(stores, {
      id: "user-briefing-pending",
      email: "pending@example.com",
      status: "pending",
    });

    const res = await get(fetch, "/account?tab=settings", stores, configured.id);
    assertEquals(res.status, 200);
    const html = await res.text();

    // Strict CSP, JS syntax, tag nesting, and exact 6 section.panel layout invariants
    assertEquals(tagNestingProblems(html), [], "/account markup must nest cleanly");
    assert(!/\bstyle\s*=/i.test(html), "zero inline style attributes");
    assertEquals(/\.innerHTML\s*=/.test(html), false, "zero .innerHTML assignments");
    assertEquals(/\son(?:click|change|submit|input)=/i.test(html), false, "zero inline handlers");
    extractInlineScripts(html);

    const wrapRegion = html.slice(html.indexOf('<div class="wrap">'), html.indexOf("</main>"));
    assertEquals(
      [...wrapRegion.matchAll(/<section class="panel(?:\s|")/g)].length,
      6,
      "Morning Briefing card must preserve the exact 6 section.panel layout",
    );

    // Morning Briefing card sits inside Settings tab panel with server-rendered selections
    const settingsStart = html.indexOf('id="panel-settings"');
    assert(settingsStart > 0, "expected Settings tab panel");
    const settingsSlice = html.slice(settingsStart);
    assertStringIncludes(settingsSlice, 'id="briefingCard"');
    assertStringIncludes(settingsSlice, '<h2 id="briefing-h">Morning Briefing</h2>');
    assertStringIncludes(settingsSlice, 'id="briefingForm"');
    assertStringIncludes(settingsSlice, "Weekly (Mon) · 14:00 UTC");
    assertStringIncludes(settingsSlice, "Last briefing generated 2026-11-23.");
    assertStringIncludes(settingsSlice, '<option value="weekly" selected>Weekly (Mondays)</option>');
    assertStringIncludes(settingsSlice, '<option value="14" selected>14:00 UTC</option>');
    assertStringIncludes(settingsSlice, '<option value="0">00:00 UTC</option>');
    assertStringIncludes(settingsSlice, '<option value="23">23:00 UTC</option>');
    assertStringIncludes(
      settingsSlice,
      '<option value="deepdive" selected>Two-host Deep Dive</option>',
    );
    assertStringIncludes(settingsSlice, '<option value="10" selected>10 stories</option>');
    for (const preset of [4, 6, 8, 10, 12]) {
      assertStringIncludes(settingsSlice, `value="${preset}"`);
    }
    assertStringIncludes(settingsSlice, 'id="saveBriefingBtn"');
    assertStringIncludes(settingsSlice, 'id="generateBriefingBtn">Generate briefing now</button>');

    // Non-preset saved maxArticles (5) is preserved in the dropdown
    const customHtml = await (await get(fetch, "/account", stores, customMax.id)).text();
    assertStringIncludes(customHtml, '<option value="5" selected>5 stories</option>');
    assertStringIncludes(customHtml, "Daily · 06:00 UTC");

    // Pending user cannot trigger on-demand briefing synthesis
    const pendingHtml = await (await get(fetch, "/account", stores, pendingUser.id)).text();
    assertStringIncludes(
      pendingHtml,
      'id="generateBriefingBtn" disabled>Generate briefing now</button>',
    );
  },
);

Deno.test(
  "GET /account Morning Briefing UI wires GET/POST /api/account/briefing and /generate in-place with zero reload",
  async () => {
    const { fetch, stores } = app();
    const me = await seed(stores, {
      id: "user-briefing-live",
      email: "live@example.com",
      status: "approved",
    });
    const cookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, me.id)}`;

    // Seed two recent unread articles + episodes so daily briefing has 2 eligible stories
    const nowIso = new Date().toISOString();
    await stores.metadata.putSource(
      makeSource({ id: "tech-src", userId: me.id, title: "Tech Daily" }),
    );
    for (const idx of [1, 2]) {
      await stores.metadata.putArticle(
        makeArticle({
          id: `art-live-${idx}`,
          userId: me.id,
          sourceId: "tech-src",
          url: `https://example.com/story-${idx}`,
          title: `Headline Story ${idx}`,
          content: `Story ${idx} brings major improvements to web standards and performance.`,
          ingestedAt: nowIso,
          publishedAt: nowIso,
        }),
      );
      await stores.metadata.putEpisode(
        makeEpisode({
          id: `ep-live-${idx}`,
          userId: me.id,
          sourceId: "tech-src",
          sourceTitle: "Tech Daily",
          articleId: `art-live-${idx}`,
          title: `Headline Story ${idx}`,
          status: "ready",
          createdAt: nowIso,
        }),
      );
    }

    const pageRes = await get(fetch, "/account", stores, me.id);
    assertEquals(pageRes.status, 200);
    const html = await pageRes.text();

    const calls: Array<{ method: string; path: string }> = [];
    const liveFetch = async (input: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path: input });
      const headers = new Headers(init?.headers ?? {});
      headers.set("cookie", cookie);
      if (method === "GET") {
        headers.set("sec-fetch-site", "same-origin");
      } else {
        headers.set("origin", BASE);
      }
      return await fetch(new Request(`${BASE}${input}`, { method, headers, body: init?.body }));
    };

    const mounted = mountAccountScript(html, liveFetch);
    try {
      const { doc, win, flush } = mounted;

      // 1. Opening Settings tab lazily loads GET /api/account/briefing and shows eligible count
      const settingsTab = doc.getElementById("tab-settings") as HTMLElement;
      settingsTab.dispatchEvent(new win.Event("click", { bubbles: true }));
      await flush();

      assert(
        calls.some((c) => c.method === "GET" && c.path === "/api/account/briefing"),
        "activating Settings tab must fetch GET /api/account/briefing",
      );
      const eligibilityText = doc.getElementById("briefingEligibility")?.textContent ?? "";
      assertStringIncludes(eligibilityText, "2 unread stories eligible in the past 24 hours");

      // 2. Saving briefing preferences hits POST /api/account/briefing with zero page reload
      (doc.getElementById("briefingSchedule") as HTMLSelectElement).value = "daily";
      (doc.getElementById("briefingHour") as HTMLSelectElement).value = "9";
      (doc.getElementById("briefingMode") as HTMLSelectElement).value = "deepdive";
      (doc.getElementById("briefingMaxArticles") as HTMLSelectElement).value = "6";
      doc.getElementById("briefingForm")?.dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
      await flush();

      const updatedUser = await stores.metadata.getUser(me.id);
      assertEquals(updatedUser?.briefing?.schedule, "daily");
      assertEquals(updatedUser?.briefing?.hourUtc, 9);
      assertEquals(updatedUser?.briefing?.mode, "deepdive");
      assertEquals(updatedUser?.briefing?.maxArticles, 6);
      assertEquals(
        doc.getElementById("briefingScheduleBadge")?.textContent,
        "Daily · 09:00 UTC",
      );
      assertStringIncludes(
        doc.getElementById("briefingFeedback")?.textContent ?? "",
        "Briefing settings saved",
      );
      assertEquals(mounted.getReloadCount(), 0, "saving briefing settings must never reload");

      // 3. Clicking "Generate briefing now" hits POST /api/account/briefing/generate -> 202 queued
      //    and refreshes #episodesList in place with the new Morning Briefing episode
      const beforeRows = doc.querySelectorAll("#episodesList li[data-episode-id]").length;
      assertEquals(beforeRows, 2);

      doc.getElementById("generateBriefingBtn")?.dispatchEvent(
        new win.Event("click", { bubbles: true }),
      );
      await flush();
      await flush();

      assertStringIncludes(
        doc.getElementById("briefingFeedback")?.textContent ?? "",
        "Morning briefing queued (2 stories)",
      );
      const afterRows = doc.querySelectorAll("#episodesList li[data-episode-id]");
      assertEquals(afterRows.length, 3, "new Morning Briefing episode must be added in place");
      assertStringIncludes(afterRows[0]?.textContent ?? "", "Morning Briefing");
      assertEquals(mounted.getReloadCount(), 0, "generating briefing must never reload");

      // 4. Clicking "Generate briefing now" again same day handles 200 exists cleanly
      doc.getElementById("generateBriefingBtn")?.dispatchEvent(
        new win.Event("click", { bubbles: true }),
      );
      await flush();

      assertStringIncludes(
        doc.getElementById("briefingFeedback")?.textContent ?? "",
        "already exists",
      );
    } finally {
      mounted.cleanup();
    }

    // 5. Deep-linking via #briefing activates Settings tab without TDZ, loads GET /api/account/briefing,
    //    and handles 200 empty cleanly when no unread articles exist
    const emptyUser = await seed(stores, {
      id: "user-briefing-empty",
      email: "empty@example.com",
      status: "approved",
    });
    const emptyCookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, emptyUser.id)}`;
    const emptyHtml = await (await get(fetch, "/account", stores, emptyUser.id)).text();
    const emptyMounted = mountAccountScript(
      emptyHtml,
      async (input, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers ?? {});
        headers.set("cookie", emptyCookie);
        if (method === "GET") headers.set("sec-fetch-site", "same-origin");
        else headers.set("origin", BASE);
        return await fetch(new Request(`${BASE}${input}`, { method, headers, body: init?.body }));
      },
      { hash: "#briefing" },
    );
    try {
      await emptyMounted.flush();
      assertEquals(
        emptyMounted.doc.getElementById("tab-settings")?.getAttribute("aria-selected"),
        "true",
        "#briefing hash must activate the Settings tab",
      );
      assertStringIncludes(
        emptyMounted.doc.getElementById("briefingEligibility")?.textContent ?? "",
        "0 unread stories eligible",
      );
      emptyMounted.doc.getElementById("generateBriefingBtn")?.dispatchEvent(
        new emptyMounted.win.Event("click", { bubbles: true }),
      );
      await emptyMounted.flush();
      assertStringIncludes(
        emptyMounted.doc.getElementById("briefingFeedback")?.textContent ?? "",
        "No new unread articles found",
      );
    } finally {
      emptyMounted.cleanup();
    }
  },
);

Deno.test(
  "GET /account renders Narration Style selectors across Send URL, Add Feed, prefill, and per-feed prefs",
  async () => {
    const { fetch, stores } = app();
    const me = await seed(stores, {
      id: "user-styles-ui",
      email: "styles@example.com",
      status: "approved",
    });
    await stores.metadata.putSource(
      makeSource({
        id: "src-walkthrough",
        userId: me.id,
        title: "Engineering Blog",
        ...({ narrationStyle: "walkthrough" } as Record<string, unknown>),
      }),
    );
    await stores.metadata.putSource(
      makeSource({
        id: "src-default-style",
        userId: me.id,
        title: "General News",
      }),
    );

    const res = await get(fetch, "/account", stores, me.id);
    assertEquals(res.status, 200);
    const html = await res.text();

    assertEquals(tagNestingProblems(html), [], "/account markup must nest cleanly");
    assert(!/\bstyle\s*=/i.test(html), "zero inline style attributes");
    assertEquals(/\.innerHTML\s*=/.test(html), false, "zero .innerHTML assignments");
    assertEquals(/\son(?:click|change|submit|input)=/i.test(html), false, "zero inline handlers");
    extractInlineScripts(html);

    // Send URL form + Add Feed form + per-feed prefs all carry narrationStyle <select>
    assertStringIncludes(html, 'id="sendNarrationStyle" name="narrationStyle"');
    assertStringIncludes(html, 'id="sourceNarrationStyle" name="narrationStyle"');
    assertStringIncludes(html, 'id="src-style-0" name="narrationStyle"');
    assertStringIncludes(html, 'id="src-style-1" name="narrationStyle"');

    // All three presets render with expected values and labels
    assertStringIncludes(html, '<option value="standard" selected>Full Narration</option>');
    assertStringIncludes(html, '<option value="brief">3-Min Brief</option>');
    assertStringIncludes(html, '<option value="walkthrough">Technical Walkthrough</option>');

    // Source with saved narrationStyle="walkthrough" preselects it and surfaces it in summary
    assertStringIncludes(
      html,
      '<option value="walkthrough" selected>Technical Walkthrough</option>',
    );
    assertStringIncludes(
      html,
      '<span class="source-prefs-meta" data-customized="true">Technical Walkthrough</span>',
    );
    assertStringIncludes(
      html,
      '<span class="source-prefs-meta" data-customized="false">Account defaults</span>',
    );

    // Prefill bookmarklet / share card also renders Narration Style selector
    const prefillHtml = await (
      await get(fetch, "/account?url=https%3A%2F%2Fexample.com%2Fcode-post", stores, me.id)
    ).text();
    assertEquals(tagNestingProblems(prefillHtml), [], "prefill /account markup must nest cleanly");
    assertStringIncludes(prefillHtml, 'id="quickNarrationStyle" name="narrationStyle"');
  },
);

Deno.test(
  "GET /account submits narrationStyle from Send URL, Add Feed, and per-feed prefs with zero reload",
  async () => {
    const { fetch, stores } = app();
    const me = await seed(stores, {
      id: "user-styles-submit",
      email: "styles-submit@example.com",
      status: "approved",
    });
    await stores.metadata.putSource(
      makeSource({ id: "src-1", userId: me.id, title: "Existing Blog", modes: ["direct"] }),
    );

    const html = await (await get(fetch, "/account", stores, me.id)).text();
    const sent: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];

    const mockFetch = async (input: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
      sent.push({ method, path: input, body });

      if (input === "/api/ingest") {
        return Response.json({ article: { title: "Briefed Article" } }, { status: 202 });
      }
      if (input === "/api/account/sources") {
        return Response.json(
          {
            source: {
              id: "src-new",
              title: String(body?.title || "Systems Notes"),
              feedUrl: String(body?.feedUrl || "https://systems.example.com/feed.xml"),
              modes: body?.modes ?? ["direct"],
              narrationStyle: body?.narrationStyle ?? "standard",
            },
            poll: { queued: 0 },
          },
          { status: 201 },
        );
      }
      if (input === "/api/account/sources/src-1/preferences") {
        return Response.json({
          ok: true,
          source: {
            id: "src-1",
            title: "Existing Blog",
            voice: null,
            playbackRate: null,
            modes: ["direct"],
            codeHandling: "skip",
            narrationStyle: body?.narrationStyle ?? "standard",
          },
        });
      }
      if (input.startsWith("/account")) {
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }
      return Response.json({ ok: true });
    };

    const mounted = mountAccountScript(html, mockFetch);
    try {
      const { doc, win, flush } = mounted;

      // 1. Send URL form submits narrationStyle: "brief"
      (doc.getElementById("sendUrl") as HTMLInputElement).value = "https://example.com/long-essay";
      (doc.getElementById("sendNarrationStyle") as HTMLSelectElement).value = "brief";
      doc.getElementById("sendForm")?.dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
      await flush();

      const ingestReq = sent.find((r) => r.path === "/api/ingest");
      assert(ingestReq, "Send URL form must POST /api/ingest");
      assertEquals(ingestReq.body?.narrationStyle, "brief");
      assertEquals(ingestReq.body?.url, "https://example.com/long-essay");

      // 2. Add Feed form submits narrationStyle: "walkthrough" and creates dynamic feed card with zero reload
      (doc.getElementById("sourceUrl") as HTMLInputElement).value =
        "https://systems.example.com/feed.xml";
      (doc.getElementById("sourceTitle") as HTMLInputElement).value = "Systems Notes";
      (doc.getElementById("sourceNarrationStyle") as HTMLSelectElement).value = "walkthrough";
      doc.getElementById("addSourceForm")?.dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
      await flush();

      const addReq = sent.find((r) => r.path === "/api/account/sources");
      assert(addReq, "Add Feed form must POST /api/account/sources");
      assertEquals(addReq.body?.narrationStyle, "walkthrough");

      const dynamicRow = doc.querySelector('#sourcesList li[data-source-id="src-new"]');
      assert(dynamicRow, "Add Feed must insert the new source card dynamically without reload");
      const dynamicStyleSelect = dynamicRow.querySelector(
        'select[name="narrationStyle"]',
      ) as HTMLSelectElement | null;
      assert(dynamicStyleSelect, "dynamic source card must include narrationStyle dropdown");
      assertEquals(dynamicStyleSelect.value, "walkthrough");
      assertEquals(
        dynamicRow.querySelector(".source-prefs-meta")?.textContent,
        "Technical Walkthrough",
      );
      assertEquals(mounted.getReloadCount(), 0, "adding a feed must not reload the page");

      // 3. Per-feed <details class="source-prefs"> submits narrationStyle: "brief" with zero reload
      const prefsForm = doc.querySelector('form[data-source-prefs="src-1"]') as HTMLFormElement;
      const prefsStyle = prefsForm.querySelector(
        'select[name="narrationStyle"]',
      ) as HTMLSelectElement;
      prefsStyle.value = "brief";
      prefsForm.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      await flush();

      const prefsReq = sent.find((r) => r.path === "/api/account/sources/src-1/preferences");
      assert(prefsReq, "source-prefs form must POST /api/account/sources/:sourceId/preferences");
      assertEquals(prefsReq.body?.narrationStyle, "brief");
      const existingRow = doc.querySelector('#sourcesList li[data-source-id="src-1"]');
      assertStringIncludes(
        existingRow?.querySelector(".source-prefs-meta")?.textContent ?? "",
        "3-Min Brief",
      );
      assertEquals(
        existingRow?.querySelector(".source-prefs-feedback")?.textContent,
        "Saved.",
      );
      assertEquals(mounted.getReloadCount(), 0, "saving source prefs must not reload the page");
    } finally {
      mounted.cleanup();
    }
  },
);
