/**
 * Tests for CSS Subgrid list alignment on account and admin lists (audio-feed-b6z).
 *
 * Verifies Modern Web Guidance compliance:
 * - Subgrid on grid-template-columns (minmax(0, 1fr) auto) for aligned action buttons
 * - Preceding flexbox fallback for legacy engines
 * - No fixed column widths that cause horizontal overflow
 * - Responsive 1fr collapse under 480px for clean mobile (390px) rendering without overflow
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderAccountPage } from "../src/routes/account.ts";
import { SHELL_KIT_CSS } from "../src/routes/shell.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { browserRowIgnored, computedKey, readCssInChrome, supportsKey } from "./css_engine.ts";

Deno.test("SHELL_KIT_CSS: defines CSS Subgrid rules and fallback for .rows (audio-feed-b6z)", () => {
  // Preceding flexbox fallback
  assertStringIncludes(SHELL_KIT_CSS, ".row-head { display: flex; flex-wrap: wrap;");

  // @supports (grid-template-columns: subgrid) enhancement
  assertStringIncludes(SHELL_KIT_CSS, "@supports (grid-template-columns: subgrid)");
  assertStringIncludes(SHELL_KIT_CSS, "grid-template-columns: minmax(0, 1fr) auto;");
  assertStringIncludes(SHELL_KIT_CSS, "grid-template-columns: subgrid;");

  // Mobile 480px collapse to prevent 390px horizontal overflow
  assertStringIncludes(SHELL_KIT_CSS, "@media (max-width: 480px)");
  assertStringIncludes(SHELL_KIT_CSS, "grid-template-columns: 1fr;");
});

Deno.test("renderAccountPage: renders .rows list items compatible with subgrid columns (audio-feed-b6z)", () => {
  const user = makeUser({ id: "user-1", email: "test@example.com" });
  const source = makeSource({ id: "src-1", userId: "user-1", title: "My Long Feed Source Title" });
  const episode = makeEpisode({
    id: "ep-1",
    userId: "user-1",
    title: "An Interesting Episode Title",
  });

  const html = renderAccountPage({
    nonce: "test-nonce",
    user,
    baseUrl: "https://audio.example.com",
    rpId: "audio.example.com",
    sources: [source],
    credentials: [],
    episodes: [episode],
    outdatedCount: 0,
    failedCount: 0,
    prefill: null,
  });

  // Verify list structure matches subgrid expectation
  assertStringIncludes(html, '<ul class="rows">');
  assertStringIncludes(html, '<div class="row-head">');
  assertStringIncludes(html, '<span class="row-title">');
  assertStringIncludes(html, '<div class="meta">');

  // Verify subgrid CSS is present in the rendered document head
  assertStringIncludes(html, "@supports (grid-template-columns: subgrid)");
});

/**
 * audio-feed-yi6na: both rows above match TEXT in SHELL_KIT_CSS. `grid-template-columns:
 * subgrid` is exactly the declaration a text match cannot vouch for: if the engine does not
 * accept the value, the whole `@supports (grid-template-columns: subgrid)` block is SKIPPED -
 * the text stays in the sheet, the string rows stay green, and every list renders in the
 * flexbox fallback with unaligned action buttons. This row asks Chrome whether it accepts
 * `subgrid` and whether the list items actually compute it.
 */
Deno.test({
  name:
    "subgrid: the engine accepts grid-template-columns: subgrid and the list computes it (audio-feed-yi6na)",
  ignore: browserRowIgnored,
  async fn() {
    const reading = await readCssInChrome({
      css: SHELL_KIT_CSS,
      body: '<ul class="rows"><li><div class="row-head"><span class="row-title">T</span>' +
        '<span class="meta">m</span></div></li></ul>',
      declarations: [{ property: "grid-template-columns", value: "subgrid" }],
      probes: [
        { selector: ".rows", property: "display" },
        { selector: ".rows > li", property: "grid-template-columns" },
        { selector: ".rows > li > .row-head", property: "grid-template-columns" },
      ],
    });

    // (1) The guard's condition is TRUE in this engine. A misspelled value (`subgrjd`) makes
    // this false and skips the whole @supports block, which is invisible to a text match.
    assertEquals(
      reading.supports[supportsKey("grid-template-columns", "subgrid")],
      true,
      "Chrome must accept grid-template-columns: subgrid, or the @supports block never applies",
    );

    // (2) The guard APPLIED: .rows is the grid from inside the block, not the default block
    // display of a <ul>. Without this the two computed values below could not be subgrid.
    assertEquals(
      reading.computed[computedKey(".rows", "display")],
      "grid",
      "the @supports block must apply: .rows computes display: grid only inside it",
    );

    // (3) Both the row and its head inherit the parent's tracks rather than sizing their own.
    // `?? ""` keeps a missing reading on the failing side of the assertion: an absent computed
    // value reads as "did not subgrid", never as a type error that hides the rule's verdict.
    assertEquals(
      reading.computed[computedKey(".rows > li", "grid-template-columns")]?.startsWith("subgrid"),
      true,
      "a row must compute grid-template-columns: subgrid (the parent's tracks), not its own",
    );
    assertEquals(
      reading.computed[computedKey(".rows > li > .row-head", "grid-template-columns")]
        ?.startsWith("subgrid"),
      true,
      "the row head must subgrid too, or the title/action columns cannot align across rows",
    );
  },
});
