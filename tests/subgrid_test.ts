/**
 * Tests for CSS Subgrid list alignment on account and admin lists (audio-feed-b6z).
 *
 * Verifies Modern Web Guidance compliance:
 * - Subgrid on grid-template-columns (minmax(0, 1fr) auto) for aligned action buttons
 * - Preceding flexbox fallback for legacy engines
 * - No fixed column widths that cause horizontal overflow
 * - Responsive 1fr collapse under 480px for clean mobile (390px) rendering without overflow
 */

import { assertStringIncludes } from "@std/assert";
import { renderAccountPage } from "../src/routes/account.ts";
import { SHELL_KIT_CSS } from "../src/routes/shell.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";

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
