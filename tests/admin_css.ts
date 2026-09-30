/**
 * The CSS an admin page actually delivers to a browser: the inline shell <style> plus every linked
 * asset, resolved through the same route the browser would use (audio-feed-3xq part 3).
 *
 * Before the extraction, slicing the <style> element out of the HTML was the whole answer — and it was
 * the right test, because it caught a rule placed in a module the page never inlined. After the
 * extraction that read silently returns less than the browser gets, which is how a CSS move could
 * "pass" while the page lost its styling. Resolving the links keeps the original property: assert on
 * what reaches the browser, not on where the source happens to live.
 */
import { assetBody } from "../src/routes/assets.ts";

export function shippedCss(html: string): string {
  let css = "";
  for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) css += m[1] ?? "";
  for (const m of html.matchAll(/<link rel="stylesheet" href="(\/assets\/[^"]+)">/g)) {
    const segments = (m[1] ?? "").slice("/assets/".length);
    const dot = segments.indexOf(".");
    const name = dot > 0 ? segments.slice(dot + 1) : "";
    const body = assetBody(name);
    if (body === null) {
      throw new Error(`page links an asset the server does not have: ${m[1]}`);
    }
    css += "\n" + body;
  }
  return css;
}
