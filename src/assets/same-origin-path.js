/**
 * The client-side same-origin path guard — the single canonical copy (audio-feed-fg18i).
 *
 * Three browser wrappers forward a CALLER-supplied path into `fetch()`: `api(path, options)` in
 * src/assets/admin.js, `send(method, path, body)` in src/routes/account.ts and `post(path, body)`
 * in PASSKEY_CLIENT (src/routes/shell.ts). THREAT_MODEL.md register row 6 states the constraint
 * their call sites had to satisfy and, until this file, that nothing enforced it: a path that does
 * not begin with a single "/" resolves somewhere other than this origin, and the wrapper would
 * issue that request from the page.
 *
 * WHY a single leading "/" is not enough — fetch() resolves its first argument against the document
 * URL, so the SHAPE of the string decides the origin, not the presence of a slash:
 *
 *   - `evil.example/x` and `../x` resolve RELATIVE to the current page;
 *   - `//evil.example/x` is a network-path reference: a different host on the same scheme;
 *   - `/\evil.example/x` is that same escape spelled with a backslash, because the URL parser
 *     treats "\" as "/" for http(s) — a guard that only tests `startsWith("/")` and
 *     `startsWith("//")` lets this one through;
 *   - `/<TAB>/evil.example/x` is it again: ASCII tabs and newlines are DELETED anywhere in a URL
 *     during parsing, so the control character turns `/<TAB>/` into `//`.
 *
 * Hence: exactly one leading slash, and none of the characters the parser deletes or normalises
 * into a separator. Anything else throws — a caller-supplied host inside a browser wrapper is a
 * defect to fix at the call site, not a request to send.
 *
 * HOW this file reaches the three wrappers. src/routes/assets.ts composes it in front of
 * src/assets/admin.js for the console module; src/routes/shell.ts slices the marked region below and
 * the login and account pages embed it inline. Both splices exist because the wrappers live in
 * different scripts (an ES module, and classic inline scripts). One source, three surfaces.
 *
 * WHY the attack shapes are spelled out up here and not in the region: the region is what ships
 * inline on a page, and a page carrying the literal string `//evil.example/x` in a comment reddens
 * the open-redirect tests that assert no attacker-shaped host reaches rendered HTML
 * (tests/account_pages_test.ts, audio-feed-8fc / audio-feed-5w1g5). Documentation stays outside the
 * bytes a page hands to a browser.
 *
 * Constraints the region must keep: plain script (no import/export — it ships inside a classic
 * <script> on the login and account pages), self-contained (no DOM globals), bracketed by the two
 * #same-origin-path marker lines as whole lines (shell.ts slices between them at module load and
 * throws if they are broken), and the function published on globalThis for code composed AFTER it,
 * because inside the composed console MODULE a top-level declaration is module-scoped and
 * src/assets/admin.js cannot see it otherwise (the contract src/assets/confirm-shared.js uses for
 * askConfirm).
 */
// @ts-check

// #same-origin-path-begin
/**
 * The path a client wrapper may forward to `fetch()`, or a thrown Error.
 *
 * Refused: a non-string; a path whose first character is not "/" (relative to the page); a path
 * whose second is "/" (a network-path reference to another host); and any path carrying a character
 * the URL parser deletes or turns into a separator. The file-level comment above spells out why each
 * of those leaves this origin.
 *
 * @param {string} path
 * @returns {string} the same path, when it is a same-origin absolute route
 */
function assertSameOriginPath(path) {
  const escapes = typeof path !== "string" ||
    path.charAt(0) !== "/" ||
    path.charAt(1) === "/" ||
    hasUrlNormalisedCharacter(path);
  if (escapes) {
    throw new Error(
      "refusing a client path that is not a single-slash same-origin route: " +
        JSON.stringify(path),
    );
  }
  return path;
}

/**
 * Whether the string carries a character URL parsing DELETES or turns into a path separator: "\"
 * (a separator for http(s), so "//" and "/\" are the same reference) and the ASCII control
 * characters (tabs and newlines are removed anywhere in a URL; the rest are stripped or encoded).
 * Spelled as a scan rather than a character class — `/\u0000-\u001f/` is a control-character regex,
 * which `deno lint`'s no-control-regex rule refuses, and it is easier to see what is refused here.
 * @param {string} path
 * @returns {boolean}
 */
function hasUrlNormalisedCharacter(path) {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code === 0x5c || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// Publish for code composed AFTER this region (src/assets/admin.js binds to it through globalThis).
// Inside a classic script block the function declaration is already a global; inside the composed
// console module it is module-scoped.
/** @type {any} */ (globalThis).assertSameOriginPath = assertSameOriginPath;
// #same-origin-path-end
