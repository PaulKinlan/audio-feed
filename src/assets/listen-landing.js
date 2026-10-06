/**
 * audio-feed-3xq part 4c — the listen landing page's client, extracted from renderListenLanding's
 * inline <script> in src/routes/listen.ts. One job: get a returning listener to their player.
 * A stored token means a straight redirect; otherwise the form accepts a full feed URL or a bare
 * token, because both are what people have in hand.
 *
 * `// @ts-check` plus `/// <reference lib="dom" />` is what makes this file visible to the gate;
 * src/routes/assets.ts imports it as text and serves it verbatim at
 * /assets/<hash>.listen-landing.js, so: plain ESM, no TypeScript syntax, no build step.
 */
// @ts-check
/// <reference lib="dom" />

/**
 * The landing always renders these three elements (renderListenLanding in src/routes/listen.ts);
 * a missing one is a deployment bug, and saying so loudly beats a TypeError three lines later.
 * @param {string} id
 */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`listen landing is missing #${id} — page and client are out of sync`);
  return el;
}

const status = $("status");
const input = /** @type {HTMLInputElement} */ ($("feedUrl"));

const stored = (() => {
  try {
    return localStorage.getItem("audio-feed-token");
  } catch {
    return null;
  }
})();

if (stored) {
  // Reopening from the home screen: straight to the player.
  location.replace("/listen/" + encodeURIComponent(stored));
} else {
  /** Accepts a full feed URL or a bare token, because both are what people have. */
  const tokenFrom = (/** @type {string} */ value) => {
    const trimmed = value.trim();
    const captured = trimmed.match(/\/feed\/([^/]+)\//)?.[1];
    return captured ? decodeURIComponent(captured) : trimmed;
  };
  $("restore").addEventListener("submit", (event) => {
    event.preventDefault();
    const token = tokenFrom(input.value);
    if (!token) {
      status.dataset.tone = "error";
      status.textContent = "Paste your feed URL or token first.";
      input.focus();
      return;
    }
    delete status.dataset.tone;
    status.textContent = "Opening…";
    location.assign("/listen/" + encodeURIComponent(token));
  });
}
