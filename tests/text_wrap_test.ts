// audio-feed-x55k ([modern-web] improve-text-layout-and-legibility): admin was the only
// stylesheet whose headings never opted into balanced wrapping — home.css sets
// `h1, h2, h3 { text-wrap: balance }` and listen.css sets it on h1, so an admin heading like
// "Daily episode budget (optional)" could wrap with a lone orphaned word while the rest of
// the product balanced. Body paragraphs get `pretty` instead of `balance`: they are
// multi-line prose, where balance's equal-line length work buys nothing and pretty's job
// (no single-word last line) is the actual goal. Both values are Baseline Widely Available
// (canonical feature id: text-wrap) and degrade to today's wrapping on engines without
// support — no fallback, so no TODO(baseline/text-wrap).
//
// The assertions read the CSS out of the RENDERED PAGE (shippedCss: inline style plus every
// linked asset, resolved), the same lesson field_sizing_test.ts records: a rule in a module
// the page does not link is a green test that does nothing.
//
// audio-feed-yi6na: there are TWO rows per declaration here, and they answer different
// questions. The string rows assert the sheet DECLARES the rule — they still catch a rule
// deleted from admin.css, which no probe of a named declaration can see. The engine row asks
// headless Chrome whether `text-wrap: balance` / `pretty` are ACCEPTED values and whether the
// computed `text-wrap` on a real h1/h3/p is what the rule says: a misspelled value
// (`balanc`) or a later cascade rule that wins is invisible to the string rows and reds the
// engine row. Neither row is a substitute for the other, and neither was replaced.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { shippedCss } from "./admin_css.ts";
import { browserRowIgnored, computedKey, readCssInChrome, supportsKey } from "./css_engine.ts";

const adminHtml = renderAdminPage({
  nonce: "test-nonce",
  publicBaseUrl: "https://example.com",
  adminConfigured: true,
  viewer: { displayName: "Paul Kinlan", email: "paul@example.com", isAdmin: true },
});

/** One space per run of whitespace, so selector/declaration formatting does not matter. */
const adminCss = shippedCss(adminHtml).replace(/\s+/g, " ");

Deno.test("the admin sheet DECLARES balanced headings (presence, not validity)", () => {
  assertStringIncludes(
    adminCss,
    "h1, h2, h3 { text-wrap: balance; }",
    "h3 was never listed before, so admin h3s could not opt in even in principle; this row " +
      "asserts the declaration is WRITTEN, not that the engine accepts it (the engine row below)",
  );
});

Deno.test("the admin sheet DECLARES pretty body prose (presence, not validity)", () => {
  assertStringIncludes(
    adminCss,
    "p { max-inline-size: var(--measure); text-wrap: pretty; }",
    "body prose wants no single-word last line, not equal line lengths; this row asserts the " +
      "declaration is WRITTEN, not that the engine accepts it (the engine row below)",
  );
});

Deno.test({
  name: "admin headings and prose get text-wrap from the ENGINE, on the element (audio-feed-yi6na)",
  ignore: browserRowIgnored,
  async fn() {
    const reading = await readCssInChrome({
      css: shippedCss(adminHtml),
      body: "<h1>Daily episode budget</h1><h3>Optional</h3><p>Body prose that wraps.</p>",
      declarations: [
        { property: "text-wrap", value: "balance" },
        { property: "text-wrap", value: "pretty" },
      ],
      probes: [
        { selector: "h1", property: "text-wrap" },
        { selector: "h3", property: "text-wrap" },
        { selector: "p", property: "text-wrap" },
      ],
    });

    // (1) The engine ACCEPTS both values. `text-wrap: balanc` is dropped at parse time and
    // reds here while every string row above stays green.
    assertEquals(
      reading.supports[supportsKey("text-wrap", "balance")],
      true,
      "Chrome must accept text-wrap: balance - an unknown value is dropped, not corrected",
    );
    assertEquals(
      reading.supports[supportsKey("text-wrap", "pretty")],
      true,
      "Chrome must accept text-wrap: pretty",
    );

    // (2) The declaration APPLIES to the element the user reads, not just to the sheet.
    assertEquals(
      reading.computed[computedKey("h1", "text-wrap")],
      "balance",
      "a rendered h1 must compute text-wrap: balance (an unapplied declaration computes the " +
        "initial value, wrap)",
    );
    assertEquals(
      reading.computed[computedKey("h3", "text-wrap")],
      "balance",
      "h3 must be covered too - it is the heading admin actually renders in cards",
    );
    assertEquals(
      reading.computed[computedKey("p", "text-wrap")],
      "pretty",
      "body prose must compute pretty, not balance",
    );
  },
});
