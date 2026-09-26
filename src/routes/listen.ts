/**
 * The listener web app at `GET /listen/:token` (audio-feed-4xb, redesigned under
 * audio-feed-rqp).
 *
 * Paul's original directive: "a visual UI that represents the actual feed the
 * user's gone to ... embedded audio elements ... a service worker version and
 * background downloads ... its own mini podcast web app that the user can install
 * and add to home screen ... fronted by that user feed so we don't need a user
 * sign in, they can just sign in with their token".
 *
 * Then, on seeing it: "the UI looks garbage ... do a design pass" (audio-feed-rqp).
 *
 * WHAT THE REDESIGN FIXES, and why each one is a defect rather than a taste call:
 *
 * - audio-feed-cl5: at 390px the transport row measured 523px wide inside a 363px
 *   container, putting the speed control 147px past the viewport on a FIXED bar the
 *   document cannot scroll. The control was unreachable on a phone — the device
 *   this app exists for. The cause was a `display: grid` track sizing to the row's
 *   max-content; `min-width: 0` on the row measured as a NO-OP, and only
 *   `grid-template-columns: minmax(0, 1fr)` fixed it. That constraint is now
 *   declared on the dock, and the scrubber has its own row so the controls have
 *   room regardless.
 * - Transport icons were the unicode glyphs U+25B6 and U+23F8. Those render as
 *   different shapes, weights and baselines per platform, and one of them is an
 *   emoji on several. They are now drawn SVG on a single 24px grid.
 * - The now-playing title was clipped with no way to read it.
 *
 * MODE: this is an Operate surface. The subscriber came to listen, not to admire
 * the page, so scanability and reach beat expression; the character lives in the
 * type scale, the mode treatment and the dock, not in decoration.
 *
 * TYPEFACE, stated plainly rather than hidden: this app has no static-asset
 * pipeline (every page is a route — see pwa.ts), so self-hosting a display face
 * means embedding base64 font bytes in TypeScript source, and a CDN link would
 * break the offline-first promise this page makes. The system stack is therefore
 * a constraint of the architecture, not a default I reached for, and it is tuned
 * rather than merely declared.
 *
 * Interpretations from 4xb that still hold:
 *
 * - ONE shared <audio> element with a sticky dock, not N embedded players. Native
 *   per-episode players cannot skip or change rate, and N of them would mean N
 *   media sessions. A single now-playing dock is what `navigator.mediaSession`
 *   expects.
 * - The page is SERVER-RENDERED with the episode list, then cached network-first.
 *   Rendering client-side would make the offline experience depend on an API fetch
 *   that cannot succeed offline.
 * - Offline audio lives in its own cache (`audio-feed-offline-v1`) under the same
 *   URL the player uses, so "is this downloaded?" is a `caches.match()` and offline
 *   playback is just the service worker answering from cache.
 * - The token is a capability: `no-store`, no referrer, never echoed cross-origin.
 *
 * BACKGROUND FETCH is now wired, and the history matters (audio-feed-98i). 4xb
 * removed it after measuring the API as non-functional. It is not: driven against
 * a real origin it works end to end — getIds() is populated, the record settles
 * `success`, and pwa.ts's handler lands the bytes in the offline cache.
 *
 * An earlier version of this comment blamed headless Chrome, claiming
 * `'serviceWorker' in navigator` is false there. That was wrong and is retracted:
 * the reading came from `about:blank`, which has no service worker for reasons
 * unrelated to the browser build. On the app's own origin, headless Chrome 152
 * reports `serviceWorker` present and completes a background fetch. Every
 * measurement in this file was taken in headless Chrome 152 on http://localhost.
 *
 * What actually makes this API look broken is two ambiguities, both measured:
 *
 *   - getIds() is empty when nothing registered AND when a fetch has already
 *     COMPLETED, so one reading cannot tell those apart;
 *   - only the FIRST fetch per origin is permitted (audio-feed-zlf), and a
 *     refused attempt resolves and then never appears in getIds() — which is
 *     indistinguishable from "registered nothing", i.e. 4xb's exact symptom.
 *
 * Two things measured there shape the code below:
 *
 *   1. A RESOLVED `fetch()` IS NOT PROOF. The registration is confirmed via
 *      getIds() before the UI promises anything, because 4xb's mistake was
 *      promising on detection alone.
 *   2. THE CACHE READ RACES THE SERVICE WORKER. The page's `progress` event fires
 *      when the record settles; the SW's `backgroundfetchsuccess` runs
 *      independently under waitUntil. Reading the cache the instant the event
 *      fires returned EMPTY on a download that had succeeded, so the confirmation
 *      is a bounded poll, not a single read.
 *
 * Background Fetch is Chrome-only, not Baseline, and a WICG draft — Chrome filed
 * an Intent to Deprecate in Nov 2025 and withdrew it in Dec 2025. So the
 * foreground `fetch` + `cache.put` path is the MAJORITY path, not a stub, and
 * every failure mode falls back to it.
 *
 * AND IT IS THE MAJORITY PATH IN CHROME TOO, which is the part that surprises.
 * Background Fetch consumes Chrome's automatic-downloads permission, and only
 * the FIRST fetch from an origin is allowed. Measured in headless Chrome 152 on
 * http://localhost (unmeasured: headed, https, and installed-PWA behaviour):
 *
 *     permissions.query({ name: "background-fetch" })  -> "granted"
 *     attempt 0 -> ok
 *     attempt 1 -> TypeError: This origin does not have permission to start a fetch.
 *     attempt 2 -> TypeError: (same)
 *     after a full page reload, attempt 0 -> TypeError: (same)
 *
 * So the permission API reports `granted` while the call is refused, and the
 * allowance does not reset per page load — it is spent per origin until the user
 * grants automatic downloads. A feature detect is therefore worth even less here
 * than audio-feed-98i already showed: `"backgroundFetch" in reg` is true,
 * `permissions.query` says granted, and the call still throws. Only calling it
 * and catching tells the truth, which is exactly what the code below does.
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { resolveOrigin } from "../origin.ts";
import { getUserByFeedToken } from "../auth/users.ts";
import { esc, jsonForScript } from "./html.ts";
import type { AudioMode } from "../types.ts";

/** One row of the player's episode list, with everything the UI renders. */
export interface ListenEpisode {
  id: string;
  title: string;
  /** Article author, when the record has one. */
  author?: string;
  /** Publish date: the audio's own timestamp (readyAt ?? createdAt). */
  date?: string;
  source?: string;
  mode?: AudioMode;
  durationSeconds?: number;
  byteLength?: number;
  /** The source article, so a listener can read along (audio-feed-585). http(s) only. */
  articleUrl?: string;
  /** Stable, non-expiring enclosure URL served by GET /audio/:key. */
  audioUrl: string;
}

export interface ListenPageOptions {
  token: string;
  subscriber: string;
  feedUrl: string;
  episodes: ListenEpisode[];
  offlineEnabled: boolean;
}

const OFFLINE_CACHE = "audio-feed-offline-v1";

/**
 * Drawn icons on one 24px grid, 1.75px stroke, round caps.
 *
 * Author-controlled constants, referenced through <use>, so no subscriber text
 * ever reaches an innerHTML path. The glyphs they replace (U+25B6, U+23F8) render
 * as a different shape, weight and baseline on every platform, and as an emoji on
 * some.
 */
const ICON_SPRITE = `<svg class="sprite" aria-hidden="true" focusable="false">
  <defs>
    <symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5.2v13.6a.8.8 0 0 0 1.22.68l11-6.8a.8.8 0 0 0 0-1.36l-11-6.8A.8.8 0 0 0 8 5.2Z" fill="currentColor"/></symbol>
    <symbol id="i-pause" viewBox="0 0 24 24"><rect x="6.5" y="4.5" width="4" height="15" rx="1.4" fill="currentColor"/><rect x="13.5" y="4.5" width="4" height="15" rx="1.4" fill="currentColor"/></symbol>
    <symbol id="i-back" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a7.5 7.5 0 1 1-7.4 6.3"/><path d="M4.4 4.6v3.9h3.9"/></g><text x="12" y="15.4" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" font-family="system-ui, sans-serif">15</text></symbol>
    <symbol id="i-fwd" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a7.5 7.5 0 1 0 7.4 6.3"/><path d="M19.6 4.6v3.9h-3.9"/></g><text x="12" y="15.4" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" font-family="system-ui, sans-serif">30</text></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v10.5"/><path d="M7.75 9.75 12 14l4.25-4.25"/><path d="M4.5 16.5v2.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></g></symbol>
    <symbol id="i-saved" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m4.8 12.4 4.6 4.6L19.2 7.2"/></g></symbol>
    <symbol id="i-install" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2.8" width="11" height="18.4" rx="2.4"/><path d="M10.6 18.3h2.8"/></g></symbol>
    <symbol id="i-rss" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 11.2a7.8 7.8 0 0 1 7.8 7.8"/><path d="M5 5.6A13.4 13.4 0 0 1 18.4 19"/></g><circle cx="5.6" cy="18.4" r="1.7" fill="currentColor"/></symbol>
    <symbol id="i-voice-one" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12 4.8v14.4"/><path d="M7.4 8.6v6.8"/><path d="M16.6 8.6v6.8"/></g></symbol>
    <symbol id="i-voice-two" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M8.6 4.8v14.4"/><path d="M15.4 4.8v14.4"/><path d="M4.4 9.4v5.2"/><path d="M19.6 9.4v5.2"/></g></symbol>
  </defs>
</svg>`;

export function renderListenPage(
  { token, subscriber, feedUrl, episodes, offlineEnabled }: ListenPageOptions,
): string {
  const title = `${subscriber} — Audio Feed`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="theme-color" content="#0a0a0c">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="icon" href="/icon.svg">
<link rel="alternate" type="application/rss+xml" title="${esc(title)}" href="${esc(feedUrl)}">
<style>
  :root {
    color-scheme: dark;

    /* Surfaces climb in even steps so elevation reads as depth, not as noise. */
    --bg: #0a0a0c;
    --surface: #131317;
    --surface-2: #1c1c22;
    --surface-3: #26262e;

    /* Every one of these is measured against its own background, not guessed:
       text 16.9:1, text-2 9.9:1, muted 5.5:1 on --bg; muted 5.2:1 on --surface. */
    --text: #f4f4f5;
    --text-2: #b4b4bd;
    --muted: #86868f;

    --border: #24242b;
    --border-2: #34343e;

    --accent: #a78bfa;
    --accent-2: #c4b5fd;
    --accent-dim: #6d5bb0;
    --accent-ink: #14121c;
    --ok: #86efac;
    --danger: #fca5a5;

    --radius: 14px;
    --radius-sm: 10px;

    --space-1: 0.25rem;
    --space-2: 0.5rem;
    --space-3: 0.75rem;
    --space-4: 1rem;
    --space-5: 1.5rem;
    --space-6: 2rem;

    --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text",
            "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;

    /* Fallback only. The real value is measured from the dock at runtime (see
       the ResizeObserver below), because a hand-picked constant drifts the
       moment a row is added: measured at 186px against a guessed 136px reserve,
       which hid the last episode behind the dock. This number covers the
       TALLEST dock measured — 212px at 1280x900 and 210px at 360x740 — so the
       path with no ResizeObserver and the path with JS disabled both clear it;
       11.75rem (188px) did neither (audio-feed-c5n). */
    --dock-h: 13.5rem;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }

  * { box-sizing: border-box; }

  html {
    /* The surfaces nobody draws still carry the design. */
    scrollbar-color: var(--surface-3) var(--bg);
    scrollbar-width: thin;
  }
  ::selection { background: var(--accent); color: var(--accent-ink); }

  html, body { margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-synthesis-weight: none;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    line-height: 1.5;
    /* --dock-h is MEASURED from the dock, whose own padding already contains the
       safe-area inset, so adding the inset again here would double-count it —
       invisible at 0px on a desktop, a stripe of dead space on a notched phone.
       The extra space is a deliberate gap between the last row and the dock. */
    padding-block-end: calc(var(--dock-h) + var(--space-4));
    /* A single low, wide wash anchored where the dock sits, so the page has a
       floor rather than a flat field. Not decoration on the content itself. */
    background-image: radial-gradient(
      120% 45% at 50% 100%,
      color-mix(in srgb, var(--accent) 9%, transparent) 0%,
      transparent 70%
    );
    background-attachment: fixed;
  }

  .sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
  .icon { inline-size: 1.25rem; block-size: 1.25rem; display: block; flex: none; }

  a { color: var(--accent-2); text-decoration-color: color-mix(in srgb, var(--accent-2) 40%, transparent); text-underline-offset: 3px; }
  a:hover { text-decoration-color: currentColor; }

  button, select { font: inherit; color: inherit; cursor: pointer; }
  :focus-visible {
    outline: 2px solid var(--accent-2);
    outline-offset: 2px;
    border-radius: 6px;
  }

  /* ---------------------------------------------------------------- header */

  header.app {
    position: sticky; inset-block-start: 0; z-index: 5;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(14px) saturate(140%);
    border-block-end: 1px solid var(--border);
  }
  .header-inner {
    max-inline-size: 48rem; margin-inline: auto;
    padding: var(--space-4) var(--space-4) var(--space-3);
    display: flex; gap: var(--space-4); align-items: flex-start;
    justify-content: space-between; flex-wrap: wrap;
  }
  .identity { min-inline-size: 0; }
  h1 {
    margin: 0;
    font-size: clamp(1.35rem, 1.1rem + 1.1vw, 1.7rem);
    font-weight: 660;
    letter-spacing: -0.025em;
    line-height: 1.15;
    text-wrap: balance;
  }
  .subtitle {
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 0.85rem;
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2);
  }
  .subtitle .dot { inline-size: 3px; block-size: 3px; border-radius: 50%; background: currentColor; opacity: 0.6; }
  .header-actions { display: flex; gap: var(--space-2); align-items: center; }

  /* 44px min-block-size, not padding alone: MEASURED at 34px on the first pass,
     which is under the reachable minimum on the device this app is for. */
  .chip {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
    min-block-size: 2.75rem;
    padding: 0.5rem 0.85rem;
    border: 1px solid var(--border-2);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 0.8rem; font-weight: 550;
    text-decoration: none;
    transition: border-color 0.18s var(--ease), color 0.18s var(--ease), background 0.18s var(--ease);
  }
  .chip:hover { border-color: var(--accent-dim); color: var(--text); background: var(--surface-2); }
  .chip .icon { inline-size: 0.95rem; block-size: 0.95rem; }

  /* ------------------------------------------------------------------ list */

  main { max-inline-size: 48rem; margin-inline: auto; padding: var(--space-5) var(--space-4) var(--space-6); }

  .list-head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: var(--space-3); margin-block-end: var(--space-3);
  }
  .list-head h2 {
    margin: 0; font-size: 0.78rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted);
  }
  #savedCount { color: var(--muted); font-size: 0.78rem; font-variant-numeric: tabular-nums; }

  ul.episodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }

  /* Rows, not cards. A list of episodes IS a list; boxing each one repeats the
     same container as page structure and costs vertical room a phone needs. */
  li.episode {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0 var(--space-3);
    align-items: start;
    padding: var(--space-4) var(--space-2);
    border-block-end: 1px solid var(--border);
    position: relative;
    transition: background 0.18s var(--ease);
  }
  li.episode:first-child { border-block-start: 1px solid var(--border); }
  li.episode:hover { background: color-mix(in srgb, var(--surface) 60%, transparent); }

  li.episode[data-current="true"] { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  li.episode[data-current="true"]::before {
    content: ""; position: absolute; inset-block: 0; inset-inline-start: 0;
    inline-size: 2px; background: var(--accent); border-radius: 0 2px 2px 0;
  }

  /* The leading control is the play affordance: the row's primary action needs
     no label to be understood, and a 44px target is the reachable minimum. */
  .ep-play {
    inline-size: 2.75rem; block-size: 2.75rem;
    display: grid; place-items: center;
    border-radius: 50%;
    border: 1px solid var(--border-2);
    background: var(--surface-2);
    color: var(--text);
    transition: transform 0.18s var(--ease), background 0.18s var(--ease),
                border-color 0.18s var(--ease), color 0.18s var(--ease);
  }
  .ep-play:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); transform: scale(1.06); }
  .ep-play:active { transform: scale(0.97); }
  li.episode[data-current="true"] .ep-play { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }

  .ep-body { min-inline-size: 0; }
  .ep-title {
    margin: 0 0 var(--space-2);
    font-size: 1rem; font-weight: 600; line-height: 1.3;
    letter-spacing: -0.012em;
    text-wrap: pretty;
  }
  .ep-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2);
    color: var(--muted); font-size: 0.8rem; line-height: 1.4;
  }
  .ep-meta .dot { inline-size: 3px; block-size: 3px; border-radius: 50%; background: currentColor; opacity: 0.55; flex: none; }
  .ep-source { color: var(--text-2); font-weight: 550; }
  .ep-duration { font-variant-numeric: tabular-nums; }

  /* Mode is the product's central idea — one voice or two — so it is drawn, not
     spelled in a pill that looks like every other pill. */
  .ep-mode { display: inline-flex; align-items: center; gap: 0.3rem; color: var(--muted); }
  .ep-mode .icon { inline-size: 0.9rem; block-size: 0.9rem; }
  .ep-mode[data-mode="deepdive"] { color: var(--accent-2); }

  .ep-actions { display: flex; align-items: center; gap: var(--space-1); }
  .ep-read {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
    border-radius: var(--radius-sm); border: 1px solid transparent;
    color: var(--muted); font-size: .75rem; text-decoration: none;
  }
  .ep-read:hover { color: var(--text); background: var(--surface-2); border-color: var(--border-2); }
  .ep-read:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  .now-read {
    margin-inline-start: auto; padding: 4px 8px; border-radius: var(--radius-sm);
    color: var(--muted); font-size: .75rem; text-decoration: none;
  }
  .now-read:hover { color: var(--text); background: var(--surface-2); }
  .now-read:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  .ep-download {
    inline-size: 2.75rem; block-size: 2.75rem;
    display: grid; place-items: center;
    border-radius: 50%;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    transition: color 0.18s var(--ease), background 0.18s var(--ease), border-color 0.18s var(--ease);
  }
  .ep-download:hover:not([disabled]) { color: var(--text); background: var(--surface-2); border-color: var(--border-2); }
  .ep-download[data-state="saved"] { color: var(--ok); }
  .ep-download[data-state="working"] { color: var(--accent-2); }
  .ep-download[disabled] { opacity: 0.4; cursor: not-allowed; }
  .ep-download .pct {
    font-size: 0.68rem; font-weight: 700; font-variant-numeric: tabular-nums;
    font-family: var(--mono); letter-spacing: -0.04em;
  }

  .empty {
    margin: var(--space-6) 0; padding: var(--space-6) var(--space-4);
    text-align: center; color: var(--muted);
    border: 1px dashed var(--border-2); border-radius: var(--radius);
  }
  .empty strong { display: block; color: var(--text-2); font-weight: 600; margin-block-end: var(--space-2); }

  /* ------------------------------------------------------------------ dock */

  .dock {
    position: fixed; inset-block-end: 0; inset-inline: 0; z-index: 10;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(18px) saturate(160%);
    border-block-start: 1px solid var(--border-2);
    box-shadow: 0 -12px 32px -18px rgb(0 0 0 / 0.9);
    padding-block-end: env(safe-area-inset-bottom, 0px);
  }
  /*
   * minmax(0, 1fr), not the default auto track (audio-feed-cl5).
   * An auto track sizes to the row's MAX-CONTENT — measured at 523px inside a
   * 363px container, which pushed the speed control 147px past a 390px viewport
   * on a fixed bar the document cannot scroll. min-width:0 on the row measured
   * as a NO-OP because the item was never the binding constraint; the TRACK was.
   */
  .dock-inner {
    max-inline-size: 48rem; margin-inline: auto;
    display: grid; grid-template-columns: minmax(0, 1fr);
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-4);
  }

  .now { display: flex; align-items: center; gap: var(--space-3); min-inline-size: 0; }
  .now-text { min-inline-size: 0; flex: 1 1 auto; }
  .now-title {
    display: block; font-size: 0.9rem; font-weight: 600; letter-spacing: -0.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .now-sub {
    display: block; color: var(--muted); font-size: 0.76rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .now-badge {
    flex: none; display: inline-flex; align-items: center; gap: 0.3rem;
    color: var(--ok); font-size: 0.72rem; font-weight: 600;
  }
  .now-badge .icon { inline-size: 0.85rem; block-size: 0.85rem; }

  .scrub { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; }
  .scrub .t { color: var(--muted); font-size: 0.72rem; font-variant-numeric: tabular-nums; font-family: var(--mono); letter-spacing: -0.03em; }

  /*
   * A real track with a filled portion, rather than the platform default in five
   * different shapes. --progress is set from JS on input and timeupdate.
   */
  /*
   * The ELEMENT is 44px tall; the TRACK it paints is the 4px line declared on
   * ::-webkit-slider-runnable-track below. Scrubbing is the hardest gesture in a
   * player to land on a phone, and the hit area is the element's box rather than
   * the painted line — measured at 20px on the first pass, under the reachable
   * minimum.
   *
   * Note for anyone verifying this: getComputedStyle(el, "::-webkit-slider-
   * runnable-track").height reports the ELEMENT's height (44px), not the track's
   * declared 4px, so it cannot be used to check this. The rendered screenshot is
   * the evidence.
   */
  input[type="range"] {
    -webkit-appearance: none; appearance: none;
    inline-size: 100%; min-inline-size: 0;
    background: transparent; cursor: pointer; margin: 0;
    block-size: 2.75rem;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    block-size: 4px; border-radius: 999px;
    background: linear-gradient(to right,
      var(--accent) calc(var(--progress, 0) * 100%),
      var(--surface-3) calc(var(--progress, 0) * 100%));
  }
  input[type="range"]::-moz-range-track {
    block-size: 4px; border-radius: 999px; background: var(--surface-3);
  }
  input[type="range"]::-moz-range-progress { block-size: 4px; border-radius: 999px; background: var(--accent); }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    inline-size: 13px; block-size: 13px; border-radius: 50%;
    background: var(--text); border: none; margin-block-start: -4.5px;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.5);
    transition: transform 0.15s var(--ease);
  }
  input[type="range"]::-moz-range-thumb {
    inline-size: 13px; block-size: 13px; border-radius: 50%;
    background: var(--text); border: none;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.5);
  }
  input[type="range"]:hover::-webkit-slider-thumb { transform: scale(1.18); }
  input[type="range"][disabled] { cursor: not-allowed; opacity: 0.5; }

  .transport { display: flex; align-items: center; justify-content: center; gap: var(--space-2); }
  .t-btn {
    inline-size: 2.75rem; block-size: 2.75rem;
    display: grid; place-items: center;
    border-radius: 50%; border: 1px solid var(--border-2);
    background: var(--surface-2); color: var(--text-2);
    transition: color 0.18s var(--ease), background 0.18s var(--ease),
                border-color 0.18s var(--ease), transform 0.18s var(--ease);
  }
  .t-btn:hover:not([disabled]) { color: var(--text); border-color: var(--accent-dim); }
  .t-btn:active:not([disabled]) { transform: scale(0.95); }
  .t-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
  .t-btn .icon { inline-size: 1.4rem; block-size: 1.4rem; }

  .t-main {
    inline-size: 3.5rem; block-size: 3.5rem;
    background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
    box-shadow: 0 6px 20px -8px color-mix(in srgb, var(--accent) 75%, transparent);
  }
  .t-main:hover:not([disabled]) { background: var(--accent-2); border-color: var(--accent-2); color: var(--accent-ink); }
  .t-main .icon { inline-size: 1.6rem; block-size: 1.6rem; }

  .rate {
    margin-inline-start: auto;
    min-inline-size: 3.6rem;
    min-block-size: 2.75rem;
    padding: 0.45rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--border-2);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 0.8rem; font-weight: 600; font-variant-numeric: tabular-nums;
    text-align: center;
    transition: border-color 0.18s var(--ease), color 0.18s var(--ease);
  }
  .rate:hover { border-color: var(--accent-dim); color: var(--text); }
  /* The spacer balances the speed pill so the transport stays optically centred
     rather than drifting left by the pill's width. */
  .t-spacer { inline-size: 3.6rem; flex: none; }

  .notice {
    margin: 0; font-size: 0.78rem; min-block-size: 1.1rem;
    color: var(--text-2); text-align: center;
  }
  .notice[data-tone="error"] { color: var(--danger); }
  .notice[data-tone="ok"] { color: var(--ok); }

  .hidden { display: none !important; }

  /* -------------------------------------------------------------- narrow */

  \u0040media (max-width: 30rem) {
    li.episode { grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2) var(--space-3); padding-inline: 0; }
    .ep-actions { grid-column: 2; margin-block-start: var(--space-2); }
    .header-inner { padding-inline: var(--space-3); }
    main { padding-inline: var(--space-3); }
    .dock-inner { padding-inline: var(--space-3); }
    .t-spacer { display: none; }
  }

  \u0040media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
  }
</style>
</head>
<body>
${ICON_SPRITE}

<header class="app">
  <div class="header-inner">
    <div class="identity">
      <h1>${esc(subscriber)}</h1>
      <p class="subtitle">
        <span id="episodeCount">${episodes.length} episode${episodes.length === 1 ? "" : "s"}</span>
        <span class="dot" aria-hidden="true"></span>
        <span id="offlineStatus" role="status" aria-live="polite">Ready</span>
      </p>
    </div>
    <div class="header-actions">
      <button type="button" class="chip hidden" id="installBtn">
        <svg class="icon" aria-hidden="true"><use href="#i-install"/></svg>
        Install
      </button>
      <a class="chip" id="rssLink" href="${esc(feedUrl)}">
        <svg class="icon" aria-hidden="true"><use href="#i-rss"/></svg>
        RSS
      </a>
    </div>
  </div>
</header>

<main>
  <div class="list-head">
    <h2>Episodes</h2>
    <span id="savedCount"></span>
  </div>
  <ul class="episodes" id="episodes"></ul>
  <p class="empty hidden" id="empty">
    <strong>No episodes yet</strong>
    Subscribe a feed or send an article, and finished audio appears here.
  </p>
</main>

<!--
  A single media element for the whole app: one media session, one place for
  transport controls, and the same element playing cached or streamed bytes — the
  service worker decides which, so this code needs no offline mode.

  NO crossorigin attribute, deliberately. It was crossorigin="anonymous", and
  that is what broke playback in production: the attribute forces the media load
  into CORS mode, the audio route 302s to an R2 presigned URL, and R2's S3
  endpoint sends no access-control-allow-origin (measured: 200 with the bytes,
  no CORS header, and a preflight answered 403). The browser then refuses a
  response it had already received.

  Nothing here needs the attribute. It buys readable pixels for a <canvas> and
  tainting rules for WebAudio analysis; this player draws neither. Adding it back
  requires the audio route to answer CORS for every path, including the redirect
  one it cannot control.
-->
<audio id="audio" preload="metadata"></audio>

<section class="dock" aria-label="Player">
  <div class="dock-inner">
    <div class="now">
      <div class="now-text">
        <span class="now-title" id="nowTitle">Nothing playing</span>
        <span class="now-sub" id="nowSub">Pick an episode to start</span>
      </div>
      <a class="now-read hidden" id="nowRead" target="_blank" rel="noopener noreferrer">Read along</a>
      <span class="now-badge hidden" id="nowOffline">
        <svg class="icon" aria-hidden="true"><use href="#i-saved"/></svg>
        Offline
      </span>
    </div>

    <div class="scrub">
      <span class="t" id="nowTime">0:00</span>
      <input type="range" id="seek" min="0" max="0" step="1" value="0" aria-label="Seek" disabled>
      <span class="t" id="nowDuration">0:00</span>
    </div>

    <div class="transport">
      <span class="t-spacer" aria-hidden="true"></span>
      <button type="button" class="t-btn" id="back" aria-label="Skip back 15 seconds">
        <svg class="icon" aria-hidden="true"><use href="#i-back"/></svg>
      </button>
      <button type="button" class="t-btn t-main" id="playPause" aria-label="Play" aria-pressed="false">
        <svg class="icon" id="playIcon" aria-hidden="true"><use href="#i-play"/></svg>
      </button>
      <button type="button" class="t-btn" id="fwd" aria-label="Skip forward 30 seconds">
        <svg class="icon" aria-hidden="true"><use href="#i-fwd"/></svg>
      </button>
      <select class="rate" id="rate" aria-label="Playback speed">
        <option value="0.75">0.75&times;</option>
        <option value="1" selected>1&times;</option>
        <option value="1.25">1.25&times;</option>
        <option value="1.5">1.5&times;</option>
        <option value="2">2&times;</option>
      </select>
    </div>

    <p class="notice" id="playerNotice" role="status" aria-live="polite"></p>
  </div>
</section>

<script>
(() => {
  "use strict";
  const TOKEN = ${jsonForScript(token)};
  const ORIGIN = ${jsonForScript(new URL(feedUrl).origin)};
  const OFFLINE_CACHE = ${jsonForScript(OFFLINE_CACHE)};
  const EPISODES = ${jsonForScript(episodes)};
  const OFFLINE_ENABLED = ${offlineEnabled ? "true" : "false"};
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Remember the capability so a home-screen launch (start_url /listen) can restore
  // the player without the subscriber pasting anything again.
  try { localStorage.setItem("audio-feed-token", TOKEN); } catch { /* private mode */ }

  const $ = (id) => document.getElementById(id);
  const audio = $("audio");
  const list = $("episodes");
  const empty = $("empty");
  const playPause = $("playPause");
  const playIcon = $("playIcon");
  const seek = $("seek");
  const rate = $("rate");
  const backBtn = $("back");
  const fwdBtn = $("fwd");
  const nowTitle = $("nowTitle");
  const nowSub = $("nowSub");
  const nowRead = $("nowRead");
  const nowTime = $("nowTime");
  const nowDuration = $("nowDuration");
  const nowOffline = $("nowOffline");
  const offlineStatus = $("offlineStatus");
  const savedCount = $("savedCount");
  const playerNotice = $("playerNotice");
  const installBtn = $("installBtn");

  const downloaded = new Set();
  let current = null;
  let cache = null;

  /**
   * Reserve exactly the space the dock occupies, measured rather than assumed.
   *
   * The dock is position:fixed, so the page must reserve its height or the
   * last episode sits underneath it. A CSS constant cannot do that honestly: the
   * dock's height depends on the type scale, the notice line wrapping, and the
   * safe-area inset, and a guessed 8.5rem measured 50px short against a real
   * 186px dock. Deriving it means the reserve cannot drift from the thing it is
   * reserving for.
   *
   * Measured ONCE in every browser, and kept in sync where the observer exists: a
   * browser without ResizeObserver previously never measured at all and lived with
   * the constant, which is the wrong half of the trade for the path that has no
   * other way to get it right (audio-feed-c5n).
   */
  const dock = document.querySelector(".dock");
  if (dock) {
    const sync = () => {
      const height = dock.getBoundingClientRect().height;
      if (height > 0) document.documentElement.style.setProperty("--dock-h", height + "px");
    };
    if ("ResizeObserver" in window) new ResizeObserver(sync).observe(dock);
    sync();
  }

  /** Author-controlled sprite reference; no subscriber text ever goes near innerHTML. */
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", cls || "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  }
  function setIcon(svg, name) {
    const use = svg.querySelector("use");
    if (use) use.setAttribute("href", "#i-" + name);
  }

  const fmt = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0")
      : m + ":" + String(s).padStart(2, "0");
  };

  /** Relative for recent items, absolute once "3 weeks ago" stops being useful. */
  const when = (iso) => {
    if (!iso) return "";
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return "";
    const days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return days + " days ago";
    return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };

  const say = (message, tone) => {
    playerNotice.textContent = message || "";
    if (tone) playerNotice.dataset.tone = tone;
    else delete playerNotice.dataset.tone;
  };

  async function openOfflineCache() {
    if (!OFFLINE_ENABLED || !("caches" in window)) return null;
    if (!cache) cache = await caches.open(OFFLINE_CACHE);
    return cache;
  }

  /** "Downloaded" is the presence of the enclosure URL in our cache. No side list. */
  async function refreshDownloaded() {
    const store = await openOfflineCache();
    if (!store) return;
    const keys = new Set((await store.keys()).map((request) => request.url));
    downloaded.clear();
    for (const episode of EPISODES) if (keys.has(episode.audioUrl)) downloaded.add(episode.id);
  }

  async function isCached(episode) {
    const store = await openOfflineCache();
    if (!store) return false;
    return Boolean(await store.match(episode.audioUrl));
  }

  // ---- episode rows -------------------------------------------------------

  const span = (text, cls) => {
    const el = document.createElement("span");
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  };
  const dot = () => {
    const el = document.createElement("span");
    el.className = "dot";
    el.setAttribute("aria-hidden", "true");
    return el;
  };

  function setDownloadState(button, state, label) {
    button.dataset.state = state;
    button.replaceChildren();
    if (state === "working") {
      const pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = label || "";
      button.appendChild(pct);
    } else {
      button.appendChild(icon(state === "saved" ? "saved" : "download"));
    }
    button.disabled = state === "working";
  }

  function row(episode) {
    const li = document.createElement("li");
    li.className = "episode";
    li.dataset.episodeId = episode.id;

    const play = document.createElement("button");
    play.type = "button";
    play.className = "ep-play";
    play.dataset.action = "play";
    play.setAttribute("aria-label", "Play " + episode.title);
    play.appendChild(icon("play"));
    play.addEventListener("click", () => select(episode, true));
    li.appendChild(play);

    const body = document.createElement("div");
    body.className = "ep-body";

    const h3 = document.createElement("h3");
    h3.className = "ep-title";
    h3.textContent = episode.title;
    body.appendChild(h3);

    const meta = document.createElement("div");
    meta.className = "ep-meta";
    const parts = [];
    if (episode.source) parts.push(span(episode.source, "ep-source"));
    if (episode.author) parts.push(span(episode.author));
    const dateText = when(episode.date);
    if (dateText) parts.push(span(dateText));
    if (episode.durationSeconds) parts.push(span(fmt(episode.durationSeconds), "ep-duration"));
    if (episode.mode) {
      const mode = document.createElement("span");
      mode.className = "ep-mode";
      mode.dataset.mode = episode.mode;
      mode.appendChild(icon(episode.mode === "deepdive" ? "voice-two" : "voice-one"));
      mode.appendChild(span(episode.mode === "deepdive" ? "Deep dive" : "Direct read"));
      parts.push(mode);
    }
    parts.forEach((part, index) => {
      if (index > 0) meta.appendChild(dot());
      meta.appendChild(part);
    });
    body.appendChild(meta);
    li.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "ep-actions";
    const download = document.createElement("button");
    download.type = "button";
    download.className = "ep-download";
    download.dataset.action = "download";
    const saved = downloaded.has(episode.id);
    setDownloadState(download, saved ? "saved" : "idle");
    download.setAttribute(
      "aria-label",
      (saved ? "Saved offline: " : "Download for offline listening: ") + episode.title,
    );
    if (!OFFLINE_ENABLED) {
      download.disabled = true;
      download.title = "This browser cannot store audio offline.";
    }
    download.addEventListener("click", () => downloadEpisode(episode, download));
    actions.appendChild(download);
    // Read-along linkback (audio-feed-585): a real anchor, so it can be opened in a new tab,
    // middle-clicked, and read out as a link. The client never trusts the URL further than the
    // server already did — the server only sends http(s) — and rel=noopener is explicit so the
    // article cannot reach back through window.opener.
    if (episode.articleUrl) {
      const read = document.createElement("a");
      read.className = "ep-read";
      read.href = episode.articleUrl;
      read.target = "_blank";
      read.rel = "noopener noreferrer";
      read.setAttribute("aria-label", "Read the article: " + episode.title);
      read.textContent = "Read along";
      actions.appendChild(read);
    }
    li.appendChild(actions);
    return li;
  }

  function render() {
    list.replaceChildren();
    for (const episode of EPISODES) list.appendChild(row(episode));
    empty.classList.toggle("hidden", EPISODES.length > 0);
    updateCounts();
  }

  function updateCounts() {
    savedCount.textContent = downloaded.size ? downloaded.size + " saved offline" : "";
    const bits = [];
    if (!navigator.onLine) bits.push("Offline");
    else bits.push("Ready");
    offlineStatus.textContent = bits.join(" ");
  }

  // ---- selection and transport --------------------------------------------

  async function select(episode, autoplay) {
    current = episode;
    audio.src = episode.audioUrl;
    nowTitle.textContent = episode.title;
    const sub = [];
    if (episode.source) sub.push(episode.source);
    if (episode.author) sub.push(episode.author);
    nowSub.textContent = sub.join(" — ") || "Audio Feed";
    // Read-along linkback (audio-feed-585): the dock is where he listens, so the way back to the
    // article lives here too, not only in the list row.
    if (nowRead) {
      if (episode.articleUrl) {
        nowRead.href = episode.articleUrl;
        nowRead.setAttribute("aria-label", "Read the article: " + episode.title);
        nowRead.classList.remove("hidden");
      } else {
        nowRead.removeAttribute("href");
        nowRead.classList.add("hidden");
      }
    }
    seek.disabled = false;

    for (const li of list.querySelectorAll("li.episode")) {
      li.dataset.current = String(li.dataset.episodeId === episode.id);
    }
    nowOffline.classList.toggle("hidden", !downloaded.has(episode.id));

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: episode.title,
        artist: episode.author || "Audio Feed",
        album: episode.source || "Audio Feed",
        artwork: [{ src: ORIGIN + "/icon.svg", sizes: "any", type: "image/svg+xml" }],
      });
    }
    if (autoplay) {
      try {
        await audio.play();
        say("");
      } catch {
        say("Press play to start — the browser blocked autoplay.");
      }
    }
  }

  function toggle() {
    if (!current) {
      if (EPISODES.length > 0) select(EPISODES[0], true);
      return;
    }
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }

  function setProgress() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const ratio = duration > 0 ? audio.currentTime / duration : 0;
    seek.style.setProperty("--progress", String(ratio));
  }

  playPause.addEventListener("click", toggle);
  backBtn.addEventListener("click", () => {
    audio.currentTime = Math.max(0, audio.currentTime - 15);
  });
  fwdBtn.addEventListener("click", () => {
    audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30);
  });
  seek.addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value);
    setProgress();
  });
  rate.addEventListener("change", () => {
    audio.playbackRate = Number(rate.value);
  });

  audio.addEventListener("play", () => {
    setIcon(playIcon, "pause");
    playPause.setAttribute("aria-label", "Pause");
    playPause.setAttribute("aria-pressed", "true");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  });
  audio.addEventListener("pause", () => {
    setIcon(playIcon, "play");
    playPause.setAttribute("aria-label", "Play");
    playPause.setAttribute("aria-pressed", "false");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  });
  audio.addEventListener("loadedmetadata", () => {
    seek.max = String(audio.duration || 0);
    nowDuration.textContent = fmt(audio.duration);
    nowTime.textContent = fmt(audio.currentTime);
    setProgress();
  });
  audio.addEventListener("timeupdate", () => {
    seek.value = String(audio.currentTime);
    nowTime.textContent = fmt(audio.currentTime);
    setProgress();
    if ("mediaSession" in navigator && audio.duration) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: audio.currentTime,
        });
      } catch { /* unsupported position state is not fatal */ }
    }
  });
  audio.addEventListener("error", () => {
    say("That audio could not be played. If you are offline, download it while online first.", "error");
  });

  // ---- OS media controls --------------------------------------------------
  if ("mediaSession" in navigator) {
    const handlers = {
      play: () => void audio.play().catch(() => {}),
      pause: () => audio.pause(),
      seekbackward: (details) => {
        audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 15));
      },
      seekforward: (details) => {
        audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (details.seekOffset || 30));
      },
      seekto: (details) => {
        if (typeof details.seekTime === "number" && Number.isFinite(audio.duration)) {
          audio.currentTime = Math.min(details.seekTime, audio.duration);
        }
      },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
  }

  // ---- downloads ----------------------------------------------------------

  function markSaved(episode, button) {
    downloaded.add(episode.id);
    setDownloadState(button, "saved");
    button.setAttribute("aria-label", "Saved offline: " + episode.title);
    if (current && current.id === episode.id) nowOffline.classList.remove("hidden");
    updateCounts();
  }

  /**
   * Wait for the bytes to appear in the cache, bounded.
   *
   * MEASURED (audio-feed-98i correction): a background fetch's page-side progress
   * event fires when the RECORD settles, while the service worker's
   * backgroundfetchsuccess handler writes the cache independently under
   * waitUntil. Reading the cache the instant the event fired returned EMPTY for a
   * download that had in fact succeeded. A single read is a race; this is not.
   */
  async function waitForCache(episode, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isCached(episode)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return await isCached(episode);
  }

  /**
   * Background Fetch, or null if this browser/attempt cannot do it.
   *
   * Returns null rather than throwing so the caller falls back silently — on
   * Safari and Firefox, which have never implemented this API, the null path is
   * the NORMAL path and must not look like an error.
   */
  async function tryBackgroundFetch(episode, button) {
    if (!("serviceWorker" in navigator)) return null;
    let reg = null;
    try { reg = await navigator.serviceWorker.ready; } catch { return null; }
    if (!reg || !("backgroundFetch" in reg)) return null;

    const id = "episode-" + episode.id;
    let record = null;
    try {
      record = await reg.backgroundFetch.get(id);
      if (!record) {
        const options = {
          title: episode.title,
          icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
        };
        if (episode.byteLength) options.downloadTotal = episode.byteLength;
        record = await reg.backgroundFetch.fetch(id, [episode.audioUrl], options);
      }
    } catch {
      return null;
    }
    if (!record) return null;

    // CONFIRM the registration rather than trusting fetch() to resolve.
    //
    // This is the whole lesson of audio-feed-98i: a resolved fetch() is not
    // evidence the download exists, and the previous attempt promised the
    // subscriber they could close the tab on exactly that evidence. Note the
    // ambiguity that makes the check subtle — getIds() is ALSO empty once a fetch
    // COMPLETES, because a finished registration is no longer pending. So an
    // absent id means "never registered OR already done", and only the cache can
    // tell those apart.
    let ids = [];
    try { ids = await reg.backgroundFetch.getIds(); } catch { /* treat as absent */ }
    if (!ids.includes(id)) {
      if (await waitForCache(episode, 1500)) return "success";
      return null;
    }

    // Confirmed registered. Only now is the OS-level promise true.
    say("Downloading in the background — you can close this tab.", "ok");

    const settled = await new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      record.addEventListener("progress", () => {
        if (record.downloadTotal > 0) {
          const pct = Math.min(99, Math.round((record.downloaded / record.downloadTotal) * 100));
          setDownloadState(button, "working", pct + "%");
        }
        if (record.result === "success") finish("success");
        else if (record.result === "failure") finish(record.failureReason || "failure");
      });
      // A bound, so a registration that never reports cannot hang the button the
      // way the 4xb attempt did.
      setTimeout(() => finish("timeout"), 120000);
    });

    if (settled !== "success") return null;
    return (await waitForCache(episode, 8000)) ? "success" : null;
  }

  /** The path that runs everywhere, including every non-Chromium browser. */
  async function foregroundDownload(episode, button, store) {
    setDownloadState(button, "working", "0%");
    const response = await fetch(episode.audioUrl);
    if (!response.ok) throw new Error("HTTP " + response.status);
    await store.put(episode.audioUrl, response);
  }

  async function downloadEpisode(episode, button) {
    const store = await openOfflineCache();
    if (!store) {
      say("This browser cannot store audio offline.", "error");
      return;
    }
    if (downloaded.has(episode.id)) {
      say("Already saved on this device.", "ok");
      return;
    }

    setDownloadState(button, "working", "…");
    say("Starting download…");
    try {
      const viaBackground = await tryBackgroundFetch(episode, button);
      if (viaBackground === "success") {
        markSaved(episode, button);
        say("Saved for offline listening.", "ok");
        return;
      }
      // Either unsupported, refused, or it did not complete — the verified path.
      await foregroundDownload(episode, button, store);
      markSaved(episode, button);
      say("Saved for offline listening.", "ok");
    } catch (error) {
      setDownloadState(button, "idle");
      say("Download failed: " + String((error && error.message) || error), "error");
    }
  }

  window.addEventListener("online", updateCounts);
  window.addEventListener("offline", updateCounts);

  // ---- install ------------------------------------------------------------
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    installBtn.classList.remove("hidden");
  });
  installBtn.addEventListener("click", async () => {
    if (!installPrompt) return;
    installBtn.disabled = true;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } finally {
      installPrompt = null;
      installBtn.classList.add("hidden");
      installBtn.disabled = false;
    }
  });

  // ---- boot ---------------------------------------------------------------
  async function boot() {
    await refreshDownloaded();
    render();
    if (EPISODES.length > 0) {
      // Preselect so the dock shows something playable, without starting audio.
      await select(EPISODES[0], false);
    }
    updateCounts();

    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      } catch {
        offlineStatus.textContent = "Offline mode unavailable";
      }
    }
  }
  void boot();
})();
</script>
</body>
</html>
`;
}

/**
 * Resolve a feed token from a URL path segment, returning the token AS STORED.
 *
 * The router matches against `url.pathname`, which is still percent-encoded, so a
 * token containing any character that needs encoding arrives encoded. Minted tokens
 * are base36 and never need it, but the page must work for whatever token resolved
 * — and its escaping is only exercisable through this route if such a token can
 * reach it.
 *
 * Returning the matched VALUE (not the raw segment) is what keeps the rest of the
 * handler consistent: the feed URL encodes it exactly once, and localStorage gets a
 * token that a later `/listen/<token>` request can use. Using the raw segment for
 * those produced a doubly-encoded feed URL and a token that broke on reload.
 *
 * The RAW value is tried first and the decoded form only as a fallback, so a token
 * that legitimately contains a percent sign cannot be corrupted into another one.
 */
async function resolveTokenValue(ctx: AppContext, raw: string): Promise<string | null> {
  if (!raw) return null;
  if (await getUserByFeedToken(ctx.stores.metadata, raw)) return raw;
  if (!raw.includes("%")) return null;
  try {
    const decoded = decodeURIComponent(raw);
    if (await getUserByFeedToken(ctx.stores.metadata, decoded)) return decoded;
  } catch {
    return null;
  }
  return null;
}

/** Resolve the token, load what the player renders, and serve the page. */
export async function handleListen(
  { ctx, req, params }: RouteContext<AppContext>,
): Promise<Response> {
  const origin = resolveOrigin(ctx.config, req);
  const token = await resolveTokenValue(ctx, (params.token ?? "").trim());
  if (!token) return notFound("Unknown feed");
  const user = await getUserByFeedToken(ctx.stores.metadata, token);
  if (!user) return notFound("Unknown feed");
  if (user.status !== "approved") {
    return forbidden(`Feed unavailable (status: ${user.status})`);
  }

  const episodes = await ctx.stores.metadata.listEpisodes({
    userId: user.id,
    status: "ready",
    limit: 100,
  });
  const sources = await ctx.stores.metadata.listSources(user.id);
  const sourceTitles = new Map(sources.map((source) => [source.id, source.title]));

  const rows: ListenEpisode[] = [];
  for (const episode of episodes) {
    if (!episode.audioKey) continue;
    // The author lives on the article, not the episode; one lookup per row is the
    // price of showing it, and the list is bounded above.
    const article = await ctx.stores.metadata.getArticle(user.id, episode.articleId);
    rows.push({
      id: episode.id,
      title: episode.title,
      author: article?.author,
      date: episode.readyAt ?? episode.createdAt,
      source: sourceTitles.get(episode.sourceId),
      mode: episode.mode,
      durationSeconds: episode.durationSeconds,
      byteLength: episode.byteLength,
      audioUrl: `${origin.baseUrl}/audio/${episode.audioKey}`,
      // A linkback only when the stored URL is a real web address: the value comes from a feed the
      // user subscribed to, and a link is not a place to trust it further than ingest did.
      articleUrl: /^https?:\/\//i.test(article?.url ?? "") ? article?.url : undefined,
    });
  }

  const html = renderListenPage({
    token,
    subscriber: user.displayName || user.email,
    feedUrl: `${origin.baseUrl}/feed/${encodeURIComponent(token)}/master.xml`,
    episodes: rows,
    // Offline storage needs Cache Storage; without it the page still plays online.
    offlineEnabled: true,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A capability-bearing page: never in a shared cache.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

const notFound = (message: string) =>
  Response.json({ error: message }, { status: 404, headers: { "cache-control": "no-store" } });
const forbidden = (message: string) =>
  Response.json({ error: message }, { status: 403, headers: { "cache-control": "no-store" } });

/** `/listen` without a token: restore from localStorage, or paste a feed URL. */
export function renderListenLanding(publicBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Audio Feed — listen</title>
<meta name="theme-color" content="#0a0a0c">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
<style>
  :root {
    color-scheme: dark;
    --bg:#0a0a0c; --surface:#131317; --surface-2:#1c1c22;
    --text:#f4f4f5; --text-2:#b4b4bd; --muted:#86868f;
    --border:#24242b; --border-2:#34343e;
    --accent:#a78bfa; --accent-2:#c4b5fd; --accent-ink:#14121c;
    --danger:#fca5a5;
    --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing:border-box; }
  ::selection { background: var(--accent); color: var(--accent-ink); }
  body {
    margin:0; background:var(--bg); color:var(--text); font-family:var(--font);
    line-height:1.5; -webkit-font-smoothing:antialiased;
    display:grid; place-items:center; min-block-size:100dvb; padding:1.5rem;
    background-image: radial-gradient(90% 50% at 50% 0%, color-mix(in srgb, var(--accent) 11%, transparent) 0%, transparent 65%);
  }
  main {
    max-inline-size:28rem; inline-size:100%;
    background:var(--surface); border:1px solid var(--border);
    border-radius:16px; padding:2rem 1.75rem;
    box-shadow: 0 24px 60px -30px rgb(0 0 0 / 0.9);
  }
  .mark { inline-size:2.75rem; block-size:2.75rem; display:block; margin-block-end:1.25rem; }
  h1 { font-size:1.4rem; font-weight:660; letter-spacing:-0.025em; margin:0 0 0.5rem; }
  p.lede { color:var(--text-2); font-size:0.9rem; margin:0 0 1.5rem; text-wrap:pretty; }
  label { display:block; font-weight:600; font-size:0.85rem; margin-block-end:0.4rem; }
  input {
    inline-size:100%; font:inherit; padding:0.65rem 0.75rem; border-radius:10px;
    border:1px solid var(--border-2); background:var(--bg); color:var(--text);
  }
  input::placeholder { color:var(--muted); }
  input:focus-visible, button:focus-visible { outline:2px solid var(--accent-2); outline-offset:2px; }
  button {
    font:inherit; font-weight:600; margin-block-start:0.9rem; inline-size:100%;
    padding:0.7rem; border-radius:10px; border:1px solid var(--accent);
    background:var(--accent); color:var(--accent-ink); cursor:pointer;
    transition: background 0.18s var(--ease), border-color 0.18s var(--ease);
  }
  button:hover { background:var(--accent-2); border-color:var(--accent-2); }
  .status { margin-block-start:0.75rem; font-size:0.83rem; color:var(--muted); min-block-size:1.2rem; }
  .status[data-tone="error"] { color: var(--danger); }
  .hint {
    margin:1.5rem 0 0; padding-block-start:1.25rem; border-block-start:1px solid var(--border);
    font-size:0.82rem; color:var(--muted); text-wrap:pretty;
  }
  \u0040media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
</style>
</head>
<body>
<main>
  <svg class="mark" viewBox="0 0 512 512" role="img" aria-label="Audio Feed">
    <rect width="512" height="512" rx="112" fill="#1c1c22"/>
    <circle cx="256" cy="256" r="58" fill="#a78bfa"/>
    <g fill="none" stroke="#a78bfa" stroke-width="26" stroke-linecap="round" opacity="0.85">
      <path d="M150 176a150 150 0 0 0 0 160"/><path d="M362 176a150 150 0 0 1 0 160"/>
    </g>
    <g fill="none" stroke="#a78bfa" stroke-width="22" stroke-linecap="round" opacity="0.5">
      <path d="M96 132a190 190 0 0 0 0 248"/><path d="M416 132a190 190 0 0 1 0 248"/>
    </g>
  </svg>
  <h1>Listen to your feed</h1>
  <p class="lede">
    Open your personal feed URL — the one containing your feed token — and this
    player remembers it on this device. Nothing to sign in to.
  </p>
  <form id="restore">
    <label for="feedUrl">Your feed URL or token</label>
    <input id="feedUrl" name="feedUrl" type="text" autocomplete="off" spellcheck="false"
           placeholder="${esc(publicBaseUrl)}/feed/&lt;token&gt;/master.xml">
    <button type="submit">Open my player</button>
    <p class="status" id="status" role="status" aria-live="polite"></p>
  </form>
  <p class="hint">
    Install this page to your home screen, then use the download control on an
    episode to keep it on the device for offline listening.
  </p>
</main>
<script>
(() => {
  "use strict";
  const status = document.getElementById("status");
  const input = document.getElementById("feedUrl");
  const stored = (() => { try { return localStorage.getItem("audio-feed-token"); } catch { return null; } })();
  if (stored) {
    // Reopening from the home screen: straight to the player.
    location.replace("/listen/" + encodeURIComponent(stored));
    return;
  }
  /** Accepts a full feed URL or a bare token, because both are what people have. */
  const tokenFrom = (value) => {
    const trimmed = value.trim();
    const match = trimmed.match(/\\/feed\\/([^/]+)\\//);
    return match ? decodeURIComponent(match[1]) : trimmed;
  };
  document.getElementById("restore").addEventListener("submit", (event) => {
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
})();
</script>
</body>
</html>
`;
}
