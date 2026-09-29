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
 * The draggable bookmarklet's href. The link[rel=alternate] shape WINS over an
 * anchor even when the anchor appears first in the document: the declared feed is
 * the publication's own answer, the anchor is a guess.
 */
export function bookmarkletHref(baseUrl: string): string {
  return `javascript:(function(){var u=location.href,t=document.title||'',l=document.querySelector('${FEED_LINK_SELECTOR}')||document.querySelector('${FEED_ANCHOR_SELECTOR}'),f=l?(l.href||l.getAttribute('href')||''):'',dest='${baseUrl}/account?add='+encodeURIComponent(u)+'&title='+encodeURIComponent(t)+(f?'&feed='+encodeURIComponent(f):'');window.open(dest,'_blank')||(location.href=dest);})();`;
}
