/**
 * The bookmarklet, in ONE place (audio-feed-6hw).
 *
 * It was written out twice — `src/routes/home.ts` and `src/routes/account.ts` —
 * with the same narrow selector, so widening one page would have left the other
 * behind (the y5k failure: two places computing the same answer). The shapes
 * themselves live in `src/ingest/url.ts` next to `discoverFeeds`, because the
 * bookmarklet and server-side discovery must agree about what a feed link looks
 * like: a shape one of them knows and the other does not is how a person ends up
 * on the account page with no feed at all.
 */
import { FEED_ANCHOR_SELECTOR, FEED_LINK_SELECTOR } from "../ingest/url.ts";

/**
 * Encodes a string as a safe single-quoted JavaScript string literal.
 *
 * Covers:
 * - Backslash (\) -> \\
 * - Single quote (') -> \'
 * - Carriage return (\r) -> \r
 * - Newline (\n) -> \n
 * - Line separator (\u2028) -> \u2028
 * - Paragraph separator (\u2029) -> \u2029
 * - HTML-sensitive characters: '<' -> \u003c, '>' -> \u003e so that strings containing
 *   `</script>` or `<script>` cannot terminate an enclosing HTML script context if
 *   embedded inside HTML markup.
 *
 * Why both JS escaping and HTML escaping (`esc()`) are needed:
 * The bookmarklet is a JavaScript snippet embedded inside HTML attributes
 * (`href="..."`) and elements (`<code>...</code>`).
 * 1. JS escaping (here) guards the JavaScript syntax context: hostile values
 *    interpolated into the script cannot terminate the JS string literal or
 *    break out into executable JS statements when evaluated by the browser.
 *    It also escapes '<' as \u003c so that payloads like `</script>` cannot
 *    prematurely close an enclosing `<script>` element if embedded in HTML markup.
 * 2. HTML escaping (`esc()`) guards the HTML markup context: it encodes characters
 *    like '"', '&', '<', '>' into HTML entities so the resulting `javascript:...`
 *    URL cannot break out of the HTML attribute or markup wrapper.
 * Neither replaces the other: without JS escaping, single quotes terminate JS strings;
 * without HTML escaping, double quotes break out of HTML attributes.
 */
export function jsStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `'${escaped}'`;
}

/**
 * The draggable bookmarklet's href. The link[rel=alternate] shape WINS over an
 * anchor even when the anchor appears first in the document: the declared feed is
 * the publication's own answer, the anchor is a guess.
 *
 * Every interpolated site inside the JavaScript body is encoded as a JS string
 * literal via `jsStringLiteral` so that hostile inputs cannot terminate the
 * string literal or execute injected statements.
 */
export function bookmarkletHref(
  baseUrl: string,
  feedLinkSelector: string = FEED_LINK_SELECTOR,
  feedAnchorSelector: string = FEED_ANCHOR_SELECTOR,
): string {
  const linkSel = jsStringLiteral(feedLinkSelector);
  const anchorSel = jsStringLiteral(feedAnchorSelector);
  const destPrefix = jsStringLiteral(`${baseUrl}/account?add=`);

  return `javascript:(function(){var u=location.href,t=document.title||'',l=document.querySelector(${linkSel})||document.querySelector(${anchorSel}),f=l?(l.href||l.getAttribute('href')||''):'',dest=${destPrefix}+encodeURIComponent(u)+'&title='+encodeURIComponent(t)+(f?'&feed='+encodeURIComponent(f):'');window.open(dest,'_blank')||(location.href=dest);})();`;
}
