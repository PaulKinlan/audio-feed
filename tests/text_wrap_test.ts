// audio-feed-x55k ([modern-web] improve-text-layout-and-legibility): admin was the only
// stylesheet whose headings never opted into balanced wrapping — home.css sets
// `h1, h2, h3 { text-wrap: balance }` and listen.css sets it on h1, so an admin heading like
// "Daily episode budget (optional)" could wrap with a lone orphaned word while the rest of
// the product balanced. Body paragraphs get `pretty` instead of `balance`: they are
// multi-line prose, where balance's equal-line-length work buys nothing and pretty's job
// (no single-word last line) is the actual goal. Both values are Baseline Widely Available
// (canonical feature id: text-wrap) and degrade to today's wrapping on engines without
// support — no fallback, so no TODO(baseline/text-wrap).
//
// The assertions read the CSS out of the RENDERED PAGE (shippedCss: inline style plus every
// linked asset, resolved), the same lesson field_sizing_test.ts records: a rule in a module
// the page does not link is a green test that does nothing.
import { assertStringIncludes } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { shippedCss } from "./admin_css.ts";

const adminHtml = renderAdminPage({
  publicBaseUrl: "https://example.com",
  adminConfigured: true,
  viewer: { displayName: "Paul Kinlan", email: "paul@example.com", isAdmin: true },
});

/** One space per run of whitespace, so selector/declaration formatting does not matter. */
const adminCss = shippedCss(adminHtml).replace(/\s+/g, " ");

Deno.test("admin headings wrap balanced, like the rest of the product", () => {
  assertStringIncludes(
    adminCss,
    "h1, h2, h3 { text-wrap: balance; }",
    "h3 was never listed before, so admin h3s could not opt in even in principle",
  );
});

Deno.test("admin body paragraphs wrap pretty rather than balanced", () => {
  assertStringIncludes(
    adminCss,
    "p { max-inline-size: var(--measure); text-wrap: pretty; }",
    "body prose wants no single-word last line, not equal line lengths",
  );
});
