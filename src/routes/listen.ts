/**
 * The listener web app at `GET /listen/:token` (audio-feed-4xb).
 *
 * Paul's directive: "a visual UI that represents the actual feed the user's gone
 * to ... embedded audio elements ... a service worker version and background
 * downloads ... its own mini podcast web app that the user can install and add to
 * home screen ... fronted by that user feed so we don't need a user sign in, they
 * can just sign in with their token".
 *
 * So: token-fronted, no accounts, no passwords. The feed token in the path IS the
 * credential a podcast client already uses, and this page treats it the same way —
 * it is the one secret the subscriber must have anyway.
 *
 * Interpretations worth stating, because the directive left them open:
 *
 * - ONE shared <audio> element with a sticky player bar, not N embedded players.
 *   The directive says "embedded audio elements" and also lists custom transport
 *   controls (scrub, ±15/30s, speed). Native per-episode players cannot do skip or
 *   rate, and N custom players would mean N media sessions. A single now-playing
 *   bar is the standard podcast-app shape and is what `navigator.mediaSession`
 *   expects.
 * - The page is SERVER-RENDERED with the episode list, then the service worker
 *   caches it network-first. Rendering client-side would make the offline
 *   experience depend on an API fetch that cannot succeed offline.
 * - Offline audio lives in its own cache (`audio-feed-offline-v1`) under the same
 *   URL the player uses, so "is this downloaded?" is a `caches.match()` and the
 *   offline playback path is just the service worker answering from cache. No
 *   parallel storage format, no re-implemented player for offline.
 * - Background Fetch is used where it exists because it survives the tab being
 *   closed; the `fetch()` + `cache.put` path is the fallback and the one that runs
 *   everywhere.
 * - The token is saved to localStorage so re-opening from the home screen lands on
 *   the player, and `/listen` (no token) can restore it. It is a capability, so it
 *   is treated as one: `no-store`, no referrer, and the page never echoes it into
 *   another origin.
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
  /** Stable, non-expiring enclosure URL served by GET /audio/:key. */
  audioUrl: string;
  /** Total episode count is not needed here; the list IS the feed's contents. */
}

export interface ListenPageOptions {
  token: string;
  subscriber: string;
  feedUrl: string;
  episodes: ListenEpisode[];
  offlineEnabled: boolean;
}

const OFFLINE_CACHE = "audio-feed-offline-v1";

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
<meta name="theme-color" content="#18181b">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="alternate" type="application/rss+xml" title="${esc(title)}" href="${esc(feedUrl)}">
<style>
  :root {
    color-scheme: dark;
    --bg: #09090b;
    --surface: #18181b;
    --surface-2: #232327;
    --text: #fafafa;
    --muted: #a1a1aa;
    --border: #2e2e34;
    --accent: #a78bfa;
    --accent-ink: #18181b;
    --ok: #4ade80;
    --radius: 12px;
    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); }
  body { padding-block-end: calc(7.5rem + env(safe-area-inset-bottom, 0px)); }
  a { color: var(--accent); }
  button { font: inherit; cursor: pointer; }

  header.app {
    position: sticky; inset-block-start: 0; z-index: 5;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(8px);
    border-block-end: 1px solid var(--border);
    padding: 1rem 1rem 0.75rem;
  }
  header.app h1 { font-size: 1.15rem; margin: 0 0 0.15rem; line-height: 1.25; }
  header.app .meta { color: var(--muted); font-size: 0.82rem; display: flex; flex-wrap: wrap; gap: 0.75rem; }
  main { padding: 1rem; max-inline-size: 46rem; margin-inline: auto; }

  ul.episodes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
  li.episode {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 0.85rem; display: grid; gap: 0.5rem;
  }
  li.episode[data-current="true"] { border-color: var(--accent); }
  .ep-title { font-weight: 600; margin: 0; }
  .ep-meta { color: var(--muted); font-size: 0.8rem; display: flex; flex-wrap: wrap; gap: 0.5rem 0.85rem; }
  .tag {
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.5rem; color: var(--muted);
  }
  .ep-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .btn {
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
    border-radius: 999px; padding: 0.4rem 0.85rem; min-block-size: 2.25rem;
  }
  .btn[data-primary="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .btn[aria-pressed="true"] { border-color: var(--ok); color: var(--ok); }
  .btn[disabled] { opacity: 0.55; cursor: not-allowed; }
  .empty { color: var(--muted); }

  /* Sticky player bar: the only place transport controls live. */
  .player {
    position: fixed; inset-block-end: 0; inset-inline: 0; z-index: 10;
    background: var(--surface); border-block-start: 1px solid var(--border);
    padding: 0.6rem 0.85rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  }
  .player-inner { max-inline-size: 46rem; margin-inline: auto; display: grid; gap: 0.45rem; }
  .now { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
  .now .title { font-weight: 600; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .now .time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.8rem; }
  .row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  input[type="range"] { flex: 1 1 10rem; min-inline-size: 0; accent-color: var(--accent); block-size: 1.5rem; }
  .skip { border: 1px solid var(--border); background: transparent; color: var(--text); border-radius: 999px; padding: 0.35rem 0.7rem; }
  .rate { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 999px; padding: 0.35rem 0.5rem; }
  .offline-badge { color: var(--muted); font-size: 0.78rem; }
  .hidden { display: none !important; }
  .notice { color: var(--muted); font-size: 0.82rem; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
</head>
<body>
<header class="app">
  <h1>${esc(subscriber)}</h1>
  <div class="meta">
    <span id="episodeCount">${episodes.length} episode${episodes.length === 1 ? "" : "s"}</span>
    <a id="rssLink" href="${esc(feedUrl)}">RSS feed</a>
    <span class="offline-badge" id="offlineStatus" role="status" aria-live="polite"></span>
  </div>
</header>

<main>
  <ul class="episodes" id="episodes"></ul>
  <p class="empty hidden" id="empty">Nothing ready yet. Episodes appear here once synthesis finishes.</p>
</main>

<!--
  A single media element for the whole app: one media session, one place for
  transport controls, and the same element playing cached or streamed bytes — the
  service worker decides which, so this code does not need an offline mode.
-->
<audio id="audio" preload="metadata" crossorigin="anonymous"></audio>

<section class="player" aria-label="Player">
  <div class="player-inner">
    <div class="now">
      <span class="title" id="nowTitle">Nothing playing</span>
      <span class="time" id="nowTime">0:00 / 0:00</span>
    </div>
    <div class="row">
      <button class="btn" id="playPause" data-primary="true" aria-label="Play" aria-pressed="false">▶︎</button>
      <button class="skip" id="back" aria-label="Skip back 15 seconds">−15s</button>
      <button class="skip" id="fwd" aria-label="Skip forward 30 seconds">+30s</button>
      <input type="range" id="seek" min="0" max="0" step="1" value="0" aria-label="Seek">
      <select class="rate" id="rate" aria-label="Playback speed">
        <option value="0.75">0.75×</option>
        <option value="1" selected>1×</option>
        <option value="1.25">1.25×</option>
        <option value="1.5">1.5×</option>
        <option value="2">2×</option>
      </select>
    </div>
    <p class="notice hidden" id="playerNotice" role="status" aria-live="polite"></p>
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

  // Remember the capability so a home-screen launch (start_url /listen) can restore
  // the player without the subscriber pasting anything again.
  try { localStorage.setItem("audio-feed-token", TOKEN); } catch { /* private mode */ }

  const audio = document.getElementById("audio");
  const list = document.getElementById("episodes");
  const empty = document.getElementById("empty");
  const playPause = document.getElementById("playPause");
  const seek = document.getElementById("seek");
  const rate = document.getElementById("rate");
  const nowTitle = document.getElementById("nowTitle");
  const nowTime = document.getElementById("nowTime");
  const offlineStatus = document.getElementById("offlineStatus");
  const playerNotice = document.getElementById("playerNotice");
  const downloaded = new Set();
  let current = null;
  let cache = null;

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
  const say = (message) => {
    playerNotice.textContent = message;
    playerNotice.classList.toggle("hidden", !message);
  };

  async function openOfflineCache() {
    if (!OFFLINE_ENABLED || !("caches" in window)) return null;
    if (!cache) cache = await caches.open(OFFLINE_CACHE);
    return cache;
  }

  /** "Downloaded" is the presence of the enclosure URL in our cache. No side list. */
  async function refreshDownloaded() {
    const store = await openOfflineCache();
    if (!store) return new Set();
    const keys = new Set((await store.keys()).map((request) => request.url));
    downloaded.clear();
    for (const episode of EPISODES) if (keys.has(episode.audioUrl)) downloaded.add(episode.id);
    return downloaded;
  }

  function episodeTitle(episode) {
    return episode.source ? episode.source + ": " + episode.title : episode.title;
  }

  function render() {
    list.replaceChildren();
    for (const episode of EPISODES) {
      const li = document.createElement("li");
      li.className = "episode";
      li.dataset.episodeId = episode.id;

      const h2 = document.createElement("h2");
      h2.className = "ep-title";
      h2.textContent = episode.title;
      li.append(h2);

      const meta = document.createElement("div");
      meta.className = "ep-meta";
      if (episode.author) meta.append(span(episode.author));
      if (episode.date) meta.append(span(new Date(episode.date).toLocaleDateString()));
      if (episode.source) meta.append(tag(episode.source));
      if (episode.mode) meta.append(tag(episode.mode === "deepdive" ? "deep dive" : "direct read"));
      if (episode.durationSeconds) meta.append(span(fmt(episode.durationSeconds)));
      li.append(meta);

      const actions = document.createElement("div");
      actions.className = "ep-actions";
      const play = document.createElement("button");
      play.className = "btn";
      play.dataset.primary = "true";
      play.dataset.action = "play";
      play.textContent = "Play";
      play.setAttribute("aria-label", "Play " + episode.title);
      play.addEventListener("click", () => select(episode, true));
      actions.append(play);

      const download = document.createElement("button");
      download.className = "btn";
      download.dataset.action = "download";
      download.textContent = downloaded.has(episode.id) ? "Downloaded" : "Download";
      download.setAttribute("aria-pressed", downloaded.has(episode.id) ? "true" : "false");
      download.setAttribute("aria-label", "Download " + episode.title + " for offline listening");
      if (!OFFLINE_ENABLED) {
        download.disabled = true;
        download.title = "This browser cannot store audio offline.";
      }
      download.addEventListener("click", () => downloadEpisode(episode, download));
      actions.append(download);
      li.append(actions);
      list.append(li);
    }
    empty.classList.toggle("hidden", EPISODES.length > 0);
  }

  const span = (text) => {
    const el = document.createElement("span");
    el.textContent = text;
    return el;
  };
  const tag = (text) => {
    const el = document.createElement("span");
    el.className = "tag";
    el.textContent = text;
    return el;
  };

  function select(episode, autoplay) {
    current = episode;
    audio.src = episode.audioUrl;
    nowTitle.textContent = episodeTitle(episode);
    for (const li of list.querySelectorAll("li.episode")) {
      li.dataset.current = String(li.dataset.episodeId === episode.id);
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: episode.title,
        artist: episode.author || "Audio Feed",
        album: episode.source || "Audio Feed",
        artwork: [{ src: ORIGIN + "/icon.svg", sizes: "any", type: "image/svg+xml" }],
      });
    }
    if (autoplay) void audio.play().catch(() => say("Press play to start — the browser blocked autoplay."));
  }

  function toggle() {
    if (!current) {
      if (EPISODES.length > 0) select(EPISODES[0], true);
      return;
    }
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }

  // ---- transport ----------------------------------------------------------
  playPause.addEventListener("click", toggle);
  document.getElementById("back").addEventListener("click", () => {
    audio.currentTime = Math.max(0, audio.currentTime - 15);
  });
  document.getElementById("fwd").addEventListener("click", () => {
    audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30);
  });
  seek.addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value);
  });
  rate.addEventListener("change", () => {
    audio.playbackRate = Number(rate.value);
  });

  audio.addEventListener("play", () => {
    playPause.textContent = "⏸";
    playPause.setAttribute("aria-label", "Pause");
    playPause.setAttribute("aria-pressed", "true");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  });
  audio.addEventListener("pause", () => {
    playPause.textContent = "▶︎";
    playPause.setAttribute("aria-label", "Play");
    playPause.setAttribute("aria-pressed", "false");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  });
  audio.addEventListener("loadedmetadata", () => {
    seek.max = String(audio.duration || 0);
    nowTime.textContent = fmt(audio.currentTime) + " / " + fmt(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    seek.value = String(audio.currentTime);
    nowTime.textContent = fmt(audio.currentTime) + " / " + fmt(audio.duration);
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
    say("That audio could not be played. If you are offline, download it while online first.");
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

  // ---- offline downloads --------------------------------------------------
  async function downloadEpisode(episode, button) {
    const store = await openOfflineCache();
    if (!store) {
      say("This browser cannot store audio offline.");
      return;
    }
    button.disabled = true;
    button.textContent = "Downloading…";
    say("Downloading " + episode.title + "…");
    try {
      // Foreground fetch + cache.put, and NO promise this page cannot keep.
      //
      // Background Fetch was attempted here and removed after measuring it twice in
      // headless Chrome: registration.backgroundFetch is EXPOSED and fetch() resolves,
      // yet getIds() stays empty, no success or failure event ever fires, and the button
      // hangs on "Downloading…". The reassurance shown in that state was false in
      // exactly the environment where the API looked available, so it is gone: this
      // page says only what it does. Detecting an API is not evidence that it works,
      // and the measurement plus the remaining work live in the follow-up bead instead
      // of in a promise to the subscriber.
      const response = await fetch(episode.audioUrl);
      if (!response.ok) throw new Error("HTTP " + response.status);
      await store.put(episode.audioUrl, response);
      downloaded.add(episode.id);
      button.textContent = "Downloaded";
      button.setAttribute("aria-pressed", "true");
      say("Saved for offline listening.");
    } catch (error) {
      button.textContent = "Download";
      say("Download failed: " + String(error.message || error));
    } finally {
      button.disabled = false;
      updateOfflineStatus();
    }
  }

  function updateOfflineStatus() {
    const parts = [];
    if (!navigator.onLine) parts.push("Offline");
    if (downloaded.size) parts.push(downloaded.size + " saved");
    offlineStatus.textContent = parts.join(" · ");
  }
  window.addEventListener("online", updateOfflineStatus);
  window.addEventListener("offline", updateOfflineStatus);

  // ---- boot ---------------------------------------------------------------
  async function boot() {
    const needsStatus = await refreshDownloaded();
    render();
    // Preselect the first episode so the bar shows something playable.
    if (EPISODES.length > 0 && !current) {
      nowTitle.textContent = episodeTitle(EPISODES[0]);
      audio.src = EPISODES[0].audioUrl;
      current = EPISODES[0];
      for (const li of list.querySelectorAll("li.episode")) {
        li.dataset.current = String(li.dataset.episodeId === current.id);
      }
    }
    void needsStatus;
    offlineStatus.textContent = "";
    updateOfflineStatus();

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
<meta name="theme-color" content="#18181b">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
<style>
  :root { color-scheme: dark; --bg:#09090b; --surface:#18181b; --text:#fafafa; --muted:#a1a1aa; --border:#2e2e34; --accent:#a78bfa; --accent-ink:#18181b; --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:var(--font); display:grid; place-items:center; min-block-size:100dvb; padding:1.5rem; }
  main { max-inline-size: 30rem; inline-size: 100%; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:1.5rem; }
  h1 { font-size:1.2rem; margin:0 0 0.4rem; }
  p { color:var(--muted); font-size:0.9rem; margin:0 0 1rem; }
  label { display:block; font-weight:600; font-size:0.9rem; margin-block-end:0.3rem; }
  input { inline-size:100%; font:inherit; padding:0.55rem 0.65rem; border-radius:9px; border:1px solid var(--border); background:var(--bg); color:var(--text); }
  button { font:inherit; margin-block-start:0.85rem; inline-size:100%; padding:0.6rem; border-radius:9px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  .status { margin-block-start:0.75rem; font-size:0.85rem; color:var(--muted); min-block-size:1.2rem; }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
  <h1>Listen to your feed</h1>
  <p>
    Open your personal feed URL (the one containing your feed token) and this
    player remembers it on this device. Nothing to sign in to.
  </p>
  <form id="restore">
    <label for="feedUrl">Your feed URL or token</label>
    <input id="feedUrl" name="feedUrl" type="text" autocomplete="off" spellcheck="false"
           placeholder="${esc(publicBaseUrl)}/feed/&lt;token&gt;/master.xml">
    <button type="submit">Open my player</button>
    <p class="status" id="status" role="status" aria-live="polite"></p>
  </form>
  <p class="status">
    Offline: install this page to your home screen, then use the Download button on
    an episode to keep it on the device.
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
      status.textContent = "Paste your feed URL or token first.";
      input.focus();
      return;
    }
    status.textContent = "Opening…";
    location.assign("/listen/" + encodeURIComponent(token));
  });
})();
</script>
</body>
</html>
`;
}
