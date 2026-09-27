/**
 * audio-feed-3xq — the player's client as a real module instead of a string inside a template
 * literal.
 *
 * `// @ts-check` plus `/// <reference lib="dom" />` is what makes this file visible to the gate:
 * `deno check` reads a .js file carrying @ts-check, and it reaches this one because listen.ts
 * imports it as text. Before this move ~670 lines of browser code were checked by nothing — which is
 * how audio-feed-7s2 shipped a CSS block into an @media query that only misbehaved for users WITHOUT
 * reduced motion, caught by a human driving Chrome.
 *
 * Served verbatim at /assets/<hash>.listen.js, so: plain ESM, no TypeScript syntax, no build step.
 * Types come from JSDoc and inference.
 */
// deno-lint-ignore-file no-window no-window-prefix
// Deno's window rules exist because Deno removed the `window` global. This file is never executed by
// Deno: it is served verbatim to a browser at /assets/<hash>.listen.js, where `window` is the correct
// global and `beforeinstallprompt` is a window event. Rewriting browser code to satisfy a Deno-only
// rule would trade a clear global for a bare one and tell the next reader nothing.
// @ts-check
/// <reference lib="dom" />

/**
 * The row shape the server builds in handleListen / renderListenPage. Declared here rather than
 * imported because the browser cannot import the server's types; the server's own ListenEpisode
 * interface is the authority this must match.
 * @typedef {object} PlayerEpisode
 * @property {string} id
 * @property {string} title
 * @property {string} [author]
 * @property {string} [date]
 * @property {string} [source]
 * @property {string} [mode]
 * @property {number} [durationSeconds]
 * @property {number} [byteLength]
 * @property {string} [articleUrl]
 * @property {string} audioUrl
 */

/**
 * @typedef {object} ActivityEntry
 * @property {string} id
 * @property {string} title
 * @property {string} [source]
 * @property {string} [mode]
 * @property {"queued"|"generating"|"failed"} state
 * @property {string} [since]
 * @property {string} [error]
 */

/**
 * @typedef {object} PlayerActivity
 * @property {ActivityEntry[]} [inProgress]
 * @property {ActivityEntry[]} [failed]
 * @property {number} [playable]
 */

/**
 * @typedef {object} PlayerData
 * @property {string} [token]
 * @property {string} [origin]
 * @property {string} [offlineCache]
 * @property {PlayerEpisode[]} [episodes]
 * @property {PlayerActivity} [activity]
 * @property {boolean} [offlineEnabled]
 */

/**
 * Background Fetch is not in the DOM lib — the code probes for it at runtime, which is the entire
 * lesson of audio-feed-98i. Loosely typed on purpose: these are feature detections, not assumptions.
 * @typedef {{ fetch?: (id: string, requests: unknown, options?: unknown) => Promise<unknown>,
 *   get?: (id: string) => Promise<unknown>, getIds?: () => Promise<string[]> }} BackgroundFetchManager
 * @typedef {object} BeforeInstallPromptEventLike
 * @property {() => void} prompt
 * @property {Promise<{outcome: string}>} userChoice
 */
/**
 * @typedef {ServiceWorkerRegistration & { backgroundFetch?: BackgroundFetchManager }} RegistrationWithBackgroundFetch
 */

/**
 * The slice of a Background Fetch record this file reads. Not in the DOM lib, so it is declared
 * against usage rather than guessed at: `unknown` on the members the code only compares or passes
 * on, and the numeric fields are optional because a record that has not started reports none.
 * @typedef {object} BackgroundFetchRecordLike
 * @property {(id: string) => void} [registerDownloadId]
 * @property {(reason?: string) => void} [acceptServers]
 * @property {(reason?: string) => void} [complete]
 * @property {() => void} [cancel]
 * @property {(type: string, listener: () => void) => void} addEventListener
 * @property {number} [downloadTotal]
 * @property {number} [downloaded]
 * @property {unknown} [result]
 * @property {string} [failureReason]
 */

/**
 * The player's data, injected as JSON rather than as code. `player-data` is data the server
 * writes and the client reads, so neither side has to be a string inside the other — which is the
 * whole point of audio-feed-3xq.
 */
const dataElement = document.getElementById("player-data");
/** @type {PlayerData} */
const DATA = dataElement
  ? JSON.parse(dataElement.textContent || "{}")
  : /** @type {PlayerData} */ ({});

const TOKEN = DATA.token ?? "";
const ORIGIN = DATA.origin ?? "";
const OFFLINE_CACHE = DATA.offlineCache ?? "audio-feed-offline-v1";
const EPISODES = DATA.episodes ?? [];
const ACTIVITY = DATA.activity ?? { inProgress: [], failed: [], playable: EPISODES.length };
const OFFLINE_ENABLED = DATA.offlineEnabled ?? true;
const SVG_NS = "http://www.w3.org/2000/svg";

// Remember the capability so a home-screen launch (start_url /listen) can restore
// the player without the subscriber pasting anything again.
try {
  localStorage.setItem("audio-feed-token", TOKEN);
} catch { /* private mode */ }

/**
 * @typedef {object} SavedPosition
 * @property {number} position
 * @property {number} updatedAt
 */

// audio-feed-kzi: local-first playback position persistence.
// Scoped per-token so a shared device with multiple subscribers keeps positions isolated.
const POSITIONS_KEY = TOKEN ? `audio-feed-positions:${TOKEN}` : "audio-feed-positions";

/** @returns {Record<string, SavedPosition>} */
function loadPositions() {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} episodeId
 * @param {number} seconds
 */
function savePosition(episodeId, seconds) {
  if (!episodeId) return;
  try {
    const positions = loadPositions();
    // Seeking to near-zero clears the resume position so it doesn't haunt the item.
    if (seconds <= 2) {
      delete positions[episodeId];
    } else {
      positions[episodeId] = { position: Math.round(seconds), updatedAt: Date.now() };
      // Bounded storage: keep newest 50 positions per token.
      const keys = Object.keys(positions);
      if (keys.length > 50) {
        keys
          .sort((a, b) => (positions[a]?.updatedAt ?? 0) - (positions[b]?.updatedAt ?? 0))
          .slice(0, keys.length - 50)
          .forEach((k) => delete positions[k]);
      }
    }
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // Private mode / storage quota exception handled safely without breaking player.
  }
}

/** @param {string} episodeId */
function clearPosition(episodeId) {
  if (!episodeId) return;
  try {
    const positions = loadPositions();
    if (positions[episodeId]) {
      delete positions[episodeId];
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
    }
  } catch {
    // Private mode
  }
}

/**
 * @param {string} episodeId
 * @returns {number}
 */
function getPosition(episodeId) {
  if (!episodeId) return 0;
  try {
    const positions = loadPositions();
    const entry = positions[episodeId];
    return entry && typeof entry.position === "number" ? entry.position : 0;
  } catch {
    return 0;
  }
}

/**
 * Every id the player looks up is rendered by renderListenPage in the same deploy that serves this
 * file, so a missing element means page and asset are out of step — a broken build, not a runtime
 * state to recover from. Checked once here rather than optional-chained at all 60 uses, because 60
 * `?.` would turn a loud deploy bug into a player that silently does nothing.
 * @param {string} id
 */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`player shell is missing #${id}`);
  return el;
};
// The three elements whose properties the player drives. Without the casts the type is HTMLElement
// and every audio/seek/rate property access is "does not exist"; the casts say what the markup
// already guarantees.
const audio = /** @type {HTMLAudioElement} */ (/** @type {unknown} */ ($("audio")));
const list = $("episodes");
const empty = $("empty");
const playPause = $("playPause");
const playIcon = $("playIcon");
const seek = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($("seek")));
const rate = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ ($("rate")));
const backBtn = $("back");
const fwdBtn = $("fwd");
const nowTitle = $("nowTitle");
const nowSub = $("nowSub");
const nowRead = /** @type {HTMLAnchorElement} */ (/** @type {unknown} */ ($("nowRead")));
const nowTime = $("nowTime");
const nowDuration = $("nowDuration");
const nowOffline = $("nowOffline");
const offlineStatus = $("offlineStatus");
const savedCount = $("savedCount");
const playerNotice = $("playerNotice");
const installBtn = /** @type {HTMLButtonElement} */ (/** @type {unknown} */ ($("installBtn")));

// audio-feed-3h1: filtering controls
const filterSection = $("filterSection");
const filterText = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($("filterText")));
const filterSource = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ ($("filterSource")));
const filterEmpty = $("filterEmpty");
const filterEmptyMessage = $("filterEmptyMessage");
const clearFilterBtn = $("clearFilterBtn");
const episodeCount = $("episodeCount");

const downloaded = new Set();
/** @type {PlayerEpisode|null} */
let current = null;
/** @type {Cache|null} */
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
/** @param {string} name @param {string} [cls] */
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
/** @param {Element} svg @param {string} name */
function setIcon(svg, name) {
  const use = svg.querySelector("use");
  if (use) use.setAttribute("href", "#i-" + name);
}

/** @param {number} seconds */
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
/** @param {string} [iso] */
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

/** @param {string} message @param {string} [tone] */
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

/** @param {PlayerEpisode} episode */
async function isCached(episode) {
  const store = await openOfflineCache();
  if (!store) return false;
  return Boolean(await store.match(episode.audioUrl));
}

// ---- episode rows -------------------------------------------------------

/** @param {string} text @param {string} [cls] */
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

/** @param {HTMLButtonElement} button @param {string} state @param {string} [label] */
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

/** @param {PlayerEpisode} episode */
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
  play.addEventListener("click", () => {
    const pos = getPosition(episode.id);
    const dur = episode.durationSeconds || 0;
    const isResume = pos > 5 && (dur === 0 || pos < dur - 5);
    void select(episode, true, isResume ? pos : 0);
  });
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

  updateRowResumeUI(li, episode);

  return li;
}

/**
 * @param {HTMLLIElement} li
 * @param {PlayerEpisode} episode
 */
function updateRowResumeUI(li, episode) {
  const play = /** @type {HTMLButtonElement|null} */ (li.querySelector("button.ep-play"));
  const meta = li.querySelector(".ep-meta");
  const actions = li.querySelector(".ep-actions");
  if (!play || !meta || !actions) return;

  const pos = getPosition(episode.id);
  const dur = episode.durationSeconds || 0;
  const isResume = pos > 5 && (dur === 0 || pos < dur - 5);

  play.dataset.action = isResume ? "resume" : "play";
  play.setAttribute(
    "aria-label",
    isResume ? "Resume " + episode.title + " from " + fmt(pos) : "Play " + episode.title,
  );

  const existingBadge = meta.querySelector(".ep-resume-badge");
  if (isResume) {
    if (existingBadge) {
      existingBadge.textContent = "Resume from " + fmt(pos);
      existingBadge.setAttribute("data-position", String(pos));
    } else {
      const badge = span("Resume from " + fmt(pos), "ep-resume-badge");
      badge.setAttribute("data-position", String(pos));
      meta.appendChild(dot());
      meta.appendChild(badge);
    }
  } else if (existingBadge) {
    const prev = existingBadge.previousElementSibling;
    if (prev && prev.classList.contains("dot")) prev.remove();
    existingBadge.remove();
  }

  const existingRestart = actions.querySelector(".ep-restart");
  if (isResume) {
    if (!existingRestart) {
      const restart = document.createElement("button");
      restart.type = "button";
      restart.className = "ep-restart";
      restart.dataset.action = "restart";
      restart.setAttribute("aria-label", "Play from start: " + episode.title);
      restart.textContent = "Play from start";
      restart.addEventListener("click", () => {
        savePosition(episode.id, 0);
        clearPosition(episode.id);
        updateRowResumeUI(li, episode);
        void select(episode, true, 0);
      });
      const downloadBtn = actions.querySelector(".ep-download");
      if (downloadBtn) actions.insertBefore(restart, downloadBtn);
      else actions.appendChild(restart);
    }
  } else if (existingRestart) {
    existingRestart.remove();
  }
}

// ── activity panel (audio-feed-7s2) ────────────────────────────────────────
const activitySection = $("activity");
const activityList = $("activityList");

/** @param {ActivityEntry} entry @param {boolean} failed */
function activityRow(entry, failed) {
  const li = document.createElement("li");
  li.className = "act";
  li.dataset.state = failed ? "failed" : entry.state;
  li.dataset.episodeId = entry.id;

  const dot = document.createElement("span");
  dot.className = "act-dot";
  dot.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "act-title";
  title.textContent = entry.title;
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "act-meta";
  meta.textContent = [entry.source, entry.mode === "deepdive" ? "Deep dive" : "Direct read"]
    .filter(Boolean).join(" · ");
  body.appendChild(meta);

  const state = document.createElement("div");
  state.className = "act-state";
  state.appendChild(dot);
  const stateText = document.createElement("span");
  stateText.textContent = failed
    ? "Failed"
    : entry.state === "generating"
    ? "Generating…"
    : "Queued";
  state.appendChild(stateText);
  body.appendChild(state);

  if (failed) {
    // The reason is our own synthesis error string, and it is still textContent: a failure
    // message that quotes subscriber-controlled input (a feed title, an upstream body
    // fragment) must not be able to become markup.
    if (entry.error) {
      const err = document.createElement("div");
      err.className = "act-error";
      err.textContent = entry.error;
      body.appendChild(err);
    }
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "act-retry";
    retry.textContent = "Try again";
    retry.setAttribute("aria-label", "Try again: " + entry.title);
    retry.addEventListener("click", () => retryEpisode(entry.id, retry));
    body.appendChild(retry);
  }

  li.appendChild(body);
  return li;
}

/** @param {PlayerActivity} payload */
function renderActivity(payload) {
  const inProgress = payload.inProgress ?? [];
  const failed = payload.failed ?? [];
  activityList.replaceChildren(
    ...inProgress.map((entry) => activityRow(entry, false)),
    ...failed.map((entry) => activityRow(entry, true)),
  );
  activitySection.classList.toggle("hidden", inProgress.length + failed.length === 0);
  // Announce only when the set changes, so a 15s poll is not a 15s metronome.
  const summary = failed.length
    ? inProgress.length + " in progress, " + failed.length + " needs attention"
    : inProgress.length
    ? inProgress.length + " in progress"
    : "";
  activitySection.setAttribute("aria-label", summary || "Activity");
}

/** @param {string} id @param {HTMLButtonElement} button */
async function retryEpisode(id, button) {
  button.disabled = true;
  try {
    const res = await fetch(
      ORIGIN + "/listen/" + encodeURIComponent(TOKEN) + "/episodes/" + encodeURIComponent(id) +
        "/retry",
      { method: "POST" },
    );
    if (!res.ok) {
      button.disabled = false;
      button.textContent = res.status === 404 ? "Gone" : "Could not retry";
      return;
    }
    button.textContent = "Queued";
    await refreshActivity();
  } catch {
    button.disabled = false;
    button.textContent = "Could not retry";
  }
}

async function refreshActivity() {
  try {
    const res = await fetch(ORIGIN + "/listen/" + encodeURIComponent(TOKEN) + "/status", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const data = await res.json();
    ACTIVITY.inProgress = data.inProgress ?? [];
    ACTIVITY.failed = data.failed ?? [];
    render();
  } catch { /* offline: the next online poll, or a reload, corrects it */ }
}

// ── filtering (audio-feed-3h1) ──────────────────────────────────────────
const FILTER_KEY = TOKEN ? `audio-feed-filter:${TOKEN}` : "audio-feed-filter";

function loadFilterState() {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return { source: "", text: "" };
    const parsed = JSON.parse(raw);
    return {
      source: typeof parsed?.source === "string" ? parsed.source : "",
      text: typeof parsed?.text === "string" ? parsed.text : "",
    };
  } catch {
    return { source: "", text: "" };
  }
}

/**
 * @param {string} source
 * @param {string} text
 */
function saveFilterState(source, text) {
  try {
    if (!source && !text) {
      localStorage.removeItem(FILTER_KEY);
    } else {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ source, text }));
    }
  } catch {
    // Private mode / storage quota exception handled safely
  }
}

function populateSourceFilter() {
  const sources = new Set();
  for (const ep of EPISODES) {
    if (ep.source) sources.add(ep.source);
  }
  for (const act of (ACTIVITY.inProgress ?? [])) {
    if (act.source) sources.add(act.source);
  }
  for (const act of (ACTIVITY.failed ?? [])) {
    if (act.source) sources.add(act.source);
  }
  const sorted = Array.from(sources).sort((a, b) => String(a).localeCompare(String(b)));

  const currentVal = filterSource.value;
  filterSource.replaceChildren();
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All sources";
  filterSource.appendChild(allOpt);

  for (const s of sorted) {
    const opt = document.createElement("option");
    opt.value = String(s);
    opt.textContent = String(s);
    filterSource.appendChild(opt);
  }
  if (currentVal && sources.has(currentVal)) {
    filterSource.value = currentVal;
  }
}

function render() {
  populateSourceFilter();
  const selectedSource = filterSource.value.trim().toLowerCase();
  const searchText = filterText.value.trim().toLowerCase();
  const isFiltered = Boolean(selectedSource || searchText);

  /** @param {PlayerEpisode} ep */
  const matchesEpisode = (ep) => {
    if (selectedSource && (ep.source || "").toLowerCase() !== selectedSource) return false;
    if (searchText) {
      const titleMatch = (ep.title || "").toLowerCase().includes(searchText);
      const sourceMatch = (ep.source || "").toLowerCase().includes(searchText);
      const authorMatch = (ep.author || "").toLowerCase().includes(searchText);
      if (!titleMatch && !sourceMatch && !authorMatch) return false;
    }
    return true;
  };

  /** @param {ActivityEntry} act */
  const matchesActivity = (act) => {
    if (selectedSource && (act.source || "").toLowerCase() !== selectedSource) return false;
    if (searchText) {
      const titleMatch = (act.title || "").toLowerCase().includes(searchText);
      const sourceMatch = (act.source || "").toLowerCase().includes(searchText);
      if (!titleMatch && !sourceMatch) return false;
    }
    return true;
  };

  const filteredEpisodes = EPISODES.filter(matchesEpisode);
  // Consistent filtering across panels (audio-feed-3h1): activity rows are filtered by the
  // same active source and text criteria as episodes. This ensures the entire view represents
  // the user's selected scope rather than showing unrelated publications in the activity banner.
  const filteredActivity = {
    inProgress: (ACTIVITY.inProgress ?? []).filter(matchesActivity),
    failed: (ACTIVITY.failed ?? []).filter(matchesActivity),
    playable: filteredEpisodes.length,
  };

  list.replaceChildren();
  for (const episode of filteredEpisodes) list.appendChild(row(episode));

  renderActivity(filteredActivity);

  // Honest empty states (audio-feed-3h1)
  if (EPISODES.length === 0) {
    empty.classList.remove("hidden");
    filterEmpty.classList.add("hidden");
    filterSection.classList.add("hidden");
  } else {
    empty.classList.add("hidden");
    filterSection.classList.remove("hidden");
    if (
      filteredEpisodes.length === 0 &&
      filteredActivity.inProgress.length === 0 &&
      filteredActivity.failed.length === 0
    ) {
      filterEmpty.classList.remove("hidden");
      const terms = [];
      if (filterSource.value) terms.push(`source "${filterSource.value}"`);
      if (filterText.value.trim()) terms.push(`search "${filterText.value.trim()}"`);
      filterEmptyMessage.textContent = "No episodes match " + terms.join(" and ") + ".";
    } else {
      filterEmpty.classList.add("hidden");
    }
  }

  // Update header count honestly (audio-feed-3h1)
  const total = EPISODES.length;
  if (!isFiltered) {
    episodeCount.textContent = total + " episode" + (total === 1 ? "" : "s");
  } else {
    episodeCount.textContent = filteredEpisodes.length + " of " + total + " episode" +
      (total === 1 ? "" : "s");
  }

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

/** @param {PlayerEpisode} episode @param {boolean} autoplay @param {number} [startPos] */
async function select(episode, autoplay, startPos) {
  current = episode;
  const isSameSrc = audio.src === episode.audioUrl;
  if (!isSameSrc) {
    audio.src = episode.audioUrl;
  }
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
    // querySelectorAll hands back Element; these are the <li> rows row() builds, and dataset is
    // the whole reason they are selected. The cast says what the selector already guarantees.
    const row = /** @type {HTMLLIElement} */ (li);
    row.dataset.current = String(row.dataset.episodeId === episode.id);
  }
  nowOffline.classList.toggle("hidden", !downloaded.has(episode.id));

  const seekTarget = typeof startPos === "number" ? startPos : 0;
  if (seekTarget > 0) {
    if (audio.readyState >= 1) {
      audio.currentTime = seekTarget;
      setProgress();
    } else {
      /** @type {() => void} */
      const onLoaded = () => {
        audio.removeEventListener("loadedmetadata", onLoaded);
        if (current?.id === episode.id) {
          audio.currentTime = seekTarget;
          setProgress();
          if ("mediaSession" in navigator && audio.duration) {
            try {
              navigator.mediaSession.setPositionState({
                duration: audio.duration,
                playbackRate: audio.playbackRate,
                position: audio.currentTime,
              });
            } catch { /* unsupported position state */ }
          }
        }
      };
      audio.addEventListener("loadedmetadata", onLoaded);
    }
  } else {
    audio.currentTime = 0;
    setProgress();
  }

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
    const first = EPISODES[0];
    if (first) {
      const pos = getPosition(first.id);
      const dur = first.durationSeconds || 0;
      const isResume = pos > 5 && (dur === 0 || pos < dur - 5);
      void select(first, true, isResume ? pos : 0);
    }
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
  if (Number.isFinite(audio.duration)) {
    audio.currentTime = Number(seek.value);
    if (current) {
      if (audio.currentTime <= 2) {
        clearPosition(current.id);
      } else {
        savePosition(current.id, audio.currentTime);
      }
      const rowEl = /** @type {HTMLLIElement|null} */ (list.querySelector(
        `li[data-episode-id="${current.id}"]`,
      ));
      if (rowEl) updateRowResumeUI(rowEl, current);
    }
  }
  setProgress();
});
rate.addEventListener("change", () => {
  audio.playbackRate = Number(rate.value);
});

let lastSavedTime = 0;
let lastSavedRealTime = 0;

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
  if (current && audio.currentTime > 2) {
    savePosition(current.id, audio.currentTime);
    const rowEl = /** @type {HTMLLIElement|null} */ (list.querySelector(
      `li[data-episode-id="${current.id}"]`,
    ));
    if (rowEl) updateRowResumeUI(rowEl, current);
  }
});
audio.addEventListener("ended", () => {
  if (current) {
    clearPosition(current.id);
    const rowEl = /** @type {HTMLLIElement|null} */ (list.querySelector(
      `li[data-episode-id="${current.id}"]`,
    ));
    if (rowEl) updateRowResumeUI(rowEl, current);
  }
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

  // Throttle position persistence: at most once every 3s of media or clock time
  if (current && audio.currentTime > 2) {
    const now = Date.now();
    if (Math.abs(audio.currentTime - lastSavedTime) >= 3 || now - lastSavedRealTime >= 3000) {
      lastSavedTime = audio.currentTime;
      lastSavedRealTime = now;
      savePosition(current.id, audio.currentTime);
      const rowEl = /** @type {HTMLLIElement|null} */ (list.querySelector(
        `li[data-episode-id="${current.id}"]`,
      ));
      if (rowEl) updateRowResumeUI(rowEl, current);
    }
  }
});
audio.addEventListener("error", () => {
  say(
    "That audio could not be played. If you are offline, download it while online first.",
    "error",
  );
});

window.addEventListener("beforeunload", () => {
  if (current && audio.currentTime > 2 && !audio.ended) {
    savePosition(current.id, audio.currentTime);
  }
});

// ---- OS media controls --------------------------------------------------
if ("mediaSession" in navigator) {
  const handlers = {
    play: () => void audio.play().catch(() => {}),
    pause: () => audio.pause(),
    /** @param {MediaSessionActionDetails} details */
    seekbackward: (details) => {
      audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 15));
    },
    /** @param {MediaSessionActionDetails} details */
    seekforward: (details) => {
      audio.currentTime = Math.min(
        audio.duration || Infinity,
        audio.currentTime + (details.seekOffset || 30),
      );
    },
    /** @param {MediaSessionActionDetails} details */
    seekto: (details) => {
      if (typeof details.seekTime === "number" && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(details.seekTime, audio.duration);
      }
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      // Object.entries widens the key to string; the DOM type wants the action union.
      navigator.mediaSession.setActionHandler(/** @type {MediaSessionAction} */ (action), handler);
    } catch { /* unsupported action */ }
  }
}

// ---- downloads ----------------------------------------------------------

/** @param {PlayerEpisode} episode @param {HTMLButtonElement} button */
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
/** @param {PlayerEpisode} episode @param {number} timeoutMs */
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
/** @param {PlayerEpisode} episode @param {HTMLButtonElement} button */
async function tryBackgroundFetch(episode, button) {
  if (!("serviceWorker" in navigator)) return null;
  let reg = null;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
  if (!reg || !("backgroundFetch" in reg)) return null;

  const id = "episode-" + episode.id;
  let record = null;
  try {
    record = await /** @type {RegistrationWithBackgroundFetch} */ (/** @type {unknown} */ (reg))
      .backgroundFetch?.get?.(id);
    if (!record) {
      /** @type {{title: string, icons: {src: string, sizes: string, type: string}[], downloadTotal?: number}} */
      const options = {
        title: episode.title,
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
      };
      if (episode.byteLength) options.downloadTotal = episode.byteLength;
      record = await /** @type {RegistrationWithBackgroundFetch} */ (/** @type {unknown} */ (reg))
        .backgroundFetch?.fetch?.(id, [episode.audioUrl], options);
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
  /** @type {string[]} */
  let ids = [];
  try {
    ids = await /** @type {RegistrationWithBackgroundFetch} */ (/** @type {unknown} */ (reg))
      .backgroundFetch?.getIds?.() ?? [];
  } catch { /* treat as absent */ }
  if (!ids.includes(id)) {
    if (await waitForCache(episode, 1500)) return "success";
    return null;
  }

  // Confirmed registered. Only now is the OS-level promise true.
  say("Downloading in the background — you can close this tab.", "ok");

  const settled = await new Promise((resolve) => {
    let done = false;
    /** @param {unknown} value */
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const bgRecord = /** @type {BackgroundFetchRecordLike} */ (record);
    bgRecord.addEventListener("progress", () => {
      if ((bgRecord.downloadTotal ?? 0) > 0) {
        const pct = Math.min(
          99,
          Math.round(((bgRecord.downloaded ?? 0) / (bgRecord.downloadTotal ?? 1)) * 100),
        );
        setDownloadState(button, "working", pct + "%");
      }
      if (bgRecord.result === "success") finish("success");
      else if (bgRecord.result === "failure") finish(bgRecord.failureReason || "failure");
    });
    // A bound, so a registration that never reports cannot hang the button the
    // way the 4xb attempt did.
    setTimeout(() => finish("timeout"), 120000);
  });

  if (settled !== "success") return null;
  return (await waitForCache(episode, 8000)) ? "success" : null;
}

/** The path that runs everywhere, including every non-Chromium browser. */
/** @param {PlayerEpisode} episode @param {HTMLButtonElement} button @param {Cache} store */
async function foregroundDownload(episode, button, store) {
  setDownloadState(button, "working", "0%");
  const response = await fetch(episode.audioUrl);
  if (!response.ok) throw new Error("HTTP " + response.status);
  await store.put(episode.audioUrl, response);
}

/** @param {PlayerEpisode} episode @param {HTMLButtonElement} button */
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
    say("Download failed: " + String(error instanceof Error ? error.message : error), "error");
  }
}

window.addEventListener("online", updateCounts);
window.addEventListener("offline", updateCounts);

// ---- install ------------------------------------------------------------
/** @type {{prompt: () => void, userChoice: Promise<{outcome: string}>} | null} */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = /** @type {BeforeInstallPromptEventLike} */ (/** @type {unknown} */ (event));
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

// ---- filters (audio-feed-3h1) -------------------------------------------
filterText.addEventListener("input", () => {
  saveFilterState(filterSource.value, filterText.value);
  render();
});
filterText.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    filterText.value = "";
    saveFilterState(filterSource.value, "");
    render();
  }
});
filterSource.addEventListener("change", () => {
  saveFilterState(filterSource.value, filterText.value);
  render();
});
clearFilterBtn.addEventListener("click", () => {
  filterText.value = "";
  filterSource.value = "";
  saveFilterState("", "");
  render();
});

// ---- boot ---------------------------------------------------------------
async function boot() {
  await refreshDownloaded();

  // Restore persisted filter state for this token (audio-feed-3h1)
  const savedFilter = loadFilterState();
  populateSourceFilter();
  if (savedFilter.source) filterSource.value = savedFilter.source;
  if (savedFilter.text) filterText.value = savedFilter.text;

  render();
  if (EPISODES.length > 0) {
    // Preselect so the dock shows something playable, without starting audio.
    const first = EPISODES[0];
    if (first) {
      const pos = getPosition(first.id);
      const dur = first.durationSeconds || 0;
      const isResume = pos > 5 && (dur === 0 || pos < dur - 5);
      await select(first, false, isResume ? pos : 0);
    }
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
