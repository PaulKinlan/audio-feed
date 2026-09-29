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
import { assetUrl } from "./assets.ts";
import { DESIGN_TOKENS } from "./tokens.ts";
import { SPECULATION_RULES } from "./shell.ts";
import {
  type AudioMode,
  type Episode,
  isPublishable,
  isSynthesisAuthorized,
  type Source,
} from "../types.ts";

/** One row of the player's episode list, with everything the UI renders. */
/**
 * An episode the subscriber cannot play YET — being generated, or failed (audio-feed-7s2).
 *
 * Kept separate from `ListenEpisode` rather than widened with an optional `audioUrl`, because
 * every consumer of `ListenEpisode` assumes it can be played, downloaded and cached. Making the
 * unplayable state a different type is what stops that assumption from being quietly optional.
 */
export interface ListenActivity {
  id: string;
  title: string;
  source?: string;
  mode?: AudioMode;
  /** What the row is doing: waiting, in flight, or terminal-but-retryable. */
  state: "queued" | "generating" | "failed";
  /** ISO timestamp for the row's age: how long the subscriber has been waiting. */
  since?: string;
  /** Present only for a failed episode, and only from our own synthesis path. */
  error?: string;
}

/** The player's activity panel: what is coming, and what needs attention. */
export interface PlayerActivity {
  inProgress: ListenActivity[];
  failed: ListenActivity[];
  playable: number;
}

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
  /** Work in progress and work that failed (audio-feed-7s2). */
  activity?: PlayerActivity;
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
    <symbol id="i-share" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></g></symbol>
  </defs>
</svg>`;

export function renderListenPage(
  { token, subscriber, feedUrl, episodes, offlineEnabled, activity }: ListenPageOptions,
): string {
  const title = `${subscriber} — Audio Feed`;
  // Everything the client used to receive as six injected constants, in one JSON document. The
  // shapes are the server's own types (ListenEpisode, PlayerActivity), so src/assets/listen.js's
  // JSDoc and this object are the two ends of one contract.
  const playerData = {
    token,
    origin: new URL(feedUrl).origin,
    offlineCache: OFFLINE_CACHE,
    episodes,
    activity: activity ?? { inProgress: [], failed: [], playable: episodes.length },
    offlineEnabled,
  };
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="theme-color" content="#0a0a0c">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="icon" href="/icon.svg">
<link rel="alternate" type="application/rss+xml" title="${esc(title)}" href="${esc(feedUrl)}">
<link rel="stylesheet" href="${assetUrl("listen.css")}">
${SPECULATION_RULES}
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
  <!--
    audio-feed-7s2: work the subscriber could not previously see at all. Above the list, because
    it is what is happening NOW; the list below is what is finished. Rendered empty and filled
    from the payload, so the markup is static and only data goes through textContent.
  -->
  <section class="activity hidden" id="activity" aria-labelledby="activityHeading">
    <div class="list-head">
      <h2 id="activityHeading">In this feed</h2>
      <span id="activityHint"></span>
    </div>
    <ul class="activity-list" id="activityList"></ul>
  </section>

  <!-- audio-feed-3h1: filter episodes by source and by text -->
  <section class="filters hidden" id="filterSection" aria-label="Filter episodes" role="search">
    <div class="filter-controls">
      <div class="filter-field filter-search">
        <label for="filterText" class="sr-only">Filter episodes by title or author</label>
        <input type="search" id="filterText" placeholder="Search episodes…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="filter-field filter-select">
        <label for="filterSource" class="sr-only">Filter by publication</label>
        <select id="filterSource" aria-label="Filter by publication">
          <option value="">All sources</option>
        </select>
      </div>
    </div>
  </section>

  <div class="list-head">
    <h2>Episodes</h2>
    <span id="savedCount"></span>
  </div>
  <ul class="episodes" id="episodes"></ul>
  <p class="empty hidden" id="empty">
    <strong>No episodes yet</strong>
    Subscribe a feed or send an article, and finished audio appears here.
  </p>
  <div class="filter-empty hidden" id="filterEmpty" role="status" aria-live="polite">
    <p><strong>No matching episodes</strong></p>
    <p class="sub" id="filterEmptyMessage">No episodes match your filter.</p>
    <button type="button" class="btn quiet small" id="clearFilterBtn">Clear filters</button>
  </div>
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

  <!-- audio-feed-3xq: the player's client is a content-addressed module, and everything it needs is
       one JSON document. Data in the page, code in a file. -->
  <script type="application/json" id="player-data">${jsonForScript(playerData)}</script>
  <script type="module" src="${assetUrl("listen.js")}"></script>
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

/**
 * The bounded newest-first window both the page's rows and the activity panel are derived from
 * (audio-feed-3jb).
 *
 * Before this, one `/listen/*` load fired FOUR status-filtered scans (pending 100, synthesizing
 * 100, failed 20, ready 200); in kv.ts each entry in each scan cost a serial `getEpisode`
 * roundtrip, so a 200-episode feed meant 400-800 remote KV reads for one page. The panel is a
 * status indicator: the newest episodes are the ones that describe current activity, so one
 * bounded traversal is both cheaper and more honest than fanning out across statuses at depth.
 */
export const LISTEN_RECENT_SCAN = 300;

/**
 * The publishable rows the page lists: its EXISTING cap, left unchanged by this refactor
 * (the 200-episode cap is the feed builder's, audio-feed-2w8; a perf change must not change
 * user-visible page size). Paging — over the now-batched reads — is what keeps newer pending or
 * failed episodes from pushing ready ones off the page.
 */
export const LISTEN_ROW_CAP = 100;

/** How many episodes one paging request asks for. */
const LISTEN_PAGE_SIZE = 100;

interface PlayerWindow {
  /** Newest first, capped at LISTEN_RECENT_SCAN: the panel's window. */
  scanned: Episode[];
  /** Publishable, newest first, capped at LISTEN_ROW_CAP: the page's rows. */
  rows: Episode[];
}

/**
 * ONE newest-first traversal serving both the page rows and the panel window (audio-feed-3jb).
 * `listEpisodePage` batches its reads, so a deep row set costs pages of `getMany` chunks rather
 * than one remote roundtrip per entry.
 */
async function loadPlayerWindow(ctx: AppContext, userId: string): Promise<PlayerWindow> {
  const scanned: Episode[] = [];
  const rows: Episode[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx.stores.metadata.listEpisodePage({
      userId,
      limit: LISTEN_PAGE_SIZE,
      cursor,
    });
    if (page.episodes.length === 0) break;
    for (const episode of page.episodes) {
      if (scanned.length < LISTEN_RECENT_SCAN) scanned.push(episode);
      if (rows.length < LISTEN_ROW_CAP && isPublishable(episode)) rows.push(episode);
    }
    cursor = page.cursor === cursor ? undefined : page.cursor;
    if (!cursor) break;
    if (scanned.length >= LISTEN_RECENT_SCAN && rows.length >= LISTEN_ROW_CAP) break;
  }
  return { scanned, rows };
}

/** The activity panel, derived IN MEMORY from the one scanned window — no extra store reads. */
function activityFrom(
  episodes: Episode[],
  sources: Source[],
  limit = 20,
  failedEpisodes?: Episode[],
): PlayerActivity {
  const sourceTitles = new Map(sources.map((source) => [source.id, source.title]));

  // A regenerating episode is pending but STILL PLAYABLE (audio-feed-8oz), so it belongs in the
  // episode list and must not be doubled up here — a row that appears as both playable and
  // "generating" is how a subscriber learns to distrust the indicator.
  const queued = episodes
    .filter((episode) =>
      !isPublishable(episode) && (episode.status === "pending" || episode.status === "synthesizing")
    )
    .slice(0, limit);

  const toRow = (episode: Episode, state: ListenActivity["state"]): ListenActivity => ({
    id: episode.id,
    title: episode.title,
    source: sourceTitles.get(episode.sourceId),
    mode: episode.mode,
    state,
    since: episode.createdAt,
    // The reason is our own string (worker/TTS), never subscriber-controlled text — and it is
    // still rendered with textContent on the client, like every other untrusted value here.
    error: episode.status === "failed" ? episode.error : undefined,
  });

  // audio-feed-6y9: ensure failed episodes are always visible regardless of window paging
  const allFailed = [...(failedEpisodes ?? [])];
  for (const ep of episodes) {
    if (ep.status === "failed" && !allFailed.some((f) => f.id === ep.id)) {
      allFailed.push(ep);
    }
  }

  // audio-feed-cls, audio-feed-j8o: filter out stale failures that have already been reprocessed into ready/queued episodes
  const isSuperceded = (failed: Episode) => {
    return episodes.some((live) => {
      if (live.id === failed.id) return false;
      const isLive = isPublishable(live) || live.status === "pending" ||
        live.status === "synthesizing";
      if (!isLive) return false;
      // F1: Only supersede when the live/publishable episode is strictly NEWER than the failure
      const isNewer = live.createdAt > failed.createdAt;
      if (!isNewer) return false;
      // F2: Mode equality — absence is not agreement; require exact mode match or both missing
      const sameMode = live.mode === failed.mode;
      if (!sameMode) return false;
      // audio-feed-j8o: match across re-minted articleId via title and source
      const sameTitle = Boolean(live.title && failed.title && live.title === failed.title);
      if (!sameTitle) return false;
      const sameIdentity = Boolean(
        live.articleId && failed.articleId && live.articleId === failed.articleId,
      ) || Boolean(
        (live.sourceId && failed.sourceId && live.sourceId === failed.sourceId) ||
          (live.sourceTitle && failed.sourceTitle && live.sourceTitle === failed.sourceTitle),
      );
      return sameIdentity;
    });
  };

  const activeFailed = allFailed.filter((f) => !isSuperceded(f));

  return {
    inProgress: queued.map((episode) =>
      toRow(episode, episode.status === "synthesizing" ? "generating" : "queued")
    ),
    failed: activeFailed
      .slice(0, limit)
      .map((episode) => toRow(episode, "failed")),
    // Counted with the SAME rule the page lists by: publishable, which includes a regenerating
    // episode still playing its old audio (audio-feed-8oz). Counting only status "ready" here
    // made the poll disagree with the page it is refreshing — the player offered an episode the
    // status endpoint reported as zero playable — so the two definitions had to be unified.
    // Bounded by the scanned window: "up to a few hundred" is what this panel is worth.
    playable: episodes.filter(isPublishable).length,
  };
}

/** One structured duration line per listen request (audio-feed-3jb) — never the token. */
function logListenTiming(route: string, fields: Record<string, number>): void {
  console.log(JSON.stringify({ event: "listen.timing", route, ...fields }));
}

/** The activity panel for the status poll: the same one-window derivation (audio-feed-3jb). */
export async function playerActivity(
  ctx: AppContext,
  userId: string,
  limit = 20,
): Promise<PlayerActivity> {
  const [window, sources, failedEpisodes] = await Promise.all([
    loadPlayerWindow(ctx, userId),
    ctx.stores.metadata.listSources(userId),
    ctx.stores.metadata.listEpisodes({ userId, status: "failed", limit }),
  ]);
  return activityFrom(window.scanned, sources, limit, failedEpisodes);
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

  // ONE newest-first traversal serves the page rows and the panel window (audio-feed-3jb). Rows
  // are publishable, not `status: "ready"`: a regenerating episode is pending but still plays its
  // old audio (audio-feed-8oz). Paging continues to LISTEN_ROW_CAP so newer pending or failed
  // episodes cannot push ready ones off the page.
  // Explicitly fetch failed episodes so they are never missed by the activity panel (audio-feed-6y9).
  const dbStart = performance.now();
  const [{ scanned, rows: publishable }, sources, failedEpisodes] = await Promise.all([
    loadPlayerWindow(ctx, user.id),
    ctx.stores.metadata.listSources(user.id),
    ctx.stores.metadata.listEpisodes({ userId: user.id, status: "failed", limit: 20 }),
  ]);
  const sourceTitles = new Map(sources.map((source) => [source.id, source.title]));

  // The author lives on the article, not the episode. These lookups are BATCHED (one `getMany`
  // per chunk, audio-feed-3jb): a per-row await here was another serial remote read per row.
  const articles = await ctx.stores.metadata.getArticles(
    user.id,
    publishable.map((episode) => episode.articleId),
  );

  const rows: ListenEpisode[] = publishable.map((episode, index) => {
    const article = articles[index] ?? null;
    return {
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
    };
  });

  const activity = activityFrom(scanned, sources, 20, failedEpisodes);
  // The page's own list is already the authoritative playable set, paged above; counting it here
  // keeps the header number and the rows in agreement by construction.
  activity.playable = rows.length;
  const dbMs = performance.now() - dbStart;

  const renderStart = performance.now();
  const html = renderListenPage({
    token,
    subscriber: user.displayName || user.email,
    feedUrl: `${origin.baseUrl}/feed/${encodeURIComponent(token)}/master.xml`,
    episodes: rows,
    activity,
    // Offline storage needs Cache Storage; without it the page still plays online.
    offlineEnabled: true,
  });
  const renderMs = performance.now() - renderStart;
  logListenTiming("page", {
    dbMs,
    renderMs,
    rows: rows.length,
    scanned: scanned.length,
    inProgress: activity.inProgress.length,
    failed: activity.failed.length,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A capability-bearing page: never in a shared cache.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "server-timing": `db;dur=${dbMs.toFixed(1)}, render;dur=${renderMs.toFixed(1)}`,
    },
  });
}

/**
 * `GET /listen/:token/status` — the activity panel's poll (audio-feed-7s2).
 *
 * Same capability as the page itself: the token in the path is the credential, and a caller
 * without it already cannot read the feed. `no-store` is not a nicety here — a cached status
 * response would show a subscriber work that finished minutes ago.
 */
export async function handleListenStatus(
  { ctx, params }: RouteContext<AppContext>,
): Promise<Response> {
  const token = await resolveTokenValue(ctx, (params.token ?? "").trim());
  if (!token) return notFound("Unknown feed");
  const user = await getUserByFeedToken(ctx.stores.metadata, token);
  if (!user) return notFound("Unknown feed");
  if (user.status !== "approved") {
    return forbidden(`Feed unavailable (status: ${user.status})`);
  }
  const dbStart = performance.now();
  const activity = await playerActivity(ctx, user.id);
  const dbMs = performance.now() - dbStart;

  const renderStart = performance.now();
  const body = JSON.stringify(activity);
  const renderMs = performance.now() - renderStart;
  logListenTiming("status", {
    dbMs,
    renderMs,
    inProgress: activity.inProgress.length,
    failed: activity.failed.length,
    playable: activity.playable,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "server-timing": `db;dur=${dbMs.toFixed(1)}, render;dur=${renderMs.toFixed(1)}`,
    },
  });
}

/**
 * `POST /listen/:token/episodes/:episodeId/retry` — the subscriber's "try again"
 * (audio-feed-7s2).
 *
 * Scoped by the token that authenticated the page, and the episode is looked up under that
 * user id, so another subscriber's episode is simply not found: the response is the same 404
 * as for an id that does not exist at all, which is what keeps a retry route from becoming an
 * existence oracle over other users' episodes.
 */
export async function handleListenRetry(
  { ctx, params }: RouteContext<AppContext>,
): Promise<Response> {
  const token = await resolveTokenValue(ctx, (params.token ?? "").trim());
  if (!token) return notFound("Unknown feed");
  const user = await getUserByFeedToken(ctx.stores.metadata, token);
  if (!user) return notFound("Unknown feed");
  if (!isSynthesisAuthorized(user)) {
    return forbidden(`Retry unavailable (status: ${user.status})`);
  }
  const episodeId = (params.episodeId ?? "").trim();
  if (!episodeId) return notFound("Unknown episode");

  const episode = await ctx.stores.metadata.getEpisode(user.id, episodeId);
  if (!episode) return notFound("Unknown episode");
  if (episode.status !== "failed") {
    // 409, not 404: this IS the caller's episode, and the honest answer is that it is not in a
    // state that can be retried. Requeueing a playable one is a different action with different
    // semantics, and silently doing it here would drop the old audio out of the feed.
    return new Response(JSON.stringify({ error: "Episode is not failed" }), {
      status: 409,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const queued = await ctx.stores.metadata.retryEpisode(user.id, episodeId);
  if (!queued) return notFound("Unknown episode");
  return new Response(JSON.stringify({ queued: true, episodeId: queued.id }), {
    status: 202,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const notFound = (message: string) =>
  Response.json({ error: message }, { status: 404, headers: { "cache-control": "no-store" } });
const forbidden = (message: string) =>
  Response.json({ error: message }, { status: 403, headers: { "cache-control": "no-store" } });

/** `/listen` without a token: restore from localStorage, or paste a feed URL. */
export function renderListenLanding(publicBaseUrl: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Audio Feed — listen</title>
<meta name="theme-color" content="#0a0a0c">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
${SPECULATION_RULES}
<style>
  ${DESIGN_TOKENS}
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
