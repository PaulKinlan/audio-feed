// audio-feed-u54 (option B): two short-value admin fields grow to their content; everything else stays
// full width.
//
// These tests read the CSS out of the RENDERED PAGE, not out of an exported constant. That distinction
// is the whole point: an earlier revision put the rule in shell.ts's SHELL_KIT_CSS, which
// renderAdminPage does not inline — the class landed on the inputs, the rule never reached the page, and
// a test that asserted against SHELL_KIT_CSS would have gone green on a change that did nothing. Assert
// that a declaration exists is not the same as asserting it applies.
//
// The same trap set the scope: the original request was `field-sizing: content` on inputs already under
// `inline-size: 100%`. field-sizing governs *intrinsic* sizing only, so with a specified inline-size it
// is inert — measured at 1224px before typing and 1224px after. So this file asserts inline-size is
// released, the Chrome-only property is guarded, and only the two agreed fields opt in.
import { assertEquals } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { shippedCss } from "./admin_css.ts";

const adminHtml = renderAdminPage({
  nonce: "test-nonce",
  publicBaseUrl: "https://example.com",
  adminConfigured: true,
  viewer: { displayName: "Paul Kinlan", email: "paul@example.com", isAdmin: true },
});

/** The stylesheet the admin page actually ships: inline <style> plus every linked asset, resolved. */
const adminCss = shippedCss(adminHtml);

/** Body of the @supports guard that carries the .field-auto rule, or null if it is absent/unguarded. */
function guardedRule(css: string): string | null {
  const m = css.match(/@supports \(field-sizing: content\)\s*\{([\s\S]*?)\n\s*\}/);
  const body = m?.[1];
  if (body === undefined) return null;
  return body.includes(".field-auto") ? body : null;
}

Deno.test("the field-auto rule reaches the rendered admin page", () => {
  // This is the assertion that would have caught the shell.ts placement mistake: the rule must reach the
  // page, not merely sit in some module the page does not import. Since 3xq moved admin CSS into a
  // linked asset, "reaches the page" means inline style OR a resolved link — hence shippedCss().
  assertEquals(
    adminCss.includes(".field-auto"),
    true,
    ".field-auto must appear in the CSS renderAdminPage actually inlines",
  );
});

Deno.test("field-auto releases inline-size, which is what makes field-sizing do anything", () => {
  const body = guardedRule(adminCss);
  assertEquals(body !== null, true, "the rule must sit inside @supports (field-sizing: content)");
  // Not just "field-sizing is present" — that passes on a no-op rule.
  assertEquals(
    /inline-size:\s*auto/.test(body!),
    true,
    "inline-size must be released to auto; with 100% the property is inert",
  );
  assertEquals(/field-sizing:\s*content/.test(body!), true);
  // Bounds: a floor so an empty field is still clickable, a ceiling so a long value cannot overflow.
  assertEquals(
    /min-inline-size:\s*\d+ch/.test(body!),
    true,
    "needs a ch floor for the empty state",
  );
  assertEquals(
    /max-inline-size:\s*100%/.test(body!),
    true,
    "needs a 100% ceiling to avoid overflow",
  );
});

Deno.test("the guard keeps Safari and Firefox on today's full-width fields", () => {
  // Without field-sizing support the rule must not apply at all: `inline-size: auto` alone falls back to
  // the browser's intrinsic input width (~185px measured), narrower than the 100% most users get now.
  assertEquals(
    adminCss.includes("@supports (field-sizing: content)"),
    true,
    "unguarded field-sizing would regress non-Chrome widths",
  );
  // And the page-wide default that makes everything else full width is untouched.
  assertEquals(
    /input,\s*select\s*\{[\s\S]*?inline-size:\s*100%/.test(adminCss),
    true,
    "the shared full-width rule must still be there",
  );
});

Deno.test("only the two agreed short-value fields opt in", () => {
  const withClass = [...adminHtml.matchAll(/<input[^>]*class="[^"]*field-auto[^"]*"[^>]*>/g)]
    .map((m) => (m[0].match(/id="([^"]+)"/) ?? [])[1])
    .filter((v): v is string => typeof v === "string");
  assertEquals(
    withClass.sort(),
    ["displayName", "newDailyBudget"],
    "auto-grow is scoped to the two fields agreed in review",
  );

  // The fields that must keep full width: secrets, addresses, and anything free-form.
  for (const type of ["password", "email", "search", "url"]) {
    assertEquals(
      new RegExp(
        `<input[^>]*type="${type}"[^>]*class="[^"]*field-auto|<input[^>]*class="[^"]*field-auto[^>]*type="${type}"`,
      )
        .test(adminHtml),
      false,
      `${type} inputs must stay full width`,
    );
  }
});
