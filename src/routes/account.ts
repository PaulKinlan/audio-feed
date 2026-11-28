/**
 * `GET /account` — everything a signed-in subscriber manages (audio-feed-8fc).
 *
 * Server-rendered from the session, so the page is useful before any script
 * runs and a signed-out visitor is redirected, not shown an empty shell. Every
 * mutation is a same-origin fetch to /api/account/* (Origin-checked there), then
 * a reload: the page re-renders from the store, so what you see is what was saved.
 *
 * The feed token appears here because this is its owner's page: served no-store
 * with no referrer, never to anyone else.
 */

import type { AppContext } from "../app.ts";
import { bookmarkletHref } from "./bookmarklet.ts";
import type { RouteContext } from "../router.ts";
import { resolveOrigin } from "../origin.ts";
import { base64url, sessionUser } from "../auth/sessions.ts";
import { relyingParty } from "../auth/passkeys.ts";
import { GEMINI_TTS_VOICES, VOICE_PROFILES } from "../tts/gemini.ts";
import { isOutdated } from "../tts/prompt_version.ts";
import {
  isNarrationStyleId,
  NARRATION_STYLE_IDS,
  NARRATION_STYLES,
  type NarrationStyleId,
} from "../tts/styles.ts";
import { resolveBriefingPreferences } from "../worker/briefing.ts";
import {
  DEFAULT_CODE_HANDLING,
  INBOX_SOURCE_ID,
  isClaimExpired,
  PLAYBACK_MAX_RATE,
  PLAYBACK_MIN_RATE,
} from "../types.ts";
import type { AudioMode, Episode, PasskeyCredential, Source, User } from "../types.ts";
import { esc, jsonForScript } from "./html.ts";
import {
  CONFIRM_DIALOG_CLIENT,
  PASSKEY_CLIENT,
  renderShell,
  SAME_ORIGIN_PATH_CLIENT,
  viewerOf,
} from "./shell.ts";
import { htmlResponse, newCspNonce } from "./csp.ts";
import { blobStoreDirectUrlOrigin } from "../storage/mod.ts";
import { countOutdatedEpisodes } from "../compose.ts";
import { countEpisodeScan } from "../compose/ingest.ts";
import { resolvePasskeyProvider } from "../auth/aaguid.ts";

export interface PrefillData {
  url: string;
  title: string;
  feedUrl: string;
}

export interface AccountPageData {
  user: User;
  baseUrl: string;
  rpId: string;
  sources: Source[];
  credentials: PasskeyCredential[];
  episodes: Episode[];
  /** Whether there are more episodes beyond the currently displayed limit (audio-feed-w2zc). */
  hasMoreEpisodes?: boolean;
  /** Next page limit for 'Show more episodes' (audio-feed-w2zc). */
  nextEpisodesLimit?: number;
  /** Current page limit (audio-feed-w2zc). */
  currentLimit?: number;
  /** Published episodes made by other prompts, across the whole feed (audio-feed-ktn). */
  outdatedCount: number;
  /** Failed episodes across the user's feed that can be retried (audio-feed-6y9). */
  failedCount: number;
  /** Optional prefill from query params or bookmarklet (audio-feed-ep1). */
  prefill?: PrefillData | null;
  /** Initial active workspace tab ("episodes" | "add" | "feeds" | "settings"). */
  initialTab?: "episodes" | "add" | "feeds" | "settings";
  /** CSP nonce for this response (audio-feed-syhu); stamped on the shell's inline tags. */
  nonce: string;
}

const CSS = `
  .account-head { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 0.5rem 1rem; margin-block-end: 1rem; }
  .account-head h1 { margin: 0; }
  .account-head .meta { margin: 0.25rem 0 0; }
  .account-tabs { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-block-end: 1.25rem; padding: 0.3rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
  .account-tab { appearance: none; border: 1px solid transparent; background: transparent; color: var(--muted); font: inherit; font-size: 0.9rem; font-weight: 600; padding: 0.5rem 0.9rem; border-radius: calc(var(--radius) - 3px); cursor: pointer; display: inline-flex; align-items: center; gap: 0.45rem; transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease; }
  .account-tab:hover { color: var(--text); }
  .account-tab[aria-selected="true"] { background: var(--surface); color: var(--text); border-color: var(--border); box-shadow: 0 1px 2px color-mix(in srgb, #000 18%, transparent); }
  .account-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tab-pill { font-size: 0.72rem; font-weight: 700; padding: 0.08rem 0.45rem; border-radius: 999px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
  .tab-pill[data-tone="danger"] { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
  .tab-panel[hidden] { display: none; }
  .ep-filters { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; margin-block: 0.75rem 1rem; padding-block-end: 0.75rem; border-bottom: 1px solid var(--border); }
  .ep-filter-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .ep-chip { appearance: none; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font: inherit; font-size: 0.8rem; font-weight: 600; padding: 0.3rem 0.65rem; border-radius: 999px; cursor: pointer; }
  .ep-chip[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink, #0a0a0c); border-color: var(--accent); }
  .ep-filter-inputs { display: flex; flex-wrap: wrap; gap: 0.5rem; flex: 1 1 16rem; justify-content: flex-end; }
  .ep-filter-inputs input, .ep-filter-inputs select { min-width: 9rem; padding: 0.38rem 0.6rem; font-size: 0.86rem; }
  .ep-row-layout { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 0.75rem; align-items: start; }
  .ep-thumb { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: var(--surface-2); border: 1px solid var(--border); display: block; flex-shrink: 0; }
  .ep-row-body { min-width: 0; }
  .error-disclosure { margin-block-start: 0.4rem; }
  .error-disclosure > summary { cursor: pointer; font-size: 0.82rem; color: var(--danger); list-style-position: inside; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error-disclosure[open] > summary { white-space: normal; }
  .source-feeds { margin-block-start: 0.5rem; }
  .source-feeds > summary { cursor: pointer; font-size: 0.82rem; color: var(--muted); font-weight: 600; }
  .section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
  .feed-paths { display: grid; gap: 0.4rem; margin-block-start: 0.5rem; }
  .ep-status { font-size: 0.78rem; font-weight: 600; color: var(--muted); }
  .ep-status[data-status="ready"] { color: var(--ok); }
  .ep-status[data-status="failed"] { color: var(--danger); }
  .ep-status[data-status="pending"], .ep-status[data-status="synthesizing"] { color: var(--accent); }
  .ep-audio { width: 100%; height: 2.25rem; margin-block: 0.35rem 0.15rem; }
  .btn[aria-disabled="true"] { opacity: 0.55; cursor: default; }
  .row-feedback { font-size: 0.82rem; color: var(--muted); }
  .row-feedback[data-tone="ok"] { color: var(--ok); }
  .row-feedback[data-tone="error"] { color: var(--danger); }
  .episodes-pagination { display: flex; gap: 0.5rem; margin-block-start: 1rem; align-items: center; }
  .ep-filter-empty[hidden] { display: none; }
  .send-row { display: grid; gap: 0.75rem; }
  @media (min-width: 40rem) { .send-row { grid-template-columns: 1fr auto; align-items: end; } }
  .send .choices { margin-block-start: 0.75rem; }
  .danger-zone { border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
  .quick-add { border-inline-start: 4px solid var(--accent); background: var(--surface); margin-block-end: 1.5rem; }
  .quick-grid { display: grid; gap: 1rem; margin-block: 1rem; }
  @media (min-width: 44rem) { .quick-grid { grid-template-columns: 1fr 1fr; } }
  .quick-card[hidden] { display: none; }
  .quick-card { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); display: flex; flex-direction: column; justify-content: space-between; gap: 0.75rem; }
  /* One column: this panel shares the row with Passkeys, so a two-column grid
     crushed the style text and wrapped every button onto two lines. */
  .voice-grid { display: grid; gap: 0.5rem; margin-block-start: 0.4rem; }
  .voice-card { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.6rem; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
  .voice-play { white-space: nowrap; }
  .voice-pick { display: flex; flex-direction: column; gap: 0.1rem; cursor: pointer; }
  .voice-pick input { margin-inline-end: 0.4rem; }
  .voice-name { font-weight: 600; }
  .voice-style { font-size: 0.8rem; color: var(--muted); }
  .voice-play[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  #voiceSampleAudio { display: none; }
  .bookmarklet-box { margin-block-start: 1rem; padding: var(--space-4); border: 1px dashed var(--border); border-radius: var(--radius); background: var(--surface-2); }
  .bookmarklet-btn { cursor: grab; display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 600; text-decoration: none; user-select: none; }
  .bookmarklet-btn:active { cursor: grabbing; }
  .passkey-info { display: flex; align-items: center; gap: var(--space-3); }
  .provider-icon { display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; flex-shrink: 0; }
  .provider-icon svg { width: 100%; height: 100%; display: block; }
  .passkey-text { display: flex; flex-direction: column; gap: 0.1rem; }
  .passkey-label { font-size: 0.82rem; color: var(--text-muted); }
  .upload-drop-zone { border: 2px dashed var(--border); border-radius: var(--radius); padding: var(--space-4); background: var(--surface-2); text-align: center; transition: border-color 0.15s ease, background-color 0.15s ease; margin-block-end: 0.75rem; }
  .upload-drop-zone.dragover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); }
  .drop-prompt { margin: 0 0 0.5rem; font-size: 0.9rem; color: var(--text-muted); }
  .rows[hidden], .empty[hidden] { display: none; }
  .rows > li > .source-feeds, .rows > li > .source-prefs { grid-column: 1 / -1; }
  .source-prefs { margin-block-start: 0.45rem; }
  .source-prefs > summary { cursor: pointer; font-size: 0.84rem; color: var(--text-2); font-weight: 600; display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
  .source-prefs-meta { font-weight: 500; font-size: 0.78rem; color: var(--muted); }
  .source-prefs-meta[data-customized="true"] { color: var(--accent); }
  .source-prefs-form { margin-block-start: 0.65rem; padding: 0.85rem; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); display: grid; gap: 0.75rem; }
  .source-prefs-grid { display: grid; gap: 0.65rem; }
  @media (min-width: 38rem) { .source-prefs-grid { grid-template-columns: 1fr 1fr; } }
  details.source-prefs::details-content { interpolate-size: allow-keywords; overflow: clip; contain: layout; }
  details.source-prefs:not([open])::details-content { block-size: 0; }
  @media (prefers-reduced-motion: no-preference) {
    details.source-prefs::details-content {
      transition: block-size 0.22s ease, content-visibility 0.22s ease, display 0.22s ease;
      transition-behavior: allow-discrete;
    }
  }
  .email-ingest-box { margin-block-start: 1.25rem; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
  .email-ingest-box h3 { margin-block-start: 0; }
  .opml-box { margin-block-start: 1.25rem; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
  .opml-box-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem 1rem; margin-block-end: 0.35rem; }
  .opml-box-head h3 { margin: 0; font-size: 0.98rem; }
  .opml-progress { display: block; inline-size: 100%; block-size: 0.45rem; accent-color: var(--accent); margin-block-start: 0.5rem; }
  .opml-progress[hidden] { display: none; }
  .opml-result { margin-block-start: 0.75rem; padding: 0.75rem 0.9rem; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface); font-size: 0.88rem; }
  .opml-result[hidden] { display: none; }
  .opml-result[data-tone="ok"] { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
  .opml-result[data-tone="warn"] { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .opml-result[data-tone="error"] { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); color: var(--danger); }
  .opml-result-summary { margin: 0; font-weight: 600; }
  .opml-failed-list { margin: 0.5rem 0 0; padding-inline-start: 1.25rem; font-size: 0.82rem; color: var(--muted); display: grid; gap: 0.25rem; overflow-wrap: anywhere; }
  .failed-triage { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.6rem 1rem; padding: 0.7rem 0.95rem; margin-block: 0.5rem 0.9rem; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--danger) 8%, var(--surface-2)); }
  .failed-triage[hidden] { display: none; }
  .failed-triage-summary { font-size: 0.88rem; font-weight: 600; color: var(--text); }
  .style-select-field { margin-block-start: 0.75rem; max-inline-size: 24rem; }
  .briefing-card { margin-block: 1rem; }
  .briefing-grid { display: grid; gap: 0.75rem; }
  @media (min-width: 38rem) { .briefing-grid { grid-template-columns: 1fr 1fr; } }
  .briefing-eligibility { margin: 0 0 0.85rem; min-block-size: 1.4em; }
  .badge[data-schedule="daily"], .badge[data-schedule="weekly"] { color: var(--ok); }
  .badge[data-schedule="off"] { color: var(--muted); }
`;

function when(iso: string | undefined): string {
  if (!iso) return "never";
  // audio-feed-ap45: use Temporal.PlainDate for calendar date extraction
  // TODO(baseline/temporal): drop fallback when Temporal reaches Baseline
  if (typeof Temporal !== "undefined") {
    try {
      return Temporal.PlainDate.from(iso).toString();
    } catch {
      // fallback
    }
  }
  return iso.slice(0, 10);
}

const SOURCE_PLAYBACK_RATE_PRESETS = [0.8, 1, 1.2, 1.4, 1.5, 1.75, 2] as const;
const BRIEFING_MAX_ARTICLE_PRESETS = [4, 6, 8, 10, 12] as const;

function effectiveSourceNarrationStyle(source: Source): NarrationStyleId {
  return isNarrationStyleId(source.narrationStyle) ? source.narrationStyle : "standard";
}

function renderNarrationStyleOptions(selected: NarrationStyleId = "standard"): string {
  return NARRATION_STYLE_IDS.map((id) =>
    `<option value="${id}"${selected === id ? " selected" : ""}>${
      esc(NARRATION_STYLES[id].label)
    }</option>`
  ).join("");
}

function emailHostOf(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host) return host;
  } catch {
    // fallback below
  }
  return "audiofeed.app";
}

function effectiveSourceVoice(source: Source): string {
  if (
    typeof source.voice === "string" &&
    (GEMINI_TTS_VOICES as readonly string[]).includes(source.voice)
  ) {
    return source.voice;
  }
  if (
    typeof source.voices?.direct === "string" &&
    (GEMINI_TTS_VOICES as readonly string[]).includes(source.voices.direct)
  ) {
    return source.voices.direct;
  }
  return "";
}

function sourceModeSelectValue(modes: AudioMode[]): string {
  const hasDirect = modes.includes("direct");
  const hasDeepdive = modes.includes("deepdive");
  if (hasDirect && hasDeepdive) {
    return modes[0] === "deepdive" ? "deepdive,direct" : "direct,deepdive";
  }
  return modes[0] === "deepdive" ? "deepdive" : "direct";
}

function sourcePrefsSummary(source: Source): { text: string; customized: boolean } {
  const parts: string[] = [];
  const voice = effectiveSourceVoice(source);
  if (voice) parts.push(voice);
  if (
    typeof source.playbackRate === "number" &&
    Number.isFinite(source.playbackRate) &&
    source.playbackRate >= PLAYBACK_MIN_RATE &&
    source.playbackRate <= PLAYBACK_MAX_RATE
  ) {
    parts.push(`${Math.round(source.playbackRate * 100) / 100}×`);
  }
  if (source.modes[0] === "deepdive") {
    parts.push("Deep dive");
  }
  if (source.codeHandling === "explain") {
    parts.push("Explain code");
  }
  const style = effectiveSourceNarrationStyle(source);
  if (style !== "standard") {
    parts.push(NARRATION_STYLES[style].label);
  }
  if (parts.length === 0) {
    return { text: "Account defaults", customized: false };
  }
  return { text: parts.join(" · "), customized: true };
}

function copyRow(value: string, label: string): string {
  return `<div class="copy"><code>${
    esc(value)
  }</code><button class="btn quiet small" type="button" data-copy="${
    esc(value)
  }" aria-label="Copy ${esc(label)}">Copy</button></div>`;
}

export function renderAccountPage(d: AccountPageData): string {
  const { user, baseUrl } = d;
  const feedBase = `${baseUrl}/feed/${user.feedToken}`;
  const emailIngestAddress = `save+${user.feedToken}@${emailHostOf(baseUrl)}`;
  const approved = user.status === "approved";

  const sourceItems = d.sources.map((s, idx) => {
    const paths = s.modes.map((mode) =>
      copyRow(
        `${feedBase}/${s.id}/${mode}.xml`,
        `${s.title} ${mode === "direct" ? "read aloud" : "deep dive"} feed`,
      )
    ).join("");
    const remove = s.id === INBOX_SOURCE_ID
      ? ""
      : `<button class="btn danger small" type="button" data-remove-source="${
        esc(s.id)
      }" data-title="${esc(s.title)}" data-tooltip="Remove ${esc(s.title)}">Remove</button>`;
    const currentVoice = effectiveSourceVoice(s);
    const currentRate = typeof s.playbackRate === "number" &&
        Number.isFinite(s.playbackRate) &&
        s.playbackRate >= PLAYBACK_MIN_RATE &&
        s.playbackRate <= PLAYBACK_MAX_RATE
      ? Math.round(s.playbackRate * 100) / 100
      : null;
    const currentModeVal = sourceModeSelectValue(s.modes);
    const currentCodeHandling = s.codeHandling === "explain" ? "explain" : DEFAULT_CODE_HANDLING;
    const currentNarrationStyle = effectiveSourceNarrationStyle(s);
    const summary = sourcePrefsSummary(s);
    const voiceOptions = [
      `<option value=""${currentVoice === "" ? " selected" : ""}>Default</option>`,
      ...GEMINI_TTS_VOICES.map((v) =>
        `<option value="${v}"${currentVoice === v ? " selected" : ""}>${v} — ${
          esc(VOICE_PROFILES[v].style)
        }</option>`
      ),
    ].join("");
    const rateValues: number[] = [...SOURCE_PLAYBACK_RATE_PRESETS];
    if (currentRate !== null && !rateValues.includes(currentRate)) {
      rateValues.push(currentRate);
      rateValues.sort((a, b) => a - b);
    }
    const rateOptions = [
      `<option value=""${currentRate === null ? " selected" : ""}>Default</option>`,
      ...rateValues.map((r) =>
        `<option value="${r}"${currentRate === r ? " selected" : ""}>${r}x</option>`
      ),
    ].join("");
    return `<li data-source-id="${esc(s.id)}" data-source-title="${esc(s.title)}"><div class="row-head"><span class="row-title">${esc(s.title)}</span>${remove}</div>
      <div class="meta">${s.feedUrl ? esc(s.feedUrl) : "Articles you send"} · last polled ${
      when(s.lastPolledAt)
    }</div>
      <details class="source-feeds"><summary>Feed URLs (${s.modes.length})</summary><div class="feed-paths">${paths}</div></details>
      <details class="source-prefs"><summary>Feed defaults <span class="source-prefs-meta" data-customized="${
      summary.customized ? "true" : "false"
    }">${esc(summary.text)}</span></summary>
        <form class="source-prefs-form" data-source-prefs="${esc(s.id)}">
          <div class="source-prefs-grid">
            <div class="field">
              <label for="src-voice-${idx}">Voice</label>
              <select id="src-voice-${idx}" name="voice">${voiceOptions}</select>
            </div>
            <div class="field">
              <label for="src-rate-${idx}">Default playback speed</label>
              <select id="src-rate-${idx}" name="playbackRate">${rateOptions}</select>
            </div>
            <div class="field">
              <label for="src-mode-${idx}">Default mode</label>
              <select id="src-mode-${idx}" name="mode">
                <option value="direct"${currentModeVal === "direct" ? " selected" : ""}>Read aloud</option>
                <option value="deepdive"${currentModeVal === "deepdive" ? " selected" : ""}>Deep dive (two voices)</option>
                <option value="direct,deepdive"${currentModeVal === "direct,deepdive" ? " selected" : ""}>Both (Read aloud default)</option>
                <option value="deepdive,direct"${currentModeVal === "deepdive,direct" ? " selected" : ""}>Both (Deep dive default)</option>
              </select>
            </div>
            <div class="field">
              <label for="src-code-${idx}">Code handling</label>
              <select id="src-code-${idx}" name="codeHandling">
                <option value="skip"${currentCodeHandling === "skip" ? " selected" : ""}>Skip code blocks</option>
                <option value="explain"${currentCodeHandling === "explain" ? " selected" : ""}>Explain code blocks</option>
              </select>
            </div>
            <div class="field">
              <label for="src-style-${idx}">Narration style</label>
              <select id="src-style-${idx}" name="narrationStyle">${
      renderNarrationStyleOptions(currentNarrationStyle)
    }</select>
            </div>
          </div>
          <div class="actions">
            <button class="btn small" type="submit">Save defaults</button>
            <span class="row-feedback source-prefs-feedback" role="status" aria-live="polite"></span>
          </div>
        </form>
      </details></li>`;
  }).join("");

  const episodeSources = [...new Set(d.episodes.map((e) => e.sourceTitle ?? e.sourceId))]
    .sort((a, b) => a.localeCompare(b));
  const episodeSourceOptions = episodeSources
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join("");
  const episodeItems = d.episodes.map((e) => {
    const audioUrl = e.status === "ready" && e.audioKey
      ? `/audio/${e.audioKey.replace(/^\/+/, "")}`
      : null;
    const artUrl = `/feed/${encodeURIComponent(user.feedToken)}/art/episode-${encodeURIComponent(e.id)}.png`;
    const isStaleSynthesizing = e.status === "synthesizing" && (
      isClaimExpired(e, Date.now()) ||
      (Date.now() - Date.parse(e.lastHeartbeat ?? e.claimedAt ?? "") >= 2 * 60_000)
    );
    const outdated = isOutdated(e);
    const sourceLabel = e.sourceTitle ?? e.sourceId;
    const errorSummary = e.error
      ? (e.error.length > 96 ? `${e.error.slice(0, 93)}…` : e.error)
      : "";
    return `<li data-episode-id="${esc(e.id)}" data-episode-status="${esc(e.status)}" data-episode-regenerating="${
      e.regenerating ? "1" : "0"
    }" data-episode-outdated="${outdated ? "1" : "0"}" data-episode-title="${
      esc(e.title)
    }" data-episode-source="${esc(sourceLabel)}"><div class="ep-row-layout"><img class="ep-thumb" src="${
      esc(artUrl)
    }" alt="" width="48" height="48" loading="lazy" decoding="async"><div class="ep-row-body"><div class="row-head"><span class="row-title">${
      esc(e.title)
    }</span>
      <span class="ep-status" data-status="${esc(e.status)}">${esc(e.status)}</span></div>
      <div class="meta">${e.mode === "direct" ? "Read aloud" : "Deep dive"} · ${
      esc(sourceLabel)
    } · ${when(e.createdAt)}<span class="ep-phase">${
      e.status === "synthesizing" && e.phase ? ` · synthesizing (${esc(e.phase)})` : ""
    }</span></div>
${audioUrl ? `<audio controls preload="none" class="ep-audio" src="${esc(audioUrl)}"></audio>` : ""}
${
      e.status === "failed" && e.error
        ? `<details class="error-disclosure"><summary>${esc(errorSummary)}</summary><div class="error-detail">${
          esc(e.error)
        }</div></details>`
        : ""
    }
${
      approved && e.status === "ready" && !e.regenerating
        ? `
      <div class="actions"><button class="btn quiet small" type="button" data-regenerate-episode="${
          esc(e.id)
        }" data-title="${esc(e.title)}" data-tooltip="Regenerate ${
          esc(e.title)
        }">Regenerate</button></div>`
        : approved && (e.status === "failed" || isStaleSynthesizing)
        ? `
      <div class="actions"><button class="btn quiet small" type="button" data-retry-episode="${
          esc(e.id)
        }" data-title="${esc(e.title)}" data-tooltip="Retry ${esc(e.title)}">Retry</button></div>`
        : ""
    }</div></div>
    </li>`;
  }).join("");

  const passkeyItems = d.credentials.map((c) => {
    const provider = resolvePasskeyProvider(c.aaguid);
    return `<li><div class="row-head">
      <div class="passkey-info">
        <span class="provider-icon" aria-hidden="true">${provider.iconSvg}</span>
        <div class="passkey-text">
          <span class="row-title">${esc(provider.name)}</span>
          <span class="passkey-label">${esc(c.name)}</span>
        </div>
      </div>
      <button class="btn danger small" type="button" data-remove-passkey="${esc(c.id)}"${
      d.credentials.length <= 1
        ? ` disabled title="Add another passkey before removing this one" data-tooltip="Add another passkey before removing this one"`
        : ""
    }>Remove</button></div>
      <div class="meta">Added ${when(c.createdAt)} · last used ${when(c.lastUsedAt)}</div></li>`;
  }).join("");

  /**
   * The voice picker (audio-feed-msw) is a radio-card grid rather than a <select>,
   * because a voice is chosen by EAR: each card carries a play button next to the
   * name and the style description, and the radio keeps the existing form contract
   * (`name="voice"`, same POST). The buttons all drive ONE <audio> element, which is
   * what makes "exactly one sample plays at a time" structural instead of bookkeeping.
   */
  const voiceCards = [
    `<div class="voice-card">
      <label class="voice-pick">
        <span><input type="radio" name="voice" value=""${
      user.voice ? "" : " checked"
    }> <span class="voice-name">Deployment default</span></span>
        <span class="voice-style">Whatever this server was configured with</span>
      </label>
    </div>`,
    ...GEMINI_TTS_VOICES.map((v) => {
      const profile = VOICE_PROFILES[v];
      return `<div class="voice-card">
      <label class="voice-pick">
        <span><input type="radio" name="voice" value="${v}"${
        user.voice === v ? " checked" : ""
      }> <span class="voice-name">${v}</span></span>
        <span class="voice-style">${esc(profile.style)}</span>
      </label>
      <button type="button" class="btn quiet small voice-play" data-voice-sample="${v}"
        aria-pressed="false" aria-label="Play a sample of ${v}">▶ Play sample</button>
    </div>`;
    }),
  ].join("");

  const pending = approved
    ? ""
    : `<p class="callout">Your account is ${
      user.status === "pending" ? "waiting for approval" : esc(user.status)
    }. Nothing is turned into audio until an admin approves it, because synthesis is the part that costs money.</p>`;

  const bookmarkletCode = bookmarkletHref(baseUrl);

  const prefill = d.prefill;
  const unifiedCard = prefill
    ? `
  <section class="panel quick-add" id="quickAddPanel" aria-labelledby="quick-add-h">
    <h2 id="quick-add-h">Add to Audio Feed</h2>
    <p class="sub">URL detected: <strong class="prefill-title">${
      esc(prefill.title || prefill.url)
    }</strong></p>
    <div class="quick-grid">
      <div class="quick-card">
        <div>
          <h3 class="u-mt-0 u-fs-body">Queue this single page</h3>
          <p class="meta u-fs-sm u-break-all"><code>${esc(prefill.url)}</code></p>
          <div class="choices u-my-half" role="radiogroup" aria-label="Format">
            <label><input type="radio" name="quickMode" value="direct" checked> Read aloud</label>
            <label><input type="radio" name="quickMode" value="deepdive"> Deep dive</label>
          </div>
          <div class="field style-select-field">
            <label for="quickNarrationStyle">Narration style</label>
            <select id="quickNarrationStyle" name="narrationStyle">${
      renderNarrationStyleOptions("standard")
    }</select>
          </div>
        </div>
        <button type="button" class="btn small" id="quickSingleBtn"${
      approved ? "" : " disabled"
    }>Queue Single Episode</button>
      </div>
      <div class="quick-card" id="detectedFeed"${prefill.feedUrl ? "" : " hidden"}>
        <div>
          <h3 class="u-mt-0 u-fs-body">Subscribe to the feed</h3>
          <p class="meta u-fs-sm u-break-all">${
      prefill.feedUrl ? "Detected feed: " : "This page advertises: "
    }<code id="detectedFeedUrl">${esc(prefill.feedUrl ?? "")}</code></p>
          <p class="sub u-fs-sm u-mt-quarter">Follow the publication for future articles.</p>
        </div>
        <button type="button" class="btn quiet small" id="quickSubscribeBtn"${
      approved ? "" : " disabled"
    }>Subscribe to RSS Feed</button>
      </div>
    </div>
    <p class="feedback" id="quickFeedback" role="status" aria-live="polite"></p>
  </section>`
    : "";

  const sendSection = prefill ? "" : `<section class="panel send" aria-labelledby="send-h">
    <h2 id="send-h">Send an article to audio</h2>
    <p class="sub">Paste a link. It's queued, narrated, and added to your feed.</p>
    <!-- audio-feed-dc2y: WebMCP annotations. Inert in browsers without WebMCP support, and the
         submit path below is untouched: an agent submits the same form a person does. -->
    <form id="sendForm" toolname="send_article"
          tooldescription="Queue a public article URL to be narrated and added to the signed-in user's private audio feed. The optional mode selects read-aloud or two-voice deep dive.">
      <div class="send-row">
        <div class="field"><label for="sendUrl">Article URL</label>
          <input id="sendUrl" type="url" required placeholder="https://example.com/an-article" autocomplete="url" spellcheck="false"
                 toolparamdescription="Public http(s) URL of the article to narrate"></div>
        <button class="btn" type="submit"${approved ? "" : " disabled"}>Send to Audio</button>
      </div>
      <fieldset class="choices" aria-label="How should it sound?"
                toolparamdescription="Narration style: read aloud in one voice, or a two-voice deep dive between an expert and an interviewer">
        <label><input type="radio" name="sendMode" value="direct" checked> Read aloud</label>
        <label><input type="radio" name="sendMode" value="deepdive"> Deep dive, two voices</label>
      </fieldset>
      <div class="field style-select-field">
        <label for="sendNarrationStyle">Narration style</label>
        <select id="sendNarrationStyle" name="narrationStyle" aria-describedby="sendNarrationStyleHint"
                toolparamdescription="Read-aloud narration preset: standard (Full Narration), brief (3-Min Brief), or walkthrough (Technical Walkthrough)">${
    renderNarrationStyleOptions("standard")
  }</select>
        <span id="sendNarrationStyleHint" class="hint">Full Narration, 3-Min Brief, or Technical Walkthrough (for read-aloud episodes).</span>
      </div>
      <p class="feedback" id="sendFeedback" role="status" aria-live="polite"></p>
    </form>
    <div class="u-mt-3">
      <h3 class="legend u-legend" id="upload-h">Upload a document</h3>
      <p class="sub">Upload a document (.doc, .docx, .pdf, .html, .txt, .md) to narrate (up to 10 MiB).</p>
      <form id="uploadForm" enctype="multipart/form-data" aria-labelledby="upload-h">
        <div id="uploadDropZone" class="upload-drop-zone">
          <p class="drop-prompt">Drag and drop a file here, or choose from your device:</p>
          <div class="send-row">
            <div class="field"><label for="uploadFile">Document file</label>
              <input id="uploadFile" name="file" type="file" required accept=".doc,.docx,.pdf,.html,.htm,.txt,.md"></div>
            <button class="btn" type="submit"${approved ? "" : " disabled"}>Upload to Audio</button>
          </div>
        </div>
        <fieldset class="choices" aria-label="How should the uploaded document sound?">
          <label><input type="radio" name="uploadMode" value="direct" checked> Read aloud</label>
          <label><input type="radio" name="uploadMode" value="deepdive"> Deep dive, two voices</label>
        </fieldset>
        <p class="feedback" id="uploadFeedback" role="status" aria-live="polite"></p>
      </form>
    </div>
    <div class="email-ingest-box" id="emailIngestBox">
      <h3 class="legend u-legend" id="email-ingest-h">Email-to-Podcast forwarding</h3>
      <p class="sub">Forward newsletters or articles to your private address to narrate them into your feed. Treat it like a password — anyone with it can add to your feed.</p>
      <div class="field">
        <span class="legend">Private forwarding address</span>
        ${copyRow(emailIngestAddress, "email-to-podcast forwarding address")}
        <span class="hint">Tip: add <code>+deepdive</code> before <code>@</code> for a two-voice deep dive.</span>
      </div>
    </div>
    <div class="bookmarklet-box">
      <div class="u-flex-between-wrap">
        <div>
          <strong class="u-block u-fs-092">Browser Bookmarklet</strong>
          <span class="sub u-fs-sm u-muted-color">Drag this button to your bookmarks bar to add articles or feeds from any tab:</span>
        </div>
        <a class="btn quiet small bookmarklet-btn" href="${
    esc(bookmarkletCode)
  }" draggable="true" title="Drag to your bookmarks bar" data-tooltip="Drag to your bookmarks bar">
          <span aria-hidden="true">🎙️</span> Add to Audio Feed
        </a>
      </div>
      <details class="bookmarklet-code u-mt-2">
        <summary>Can’t drag it? Get the bookmarklet code</summary>
        <p class="u-fs-sm u-mt-quarter">Browsers refuse <code>javascript:</code> links when clicked directly on a page protected by this app’s Content Security Policy. To install it manually, drag the button above to your bookmarks bar, or create a bookmark and paste this code as its URL:</p>
        <pre class="bookmarklet-snippet u-break-all u-fs-xs"><code>${
    esc(bookmarkletCode)
  }</code></pre>
      </details>
    </div>
  </section>`;

  const activeTab = d.initialTab ?? (prefill ? "add" : "episodes");
  const isTab = (name: "episodes" | "add" | "feeds" | "settings") => activeTab === name;

  const briefing = resolveBriefingPreferences(user.briefing);
  const briefingHourOptions = Array.from({ length: 24 }, (_, hour) => {
    const label = `${String(hour).padStart(2, "0")}:00 UTC`;
    return `<option value="${hour}"${briefing.hourUtc === hour ? " selected" : ""}>${label}</option>`;
  }).join("");
  const briefingMaxValues: number[] = [...BRIEFING_MAX_ARTICLE_PRESETS];
  if (!briefingMaxValues.includes(briefing.maxArticles)) {
    briefingMaxValues.push(briefing.maxArticles);
    briefingMaxValues.sort((a, b) => a - b);
  }
  const briefingMaxOptions = briefingMaxValues.map((count) =>
    `<option value="${count}"${briefing.maxArticles === count ? " selected" : ""}>${count} ${
      count === 1 ? "story" : "stories"
    }</option>`
  ).join("");
  const briefingBadgeText = briefing.schedule === "daily"
    ? `Daily · ${String(briefing.hourUtc).padStart(2, "0")}:00 UTC`
    : briefing.schedule === "weekly"
    ? `Weekly (Mon) · ${String(briefing.hourUtc).padStart(2, "0")}:00 UTC`
    : "Off";
  const initialBriefingMeta = briefing.lastGeneratedDate
    ? `Last briefing generated ${esc(briefing.lastGeneratedDate)}.`
    : "Compiles recent unread articles from the past 24 hours (daily) or 7 days (weekly).";

  const main = `<div class="wrap">
  <div class="account-head">
    <div>
      <p class="eyebrow">Your account</p>
      <h1>${esc(user.displayName)}</h1>
      <p class="meta">${esc(user.email)} <span class="badge" data-status="${esc(user.status)}">${
    esc(user.status)
  }</span></p>
    </div>
    <a class="btn quiet" href="/listen/${esc(user.feedToken)}">Open the player</a>
  </div>
  ${pending}

  <div class="account-tabs" role="tablist" aria-label="Account sections">
    <button class="account-tab" type="button" role="tab" id="tab-episodes" aria-controls="panel-episodes" aria-selected="${
    isTab("episodes") ? "true" : "false"
  }" tabindex="${isTab("episodes") ? "0" : "-1"}" data-tab="episodes">Episodes${
    d.failedCount > 0
      ? ` <span class="tab-pill" id="tabFailedPill" data-tone="danger">${d.failedCount} failed</span>`
      : ` <span class="tab-pill" id="tabFailedPill" hidden></span>`
  }</button>
    <button class="account-tab" type="button" role="tab" id="tab-add" aria-controls="panel-add" aria-selected="${
    isTab("add") ? "true" : "false"
  }" tabindex="${isTab("add") ? "0" : "-1"}" data-tab="add">Add</button>
    <button class="account-tab" type="button" role="tab" id="tab-feeds" aria-controls="panel-feeds" aria-selected="${
    isTab("feeds") ? "true" : "false"
  }" tabindex="${isTab("feeds") ? "0" : "-1"}" data-tab="feeds">Feeds <span class="tab-pill" id="tabFeedsPill">${
    d.sources.length
  }</span></button>
    <button class="account-tab" type="button" role="tab" id="tab-settings" aria-controls="panel-settings" aria-selected="${
    isTab("settings") ? "true" : "false"
  }" tabindex="${isTab("settings") ? "0" : "-1"}" data-tab="settings">Settings</button>
  </div>

  <div class="tab-panel" id="panel-episodes" role="tabpanel" aria-labelledby="tab-episodes"${
    isTab("episodes") ? "" : " hidden"
  }>
  <section class="panel" aria-labelledby="episodes-h">
    <div class="section-title"><h2 id="episodes-h">Recent episodes</h2>${
    approved
      ? `<div class="row u-gap-2"><button class="btn quiet small" type="button" id="regenOutdated" data-count="${d.outdatedCount}"${
        d.outdatedCount ? "" : " disabled"
      }>Regenerate outdated (${d.outdatedCount})</button>
      <button class="btn quiet small" type="button" id="retryFailed" data-count="${d.failedCount}"${
        d.failedCount ? "" : " disabled"
      }>Retry failed (${d.failedCount})</button></div>`
      : ""
  }</div>
    <p class="sub">Regenerate re-narrates with the current prompts. The old audio stays in your feed until the new one is ready.</p>
    ${
    approved
      ? `<div class="failed-triage" id="failedTriageBar"${d.failedCount > 0 ? "" : " hidden"}>
      <span class="failed-triage-summary" id="failedTriageSummary">${d.failedCount} failed episode${
        d.failedCount === 1 ? "" : "s"
      } need attention.</span>
      <div class="row u-gap-2">
        <button class="btn quiet small" type="button" id="bulkRetryFailed" data-count="${d.failedCount}"${
        d.failedCount > 0 ? "" : " disabled"
      }>Retry up to 10 failed</button>
        <button class="btn danger small" type="button" id="bulkClearFailed" data-count="${d.failedCount}"${
        d.failedCount > 0 ? "" : " disabled"
      }>Clear failed (${d.failedCount})</button>
      </div>
    </div>`
      : ""
  }
    ${
    d.episodes.length
      ? `<div class="ep-filters" role="search" aria-label="Filter episodes">
      <div class="ep-filter-chips" role="group" aria-label="Filter by status">
        <button class="ep-chip" type="button" data-filter-status="all" aria-pressed="true">All</button>
        <button class="ep-chip" type="button" data-filter-status="ready" aria-pressed="false">Ready</button>
        <button class="ep-chip" type="button" data-filter-status="active" aria-pressed="false">In progress</button>
        <button class="ep-chip" type="button" data-filter-status="failed" aria-pressed="false">Failed</button>
      </div>
      <div class="ep-filter-inputs">
        <label class="sr-only" for="epFilterSource">Filter by source</label>
        <select id="epFilterSource" aria-label="Filter by source">
          <option value="">All sources</option>
          ${episodeSourceOptions}
        </select>
        <label class="sr-only" for="epFilterQuery">Search episodes</label>
        <input id="epFilterQuery" type="search" placeholder="Search episodes…" autocomplete="off" spellcheck="false">
      </div>
    </div>`
      : ""
  }
    <ul class="rows" id="episodesList"${episodeItems ? "" : " hidden"}>${episodeItems}</ul>
    <p class="empty" id="episodesEmpty"${episodeItems ? " hidden" : ""}>Nothing yet. Switch to the Add tab to send an article or subscribe a feed.</p>
    <p class="empty ep-filter-empty" id="epFilterEmpty" hidden>No episodes match this filter. <button class="btn quiet small" type="button" id="epClearFilters">Clear filters</button></p>
    ${
    d.hasMoreEpisodes || (d.currentLimit && d.currentLimit > 10)
      ? `<div class="episodes-pagination">
          ${
        d.hasMoreEpisodes
          ? `<a class="btn quiet small" id="loadMoreEpisodes" href="/account?limit=${d.nextEpisodesLimit}#episodes-h">Show more episodes</a>`
          : ""
      }
          ${
        d.currentLimit && d.currentLimit > 10
          ? `<a class="btn quiet small" id="showFewerEpisodes" href="/account#episodes-h">Show fewer</a>`
          : ""
      }
        </div>`
      : ""
  }
    <p class="feedback" id="regenFeedback" role="status" aria-live="polite"></p>
  </section>
  </div>

  <div class="tab-panel" id="panel-add" role="tabpanel" aria-labelledby="tab-add"${
    isTab("add") ? "" : " hidden"
  }>
  ${unifiedCard}
  ${sendSection}
  </div>

  <div class="tab-panel" id="panel-feeds" role="tabpanel" aria-labelledby="tab-feeds"${
    isTab("feeds") ? "" : " hidden"
  }>
  <section class="panel" aria-labelledby="feeds-h">
    <div class="section-title"><h2 id="feeds-h">Your feeds</h2>
      <a class="btn quiet small" id="exportOpml" href="/api/account/sources/opml" download="audio-feed-subscriptions.opml" data-no-prefetch>Export OPML</a>
    </div>
    <p class="sub">Paste into Pocket Casts, Apple Podcasts, Overcast or any app that takes an RSS URL. The URL is your password for listening: keep it to yourself.</p>
    <div class="field"><span class="legend">Everything, newest first</span>${
    copyRow(`${feedBase}/master.xml`, "master feed URL")
  }</div>
    <h3 class="legend u-legend">Sources</h3>
    <ul class="rows" id="sourcesList"${sourceItems ? "" : " hidden"}>${sourceItems}</ul>
    <p class="empty" id="sourcesEmpty"${sourceItems ? " hidden" : ""}>No sources yet. Add a blog or newsletter below.</p>
    <p class="feedback" id="sourcesFeedback" role="status" aria-live="polite"></p>
    <details class="more"${d.sources.length ? "" : " open"}>
      <summary>Add an RSS or Atom feed</summary>
      <form id="addSourceForm" class="stack">
        <div class="field"><label for="sourceUrl">Feed URL</label>
          <input id="sourceUrl" type="url" required placeholder="https://example.com/feed.xml" spellcheck="false"></div>
        <div class="field"><label for="sourceTitle">Title <span class="hint">optional, defaults to the feed's own</span></label>
          <input id="sourceTitle" type="text" autocomplete="off"></div>
        <div class="choices" role="group" aria-label="Formats">
          <label><input type="checkbox" name="sourceMode" value="direct" checked> Read aloud</label>
          <label><input type="checkbox" name="sourceMode" value="deepdive"> Deep dive</label>
        </div>
        <div class="field">
          <label for="sourceNarrationStyle">Narration style</label>
          <select id="sourceNarrationStyle" name="narrationStyle" aria-describedby="sourceNarrationStyleHint">${
    renderNarrationStyleOptions("standard")
  }</select>
          <span id="sourceNarrationStyleHint" class="hint">Default read-aloud style for new posts from this feed.</span>
        </div>
        <div class="actions"><button class="btn" type="submit"${
    approved ? "" : " disabled"
  }>Add feed</button></div>
        <p class="feedback" id="addSourceFeedback" role="status" aria-live="polite"></p>
      </form>
    </details>
    <div class="opml-box">
      <div class="opml-box-head">
        <h3 id="opml-import-h">Import subscriptions from OPML</h3>
      </div>
      <p class="sub">Migrate feeds from Overcast, Pocket Casts, Feedly, NetNewsWire, or any OPML 2.0 export.</p>
      <form id="opmlImportForm" class="stack" aria-labelledby="opml-import-h">
        <div class="field">
          <label for="opmlFile">OPML file</label>
          <input id="opmlFile" name="opmlFile" type="file" required accept=".opml,.xml,text/xml,application/xml" aria-describedby="opmlFileHint">
          <span id="opmlFileHint" class="hint">Up to 100 feeds per import (max 512 KiB). Already-subscribed feeds are skipped automatically.</span>
        </div>
        <fieldset class="choices">
          <legend class="sr-only">Narration format for imported feeds</legend>
          <label for="opmlModeDirect"><input id="opmlModeDirect" type="radio" name="opmlMode" value="direct" checked> Read aloud</label>
          <label for="opmlModeDeepdive"><input id="opmlModeDeepdive" type="radio" name="opmlMode" value="deepdive"> Deep dive</label>
        </fieldset>
        <div class="actions">
          <button class="btn" type="submit" id="opmlImportBtn"${
    approved ? "" : " disabled"
  }>Import OPML</button>
        </div>
        <progress id="opmlProgress" class="opml-progress" aria-label="Importing OPML subscriptions" hidden></progress>
        <div id="opmlResult" class="opml-result" role="status" aria-live="polite" hidden></div>
      </form>
    </div>
  </section>
  </div>

  <div class="tab-panel" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings"${
    isTab("settings") ? "" : " hidden"
  }>
  <div class="grid two">
    <section class="panel" aria-labelledby="profile-h">
      <h2 id="profile-h">Profile</h2>
      <p class="sub">How you appear, and the voice that reads to you.</p>
      <form id="profileForm" class="stack">
        <div class="field"><label for="displayName">Display name</label>
          <input id="displayName" type="text" maxlength="80" required value="${
    esc(user.displayName)
  }" autocomplete="name"></div>
        <div class="field">
          <span class="legend">Preferred voice <span class="hint">for read-aloud episodes</span></span>
          <div class="voice-grid" role="radiogroup" aria-label="Preferred voice for read-aloud episodes">
            ${voiceCards}
          </div>
          <audio id="voiceSampleAudio" preload="none"></audio>
        </div>
        <div class="actions"><button class="btn" type="submit">Save profile</button></div>
        <p class="feedback" id="profileFeedback" role="status" aria-live="polite"></p>
      </form>
    </section>

    <section class="panel" aria-labelledby="passkeys-h">
      <h2 id="passkeys-h">Passkeys</h2>
      <p class="sub">How you sign in. Keep at least two, on different devices, so losing one never locks you out.</p>
      ${
    passkeyItems ? `<ul class="rows">${passkeyItems}</ul>` : `<p class="empty">No passkeys yet.</p>`
  }
      <div class="actions u-mt-sm"><button class="btn quiet" type="button" id="addPasskey">Add a passkey</button></div>
      <p class="feedback" id="passkeyFeedback" role="status" aria-live="polite"></p>
    </section>
  </div>

  <div class="panel briefing-card" id="briefingCard">
    <div class="section-title">
      <h2 id="briefing-h">Morning Briefing</h2>
      <span class="badge" id="briefingScheduleBadge" data-schedule="${
    esc(briefing.schedule)
  }">${esc(briefingBadgeText)}</span>
    </div>
    <p class="sub">Compile your recent unread stories into a single chaptered audio briefing delivered to your feed.</p>
    <p class="meta briefing-eligibility" id="briefingEligibility">${initialBriefingMeta}</p>
    <form id="briefingForm" class="stack" aria-labelledby="briefing-h">
      <div class="briefing-grid">
        <div class="field">
          <label for="briefingSchedule">Schedule</label>
          <select id="briefingSchedule" name="schedule">
            <option value="off"${briefing.schedule === "off" ? " selected" : ""}>Off</option>
            <option value="daily"${briefing.schedule === "daily" ? " selected" : ""}>Daily</option>
            <option value="weekly"${
    briefing.schedule === "weekly" ? " selected" : ""
  }>Weekly (Mondays)</option>
          </select>
        </div>
        <div class="field">
          <label for="briefingHour">Delivery hour</label>
          <select id="briefingHour" name="hourUtc">${briefingHourOptions}</select>
        </div>
        <div class="field">
          <label for="briefingMode">Format</label>
          <select id="briefingMode" name="mode">
            <option value="direct"${
    briefing.mode === "direct" ? " selected" : ""
  }>Direct narration</option>
            <option value="deepdive"${
    briefing.mode === "deepdive" ? " selected" : ""
  }>Two-host Deep Dive</option>
          </select>
        </div>
        <div class="field">
          <label for="briefingMaxArticles">Stories per briefing</label>
          <select id="briefingMaxArticles" name="maxArticles">${briefingMaxOptions}</select>
        </div>
      </div>
      <div class="actions">
        <button class="btn" type="submit" id="saveBriefingBtn">Save briefing settings</button>
        <button class="btn quiet" type="button" id="generateBriefingBtn"${
    approved ? "" : " disabled"
  }>Generate briefing now</button>
      </div>
      <p class="feedback" id="briefingFeedback" role="status" aria-live="polite"></p>
    </form>
  </div>

  <section class="panel danger-zone" aria-labelledby="rotate-h">
    <h2 id="rotate-h">Leaked your feed URL?</h2>
    <p class="sub">Rotating makes a new feed URL and stops the old one at once. Every podcast app you subscribed needs the new one. Previously fetched audio links remain accessible until account suspension.</p>
    <div class="actions"><button class="btn danger" type="button" id="rotateToken">Rotate feed URL</button></div>
    <p class="feedback" id="rotateFeedback" role="status" aria-live="polite"></p>
  </section>
  </div>
</div>`;

  const script = `(() => {
  "use strict";
  const RP_ID = ${jsonForScript(d.rpId)};
  const USER_HANDLE = ${jsonForScript(base64url(new TextEncoder().encode(user.id)))};
  const CREDENTIAL_IDS = ${jsonForScript(d.credentials.map((c) => c.id))};
  const DISPLAY = ${jsonForScript({ name: user.email, displayName: user.displayName })};
  const FEED_BASE = ${jsonForScript(feedBase)};
  const PREFILL = ${jsonForScript(d.prefill ?? null)};
  const VOICE_CATALOG = ${
    jsonForScript(GEMINI_TTS_VOICES.map((v) => ({ name: v, style: VOICE_PROFILES[v].style })))
  };
  const RATE_PRESETS = ${jsonForScript([...SOURCE_PLAYBACK_RATE_PRESETS])};
  const NARRATION_STYLE_CATALOG = ${
    jsonForScript(NARRATION_STYLE_IDS.map((id) => ({ value: id, label: NARRATION_STYLES[id].label })))
  };
${SAME_ORIGIN_PATH_CLIENT}
${PASSKEY_CLIENT}
${CONFIRM_DIALOG_CLIENT}
  const $ = (id) => document.getElementById(id);
  const say = (el, tone, text) => { el.dataset.tone = tone; el.textContent = text; };

  // The prefill is DISPLAYED by the unified card; it is never copied into a
  // second input, which is what produced two populated forms (audio-feed-6hw).
  let feedUrl = (PREFILL && PREFILL.feedUrl) || null;

  const quickSingleBtn = $("quickSingleBtn");
  if (quickSingleBtn && PREFILL) {
    quickSingleBtn.addEventListener("click", async () => {
      const feedback = $("quickFeedback");
      const modeEl = document.querySelector("input[name=quickMode]:checked");
      const mode = modeEl ? modeEl.value : "direct";
      const styleEl = $("quickNarrationStyle");
      const narrationStyle = styleEl instanceof HTMLSelectElement ? styleEl.value : "standard";
      quickSingleBtn.disabled = true;
      say(feedback, "ok", "Queuing article for audio…");
      try {
        const res = await send("POST", "/api/ingest", { url: PREFILL.url, mode, narrationStyle });
        const title = (res && res.article && res.article.title) || PREFILL.title || "Article";
        say(feedback, "ok", "Queued for synthesis: " + title + ". It will appear in your feed once ready.");
        void refreshEpisodesListFromServer();
      } catch (err) {
        say(feedback, "error", String(err.message || err));
      } finally {
        quickSingleBtn.disabled = false;
      }
    });
  }

  const quickSubscribeBtn = $("quickSubscribeBtn");
  if (quickSubscribeBtn && PREFILL) {
    quickSubscribeBtn.addEventListener("click", async () => {
      const feedback = $("quickFeedback");
      if (!feedUrl) return;
      const styleEl = $("quickNarrationStyle");
      const narrationStyle = styleEl instanceof HTMLSelectElement ? styleEl.value : "standard";
      quickSubscribeBtn.disabled = true;
      say(feedback, "ok", "Subscribing to feed…");
      try {
        const res = await send("POST", "/api/account/sources", {
          feedUrl: feedUrl,
          title: PREFILL.title || undefined,
          modes: ["direct", "deepdive"],
          narrationStyle,
        });
        const title = (res && res.source && res.source.title) || PREFILL.title || "feed";
        say(feedback, "ok", "Subscribed to " + title + ". " + ((res && res.poll && res.poll.queued) ?? 0) + " post(s) queued.");
        setTimeout(() => location.assign("/account"), 1000);
      } catch (err) {
        say(feedback, "error", String(err.message || err));
      } finally {
        quickSubscribeBtn.disabled = false;
      }
    });
  }
  // Feed autodiscovery (audio-feed-6hw, audio-feed-oq4pz): when the bookmarklet found no feed, ask
  // the server to read the page's own declaration. Discovery is an OFFER, so a
  // refusal is silent: the single-page action already works without a feed.
  if (PREFILL && PREFILL.url && !feedUrl) {
    send("POST", "/api/account/discover-feed", { url: PREFILL.url })
      .then((found) => {
        const feed = found && found.feeds && found.feeds[0];
        if (!feed) return;
        feedUrl = feed.url;
        const detected = $("detectedFeed");
        const label = $("detectedFeedUrl");
        if (label) label.textContent = feed.title ? (feed.title + " — " + feed.url) : feed.url;
        if (detected) detected.hidden = false;
      })
      .catch(() => {});
  }

  async function send(method, path, body) {
    const res = await fetch(assertSameOriginPath(path), {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ("Request failed (" + res.status + ")"));
    return data;
  }

  // Keep password managers in step with the passkeys this account still accepts.
  if (window.PublicKeyCredential && PublicKeyCredential.signalAllAcceptedCredentials) {
    PublicKeyCredential.signalAllAcceptedCredentials({
      rpId: RP_ID, userId: USER_HANDLE, allAcceptedCredentialIds: CREDENTIAL_IDS,
    }).catch(() => {});
  }

  const copyTimers = new WeakMap();
  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-copy]");
    if (!(button instanceof HTMLButtonElement)) return;
    const prev = copyTimers.get(button);
    if (prev) clearTimeout(prev);
    try {
      await navigator.clipboard.writeText(button.dataset.copy || "");
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    copyTimers.set(button, setTimeout(() => { button.textContent = "Copy"; }, 1800));
  });

  // -- voice audition (audio-feed-msw) ---------------------------------------
  const voiceAudio = $("voiceSampleAudio");
  const voiceButtons = Array.from(document.querySelectorAll("[data-voice-sample]"));
  const voiceChoice = () => {
    const picked = document.querySelector("input[name=voice]:checked");
    return picked ? picked.value : "";
  };
  const setVoiceButton = (button, playing) => {
    const voice = button.dataset.voiceSample;
    button.setAttribute("aria-pressed", String(playing));
    button.textContent = playing ? "■ Stop sample" : "▶ Play sample";
    button.setAttribute("aria-label", (playing ? "Stop the sample of " : "Play a sample of ") + voice);
  };
  const stopVoiceSamples = (except) => {
    for (const button of voiceButtons) if (button !== except) setVoiceButton(button, false);
    if (voiceAudio && !voiceAudio.paused) voiceAudio.pause();
  };
  if (voiceAudio) {
    for (const button of voiceButtons) {
      button.addEventListener("click", async () => {
        const voice = button.dataset.voiceSample;
        const wasPlaying = button.getAttribute("aria-pressed") === "true";
        stopVoiceSamples(button);
        if (wasPlaying) {
          setVoiceButton(button, false);
          return;
        }
        setVoiceButton(button, true);
        say($("profileFeedback"), "ok", "Loading the " + voice + " sample…");
        voiceAudio.src = "/assets/voices/" + encodeURIComponent(voice);
        try {
          await voiceAudio.play();
          say($("profileFeedback"), "ok", "Playing the " + voice + " sample.");
        } catch (error) {
          // Autoplay refusal, a 401 after sign-out, a 503 with no key: the person
          // gets a sentence rather than a button that looks stuck.
          setVoiceButton(button, false);
          say($("profileFeedback"), "error", "That sample is unavailable right now.");
        }
      });
    }
    voiceAudio.addEventListener("ended", () => stopVoiceSamples(null));
    voiceAudio.addEventListener("error", () => {
      stopVoiceSamples(null);
      say($("profileFeedback"), "error", "That sample could not be played.");
    });
  }

  const sendForm = $("sendForm");
  if (sendForm) sendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = $("sendFeedback");
    const submitBtn = sendForm.querySelector('button[type="submit"]');
    const mode = document.querySelector("input[name=sendMode]:checked").value;
    const styleEl = $("sendNarrationStyle");
    const narrationStyle = styleEl instanceof HTMLSelectElement ? styleEl.value : "standard";
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
    say(feedback, "ok", "Fetching the article…");
    try {
      const res = await send("POST", "/api/ingest", {
        url: $("sendUrl").value.trim(),
        mode,
        narrationStyle,
      });
      say(feedback, "ok", "Queued: " + res.article.title + ". It appears in your feed once narrated.");
      $("sendUrl").value = "";
      void refreshEpisodesListFromServer();
    } catch (error) {
      say(feedback, "error", String(error.message || error));
    } finally {
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    }
  });

  const uploadForm = $("uploadForm");
  const uploadDropZone = $("uploadDropZone");
  const uploadFile = $("uploadFile");
  const uploadFeedback = $("uploadFeedback");

  async function uploadDocument(file) {
    if (!file) {
      say(uploadFeedback, "error", "Select a file to upload.");
      return;
    }
    const modeEl = document.querySelector("input[name=uploadMode]:checked");
    const mode = modeEl ? modeEl.value : "direct";
    say(uploadFeedback, "ok", "Uploading " + file.name + "…");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("mode", mode);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) {
        throw new Error((data && data.error) || ("Upload failed (" + res.status + ")"));
      }
      const title = (data.article && data.article.title) ? data.article.title : (data.episodeId || file.name);
      say(uploadFeedback, "ok", "Queued: " + title + ". It appears in your feed once narrated.");
      if (uploadForm) uploadForm.reset();
    } catch (error) {
      say(uploadFeedback, "error", String(error.message || error));
    }
  }

  if (uploadForm) {
    uploadForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const file = uploadFile && uploadFile.files && uploadFile.files[0];
      uploadDocument(file);
    });
  }

  if (uploadDropZone) {
    ["dragenter", "dragover"].forEach((name) => {
      uploadDropZone.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
        uploadDropZone.classList.add("dragover");
      });
    });

    ["dragleave", "dragend"].forEach((name) => {
      uploadDropZone.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
        uploadDropZone.classList.remove("dragover");
      });
    });

    uploadDropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      uploadDropZone.classList.remove("dragover");
      const dt = event.dataTransfer;
      const file = dt && dt.files && dt.files[0];
      if (file) {
        if (uploadFile) {
          try {
            uploadFile.files = dt.files;
          } catch {
            // Setting files on file input may throw in certain engines
          }
        }
        uploadDocument(file);
      }
    });
  }

  $("profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = $("profileFeedback");
    try {
      const saved = await send("POST", "/api/account/profile", {
        displayName: $("displayName").value.trim(), voice: voiceChoice(),
      });
      if (window.PublicKeyCredential && PublicKeyCredential.signalCurrentUserDetails) {
        PublicKeyCredential.signalCurrentUserDetails({
          rpId: RP_ID, userId: USER_HANDLE, name: DISPLAY.name, displayName: saved.displayName,
        }).catch(() => {});
      }
      say(feedback, "ok", "Saved.");
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      say(feedback, "error", String(error.message || error));
    }
  });

  const addSourceForm = $("addSourceForm");
  if (addSourceForm) addSourceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = $("addSourceFeedback");
    const submitBtn = addSourceForm.querySelector('button[type="submit"]');
    const feedUrlInput = $("sourceUrl").value.trim();
    const titleInput = $("sourceTitle").value.trim();
    const modes = [...document.querySelectorAll("input[name=sourceMode]:checked")].map((i) => i.value);
    const styleEl = $("sourceNarrationStyle");
    const narrationStyle = styleEl instanceof HTMLSelectElement ? styleEl.value : "standard";
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
    say(feedback, "ok", "Reading the feed…");
    try {
      const res = await send("POST", "/api/account/sources", {
        feedUrl: feedUrlInput,
        title: titleInput,
        modes,
        narrationStyle,
      });
      const src = res && res.source;
      if (sourcesList && src && src.id) {
        const alreadyListed = [...sourcesList.querySelectorAll(":scope > li")]
          .some((li) => li.dataset.sourceId === src.id);
        if (!alreadyListed) {
          sourcesList.appendChild(createSourceListItem({
            id: src.id,
            title: src.title || titleInput || feedUrlInput,
            feedUrl: src.feedUrl || feedUrlInput,
            modes: Array.isArray(src.modes) && src.modes.length ? src.modes : (modes.length ? modes : ["direct"]),
            narrationStyle: src.narrationStyle || narrationStyle,
            lastPolledAt: src.lastPolledAt || new Date().toISOString(),
          }));
          syncSourcesCount();
        }
      }
      const queued = (res && res.poll && Number(res.poll.queued)) || 0;
      say(feedback, "ok", "Added " + ((src && src.title) || "feed") + ". " + queued + " post(s) queued.");
      addSourceForm.reset();
      if (queued > 0) void refreshEpisodesListFromServer();
    } catch (error) {
      say(feedback, "error", String(error.message || error));
    } finally {
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    }
  });

  const sourcesList = $("sourcesList");
  const sourcesEmpty = $("sourcesEmpty");
  const tabFeedsPill = $("tabFeedsPill");

  function syncSourcesCount() {
    if (!sourcesList) return;
    const count = sourcesList.querySelectorAll(":scope > li").length;
    if (tabFeedsPill) tabFeedsPill.textContent = String(count);
    sourcesList.hidden = count === 0;
    if (sourcesEmpty) sourcesEmpty.hidden = count > 0;
  }

  function createCopyRow(value, label) {
    const wrap = document.createElement("div");
    wrap.className = "copy";
    const code = document.createElement("code");
    code.textContent = value;
    const btn = document.createElement("button");
    btn.className = "btn quiet small";
    btn.type = "button";
    btn.dataset.copy = value;
    btn.setAttribute("aria-label", "Copy " + label);
    btn.textContent = "Copy";
    wrap.appendChild(code);
    wrap.appendChild(btn);
    return wrap;
  }

  let dynamicSourceIndex = 0;

  function formatSourcePrefsSummary(prefs) {
    const parts = [];
    if (prefs.voice) parts.push(prefs.voice);
    if (typeof prefs.playbackRate === "number" && Number.isFinite(prefs.playbackRate)) {
      parts.push((Math.round(prefs.playbackRate * 100) / 100) + "×");
    }
    if (Array.isArray(prefs.modes) && prefs.modes[0] === "deepdive") {
      parts.push("Deep dive");
    }
    if (prefs.codeHandling === "explain") {
      parts.push("Explain code");
    }
    const styleEntry = prefs.narrationStyle && prefs.narrationStyle !== "standard"
      ? NARRATION_STYLE_CATALOG.find((item) => item.value === prefs.narrationStyle)
      : null;
    if (styleEntry) parts.push(styleEntry.label);
    return parts.length > 0
      ? { text: parts.join(" · "), customized: true }
      : { text: "Account defaults", customized: false };
  }

  function modeSelectValueFor(modes) {
    const hasDirect = modes.includes("direct");
    const hasDeepdive = modes.includes("deepdive");
    if (hasDirect && hasDeepdive) {
      return modes[0] === "deepdive" ? "deepdive,direct" : "direct,deepdive";
    }
    return modes[0] === "deepdive" ? "deepdive" : "direct";
  }

  function createSelectField(id, labelText, name, options, selectedValue) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.setAttribute("for", id);
    label.textContent = labelText;
    const select = document.createElement("select");
    select.id = id;
    select.name = name;
    for (const item of options) {
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      if (item.value === selectedValue) opt.selected = true;
      select.appendChild(opt);
    }
    field.appendChild(label);
    field.appendChild(select);
    return field;
  }

  function createSourceListItem(source) {
    const li = document.createElement("li");
    li.dataset.sourceId = source.id;
    li.dataset.sourceTitle = source.title || source.feedUrl || source.id;
    const head = document.createElement("div");
    head.className = "row-head";
    const titleSpan = document.createElement("span");
    titleSpan.className = "row-title";
    titleSpan.textContent = source.title || source.feedUrl || source.id;
    head.appendChild(titleSpan);
    if (source.id !== "inbox") {
      const rm = document.createElement("button");
      rm.className = "btn danger small";
      rm.type = "button";
      rm.dataset.removeSource = source.id;
      rm.dataset.title = source.title || source.id;
      rm.dataset.tooltip = "Remove " + (source.title || source.id);
      rm.textContent = "Remove";
      head.appendChild(rm);
    }
    li.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "meta";
    const polled = source.lastPolledAt ? String(source.lastPolledAt).slice(0, 10) : "never";
    meta.textContent = (source.feedUrl || "Articles you send") + " · last polled " + polled;
    li.appendChild(meta);

    const modes = Array.isArray(source.modes) && source.modes.length ? source.modes : ["direct"];
    const details = document.createElement("details");
    details.className = "source-feeds";
    const summary = document.createElement("summary");
    summary.textContent = "Feed URLs (" + modes.length + ")";
    details.appendChild(summary);
    const paths = document.createElement("div");
    paths.className = "feed-paths";
    for (const mode of modes) {
      const url = FEED_BASE + "/" + encodeURIComponent(source.id) + "/" + encodeURIComponent(mode) + ".xml";
      const label = (source.title || source.id) + " " + (mode === "direct" ? "read aloud" : "deep dive") + " feed";
      paths.appendChild(createCopyRow(url, label));
    }
    details.appendChild(paths);
    li.appendChild(details);

    const suffix = "dyn-" + String(++dynamicSourceIndex);
    const prefsDetails = document.createElement("details");
    prefsDetails.className = "source-prefs";
    const prefsSummary = document.createElement("summary");
    prefsSummary.appendChild(document.createTextNode("Feed defaults "));
    const prefsMeta = document.createElement("span");
    prefsMeta.className = "source-prefs-meta";
    const sourceStyle = NARRATION_STYLE_CATALOG.some((s) => s.value === source.narrationStyle)
      ? source.narrationStyle
      : "standard";
    const summaryInfo = formatSourcePrefsSummary({
      voice: source.voice || null,
      playbackRate: typeof source.playbackRate === "number" ? source.playbackRate : null,
      modes,
      codeHandling: source.codeHandling || "skip",
      narrationStyle: sourceStyle,
    });
    prefsMeta.dataset.customized = summaryInfo.customized ? "true" : "false";
    prefsMeta.textContent = summaryInfo.text;
    prefsSummary.appendChild(prefsMeta);
    prefsDetails.appendChild(prefsSummary);

    const form = document.createElement("form");
    form.className = "source-prefs-form";
    form.dataset.sourcePrefs = source.id;
    const grid = document.createElement("div");
    grid.className = "source-prefs-grid";
    const voiceOpts = [{ value: "", label: "Default" }].concat(
      VOICE_CATALOG.map((v) => ({ value: v.name, label: v.name + " — " + v.style })),
    );
    const rateOpts = [{ value: "", label: "Default" }].concat(
      RATE_PRESETS.map((r) => ({ value: String(r), label: r + "x" })),
    );
    const modeOpts = [
      { value: "direct", label: "Read aloud" },
      { value: "deepdive", label: "Deep dive (two voices)" },
      { value: "direct,deepdive", label: "Both (Read aloud default)" },
      { value: "deepdive,direct", label: "Both (Deep dive default)" },
    ];
    const codeOpts = [
      { value: "skip", label: "Skip code blocks" },
      { value: "explain", label: "Explain code blocks" },
    ];
    grid.appendChild(createSelectField("src-voice-" + suffix, "Voice", "voice", voiceOpts, source.voice || ""));
    grid.appendChild(
      createSelectField(
        "src-rate-" + suffix,
        "Default playback speed",
        "playbackRate",
        rateOpts,
        typeof source.playbackRate === "number" ? String(source.playbackRate) : "",
      ),
    );
    grid.appendChild(
      createSelectField("src-mode-" + suffix, "Default mode", "mode", modeOpts, modeSelectValueFor(modes)),
    );
    grid.appendChild(
      createSelectField(
        "src-code-" + suffix,
        "Code handling",
        "codeHandling",
        codeOpts,
        source.codeHandling === "explain" ? "explain" : "skip",
      ),
    );
    grid.appendChild(
      createSelectField(
        "src-style-" + suffix,
        "Narration style",
        "narrationStyle",
        NARRATION_STYLE_CATALOG,
        sourceStyle,
      ),
    );
    form.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "actions";
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn small";
    saveBtn.type = "submit";
    saveBtn.textContent = "Save defaults";
    const fb = document.createElement("span");
    fb.className = "row-feedback source-prefs-feedback";
    fb.setAttribute("role", "status");
    fb.setAttribute("aria-live", "polite");
    actions.appendChild(saveBtn);
    actions.appendChild(fb);
    form.appendChild(actions);
    prefsDetails.appendChild(form);
    li.appendChild(prefsDetails);
    return li;
  }

  if (sourcesList) {
    sourcesList.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("[data-remove-source]");
      if (!(button instanceof HTMLButtonElement) || button.disabled) return;
      const ok = await askConfirm("Remove " + button.dataset.title + "? Episodes already made stay in your feed.", {
        title: "Remove Feed Source",
        confirmText: "Remove",
      });
      if (!ok) return;
      button.disabled = true;
      try {
        await send("DELETE", "/api/account/sources/" + encodeURIComponent(button.dataset.removeSource));
        const li = button.closest("li");
        if (li) li.remove();
        syncSourcesCount();
        say($("sourcesFeedback"), "ok", "Removed " + (button.dataset.title || "source") + ".");
      } catch (error) {
        say($("sourcesFeedback"), "error", String(error.message || error));
        button.disabled = false;
      }
    });

    sourcesList.addEventListener("submit", async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.dataset.sourcePrefs) return;
      event.preventDefault();
      const sourceId = form.dataset.sourcePrefs;
      const submitBtn = form.querySelector('button[type="submit"]');
      const feedback = form.querySelector(".source-prefs-feedback");
      const voiceEl = form.elements.namedItem("voice");
      const rateEl = form.elements.namedItem("playbackRate");
      const modeEl = form.elements.namedItem("mode");
      const codeEl = form.elements.namedItem("codeHandling");
      const styleEl = form.elements.namedItem("narrationStyle");

      const voiceVal = voiceEl instanceof HTMLSelectElement ? voiceEl.value : "";
      const rateVal = rateEl instanceof HTMLSelectElement ? rateEl.value : "";
      const modeVal = modeEl instanceof HTMLSelectElement ? modeEl.value : "direct";
      const codeVal = codeEl instanceof HTMLSelectElement ? codeEl.value : "skip";
      const styleVal = styleEl instanceof HTMLSelectElement ? styleEl.value : "standard";

      const payload = {
        voice: voiceVal || null,
        playbackRate: rateVal ? Number(rateVal) : null,
        modes: modeVal.split(",").filter(Boolean),
        codeHandling: codeVal,
        narrationStyle: styleVal,
      };

      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
      if (feedback instanceof HTMLElement) say(feedback, "ok", "Saving…");
      try {
        const res = await send(
          "POST",
          "/api/account/sources/" + encodeURIComponent(sourceId) + "/preferences",
          payload,
        );
        const saved = (res && res.source)
          ? { narrationStyle: styleVal, ...res.source }
          : payload;
        const li = form.closest("li");
        if (li) {
          const metaEl = li.querySelector(".source-prefs-meta");
          if (metaEl instanceof HTMLElement) {
            const info = formatSourcePrefsSummary(saved);
            metaEl.dataset.customized = info.customized ? "true" : "false";
            metaEl.textContent = info.text;
          }
          const feedsDetails = li.querySelector("details.source-feeds");
          if (feedsDetails && Array.isArray(saved.modes) && saved.modes.length > 0) {
            const feedSummary = feedsDetails.querySelector(":scope > summary");
            if (feedSummary) feedSummary.textContent = "Feed URLs (" + saved.modes.length + ")";
            const feedPaths = feedsDetails.querySelector(".feed-paths");
            if (feedPaths) {
              const title = li.dataset.sourceTitle || sourceId;
              const rows = saved.modes.map((mode) => {
                const url = FEED_BASE + "/" + encodeURIComponent(sourceId) + "/" + encodeURIComponent(mode) + ".xml";
                const label = title + " " + (mode === "direct" ? "read aloud" : "deep dive") + " feed";
                return createCopyRow(url, label);
              });
              feedPaths.replaceChildren(...rows);
            }
          }
        }
        if (feedback instanceof HTMLElement) say(feedback, "ok", "Saved.");
      } catch (error) {
        if (feedback instanceof HTMLElement) say(feedback, "error", String(error.message || error));
      } finally {
        if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
      }
    });
  }

  const opmlImportForm = $("opmlImportForm");
  const opmlFile = $("opmlFile");
  const opmlImportBtn = $("opmlImportBtn");
  const opmlProgress = $("opmlProgress");
  const opmlResult = $("opmlResult");

  function showOpmlResult(tone, summaryText, failedItems) {
    if (!opmlResult) return;
    opmlResult.hidden = false;
    opmlResult.dataset.tone = tone;
    const p = document.createElement("p");
    p.className = "opml-result-summary";
    p.textContent = summaryText;
    const nodes = [p];
    if (Array.isArray(failedItems) && failedItems.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "opml-failed-list";
      for (const item of failedItems.slice(0, 20)) {
        const li = document.createElement("li");
        li.textContent = (item.url || "Unknown URL") + " — " + (item.reason || "Import failed.");
        ul.appendChild(li);
      }
      if (failedItems.length > 20) {
        const more = document.createElement("li");
        more.textContent = "…and " + (failedItems.length - 20) + " more.";
        ul.appendChild(more);
      }
      nodes.push(ul);
    }
    opmlResult.replaceChildren(...nodes);
  }

  if (opmlImportForm) {
    opmlImportForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = opmlFile && opmlFile.files && opmlFile.files[0];
      if (!file) {
        showOpmlResult("error", "Choose an OPML file to import.");
        return;
      }
      if (file.size > 512 * 1024) {
        showOpmlResult("error", "That OPML file exceeds the 512 KiB limit.");
        return;
      }
      const modeEl = document.querySelector("input[name=opmlMode]:checked");
      const mode = modeEl ? modeEl.value : "direct";
      if (opmlImportBtn) opmlImportBtn.disabled = true;
      if (opmlProgress) opmlProgress.hidden = false;
      showOpmlResult("ok", "Importing subscriptions from " + file.name + "…");
      try {
        const opml = await file.text();
        const res = await send("POST", "/api/account/sources/opml", { opml, mode });
        const added = Number(res && res.added) || 0;
        const skipped = Number(res && res.skipped) || 0;
        const failed = Array.isArray(res && res.failed) ? res.failed : [];
        const truncated = Number(res && res.truncated) || 0;
        if (sourcesList && Array.isArray(res && res.sources) && res.sources.length > 0) {
          for (const src of res.sources) {
            sourcesList.appendChild(createSourceListItem(src));
          }
          syncSourcesCount();
        }
        const parts = [
          "Added " + added + " feed" + (added === 1 ? "" : "s"),
          "skipped " + skipped + " already subscribed",
          failed.length + " failed",
        ];
        let summary = parts.join(", ") + ".";
        if (truncated > 0) {
          summary += " " + truncated + " additional feed(s) exceeded the 100-feed per-import limit.";
        }
        const tone = failed.length > 0 && added === 0 ? "error" : failed.length > 0 ? "warn" : "ok";
        showOpmlResult(tone, summary, failed);
        if (added > 0 || skipped > 0) opmlImportForm.reset();
      } catch (error) {
        showOpmlResult("error", String(error.message || error));
      } finally {
        if (opmlProgress) opmlProgress.hidden = true;
        if (opmlImportBtn) opmlImportBtn.disabled = false;
      }
    });
  }

  // ── Morning Briefing settings & on-demand generation (Settings tab) ─────
  const briefingForm = $("briefingForm");
  const briefingSchedule = $("briefingSchedule");
  const briefingHour = $("briefingHour");
  const briefingMode = $("briefingMode");
  const briefingMaxArticles = $("briefingMaxArticles");
  const briefingEligibility = $("briefingEligibility");
  const briefingScheduleBadge = $("briefingScheduleBadge");
  const saveBriefingBtn = $("saveBriefingBtn");
  const generateBriefingBtn = $("generateBriefingBtn");
  const briefingFeedback = $("briefingFeedback");

  let briefingStats = null;
  let briefingLoaded = false;
  let briefingLoadPromise = null;

  function formatUtcHour(hour) {
    return String(hour).padStart(2, "0") + ":00 UTC";
  }

  function updateBriefingBadge(schedule, hourUtc) {
    if (!briefingScheduleBadge) return;
    briefingScheduleBadge.dataset.schedule = schedule;
    if (schedule === "daily") {
      briefingScheduleBadge.textContent = "Daily · " + formatUtcHour(hourUtc);
    } else if (schedule === "weekly") {
      briefingScheduleBadge.textContent = "Weekly (Mon) · " + formatUtcHour(hourUtc);
    } else {
      briefingScheduleBadge.textContent = "Off";
    }
  }

  function renderBriefingEligibility() {
    if (!briefingEligibility || !briefingStats) return;
    const selectedSchedule = briefingSchedule instanceof HTMLSelectElement ? briefingSchedule.value : "off";
    const isWeekly = selectedSchedule === "weekly";
    const primaryCount = isWeekly ? briefingStats.weeklyArticleCount : briefingStats.dailyArticleCount;
    const primaryWindow = isWeekly ? "past 7 days" : "past 24 hours";
    const otherCount = isWeekly ? briefingStats.dailyArticleCount : briefingStats.weeklyArticleCount;
    const otherWindow = isWeekly ? "past 24 hours" : "past 7 days";
    let text = primaryCount + " unread " + (primaryCount === 1 ? "story" : "stories") +
      " eligible in the " + primaryWindow + " (" + otherCount + " in the " + otherWindow + ").";
    if (briefingStats.lastGeneratedDate) {
      text += " Last generated " + briefingStats.lastGeneratedDate + ".";
    }
    briefingEligibility.textContent = text;
  }

  function loadBriefingStatus(force) {
    if (!briefingForm) return Promise.resolve();
    if (briefingLoaded && !force) return Promise.resolve();
    if (briefingLoadPromise) return briefingLoadPromise;
    briefingLoadPromise = send("GET", "/api/account/briefing")
      .then((data) => {
        if (!data) return;
        briefingLoaded = true;
        briefingStats = {
          dailyArticleCount: Number(data.dailyArticleCount) || 0,
          weeklyArticleCount: Number(data.weeklyArticleCount) || 0,
          lastGeneratedDate: data.briefing && data.briefing.lastGeneratedDate
            ? String(data.briefing.lastGeneratedDate)
            : null,
        };
        renderBriefingEligibility();
      })
      .catch(() => {
        // Keep server-rendered defaults intact if background eligibility fetch fails.
      })
      .finally(() => {
        briefingLoadPromise = null;
      });
    return briefingLoadPromise;
  }

  if (briefingSchedule) {
    briefingSchedule.addEventListener("change", () => {
      renderBriefingEligibility();
    });
  }

  if (briefingForm) {
    briefingForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!briefingFeedback) return;
      const schedule = briefingSchedule instanceof HTMLSelectElement ? briefingSchedule.value : "off";
      const hourUtc = briefingHour instanceof HTMLSelectElement ? Number(briefingHour.value) : 7;
      const mode = briefingMode instanceof HTMLSelectElement ? briefingMode.value : "direct";
      const maxArticles = briefingMaxArticles instanceof HTMLSelectElement
        ? Number(briefingMaxArticles.value)
        : 8;
      if (saveBriefingBtn instanceof HTMLButtonElement) saveBriefingBtn.disabled = true;
      say(briefingFeedback, "ok", "Saving briefing settings…");
      try {
        const res = await send("POST", "/api/account/briefing", {
          schedule,
          hourUtc,
          mode,
          maxArticles,
        });
        const saved = (res && res.briefing) || { schedule, hourUtc, mode, maxArticles };
        updateBriefingBadge(saved.schedule, saved.hourUtc);
        if (briefingStats) {
          if (saved.lastGeneratedDate) briefingStats.lastGeneratedDate = saved.lastGeneratedDate;
          renderBriefingEligibility();
        }
        const summary = saved.schedule === "off"
          ? "Briefing settings saved. Scheduled briefings are off."
          : "Briefing settings saved (" +
            (saved.schedule === "weekly" ? "Weekly Mondays" : "Daily") + " at " +
            formatUtcHour(saved.hourUtc) + ").";
        say(briefingFeedback, "ok", summary);
      } catch (error) {
        say(briefingFeedback, "error", String(error.message || error));
      } finally {
        if (saveBriefingBtn instanceof HTMLButtonElement) saveBriefingBtn.disabled = false;
      }
    });
  }

  if (generateBriefingBtn) {
    generateBriefingBtn.addEventListener("click", async () => {
      if (!briefingFeedback || generateBriefingBtn.disabled) return;
      const chosenSchedule = briefingSchedule instanceof HTMLSelectElement ? briefingSchedule.value : "daily";
      const schedule = chosenSchedule === "weekly" ? "weekly" : "daily";
      const mode = briefingMode instanceof HTMLSelectElement ? briefingMode.value : "direct";
      const maxArticles = briefingMaxArticles instanceof HTMLSelectElement
        ? Number(briefingMaxArticles.value)
        : 8;
      generateBriefingBtn.disabled = true;
      say(briefingFeedback, "ok", "Compiling your morning briefing…");
      try {
        const res = await send("POST", "/api/account/briefing/generate", {
          schedule,
          mode,
          maxArticles,
        });
        const status = res && res.status;
        if (status === "queued") {
          const count = Number(res.articleCount) || 0;
          say(
            briefingFeedback,
            "ok",
            "Morning briefing queued (" + count + " " + (count === 1 ? "story" : "stories") +
              "). Episodes list refreshed.",
          );
          if (res.dateKey && briefingStats) {
            briefingStats.lastGeneratedDate = String(res.dateKey);
            renderBriefingEligibility();
          } else if (res.dateKey && briefingEligibility) {
            briefingEligibility.textContent = "Last briefing generated " + String(res.dateKey) + ".";
          }
          await refreshEpisodesListFromServer();
        } else if (status === "exists") {
          const label = res.schedule === "weekly" ? "weekly" : "daily";
          say(
            briefingFeedback,
            "ok",
            "Today's " + label + " briefing (" + (res.dateKey || "today") + ") already exists in your feed.",
          );
        } else if (status === "empty") {
          const win = res.schedule === "weekly" ? "past 7 days" : "past 24 hours";
          say(
            briefingFeedback,
            "ok",
            "No new unread articles found in the " + win + " for a briefing.",
          );
        } else {
          say(briefingFeedback, "ok", "Briefing request completed.");
        }
      } catch (error) {
        say(briefingFeedback, "error", String(error.message || error));
      } finally {
        generateBriefingBtn.disabled = false;
      }
    });
  }

  const episodesList = $("episodesList");
  const retryFailed = $("retryFailed");
  const regenOutdated = $("regenOutdated");
  const tabFailedPill = $("tabFailedPill");
  const failedTriageBar = $("failedTriageBar");
  const failedTriageSummary = $("failedTriageSummary");
  const bulkRetryFailed = $("bulkRetryFailed");
  const bulkClearFailed = $("bulkClearFailed");

  // ── Accessible 4-tab workspace controller (URL hash + keyboard arrows) ──
  const tabs = [...document.querySelectorAll('.account-tab[role="tab"]')];
  const panels = new Map(
    tabs.map((t) => [t.dataset.tab, document.getElementById(t.getAttribute("aria-controls"))]),
  );

  function activateTab(tabName, opts) {
    const target = panels.has(tabName) ? tabName : "episodes";
    for (const tab of tabs) {
      const selected = tab.dataset.tab === target;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      const panel = panels.get(tab.dataset.tab);
      if (panel) panel.hidden = !selected;
    }
    if (!opts || opts.updateHash !== false) {
      try {
        history.replaceState(null, "", location.pathname + location.search + "#" + target);
      } catch { /* ignore */ }
    }
    if (opts && opts.focus) {
      const activeBtn = tabs.find((t) => t.dataset.tab === target);
      if (activeBtn) activeBtn.focus();
    }
    if (target === "settings") {
      void loadBriefingStatus(false);
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      const idx = tabs.indexOf(tab);
      let next = -1;
      if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        activateTab(tabs[next].dataset.tab, { focus: true });
      }
    });
  }

  function syncTabFromHash() {
    const raw = (location.hash || "").replace(/^#/, "").toLowerCase();
    if (raw === "episodes" || raw === "episodes-h") activateTab("episodes", { updateHash: false });
    else if (raw === "add" || raw === "send-h") activateTab("add", { updateHash: false });
    else if (raw === "feeds" || raw === "feeds-h") activateTab("feeds", { updateHash: false });
    else if (
      raw === "settings" || raw === "profile-h" || raw === "passkeys-h" ||
      raw === "briefing" || raw === "briefing-h"
    ) {
      activateTab("settings", { updateHash: false });
    }
  }
  if (location.hash) syncTabFromHash();
  window.addEventListener("hashchange", syncTabFromHash);
  const settingsTabPanel = $("panel-settings");
  if (settingsTabPanel && !settingsTabPanel.hidden) {
    void loadBriefingStatus(false);
  }

  // ── Episode status, source, and text filtering ──────────────────────────
  let activeStatusFilter = "all";
  const epFilterSource = $("epFilterSource");
  const epFilterQuery = $("epFilterQuery");
  const epFilterEmpty = $("epFilterEmpty");
  const epClearFilters = $("epClearFilters");
  const statusChips = [...document.querySelectorAll("[data-filter-status]")];

  function applyEpisodeFilters() {
    if (!episodesList) return;
    const sourceVal = epFilterSource ? epFilterSource.value : "";
    const queryVal = epFilterQuery ? epFilterQuery.value.trim().toLowerCase() : "";
    let visible = 0;
    const rows = episodesList.querySelectorAll("li[data-episode-id]");
    for (const li of rows) {
      const st = li.dataset.episodeStatus || "";
      const regen = li.dataset.episodeRegenerating === "1";
      let statusMatch = true;
      if (activeStatusFilter === "ready") statusMatch = st === "ready" && !regen;
      else if (activeStatusFilter === "active") {
        statusMatch = st === "pending" || st === "synthesizing" || regen;
      } else if (activeStatusFilter === "failed") statusMatch = st === "failed";

      const src = li.dataset.episodeSource || "";
      const sourceMatch = !sourceVal || src === sourceVal;
      const hay = ((li.dataset.episodeTitle || "") + " " + src).toLowerCase();
      const queryMatch = !queryVal || hay.includes(queryVal);
      const show = statusMatch && sourceMatch && queryMatch;
      li.hidden = !show;
      if (show) visible++;
    }
    if (epFilterEmpty) {
      epFilterEmpty.hidden = rows.length === 0 || visible > 0;
    }
  }

  for (const chip of statusChips) {
    chip.addEventListener("click", () => {
      activeStatusFilter = chip.dataset.filterStatus || "all";
      for (const c of statusChips) {
        c.setAttribute("aria-pressed", c === chip ? "true" : "false");
      }
      applyEpisodeFilters();
    });
  }
  if (epFilterSource) epFilterSource.addEventListener("change", applyEpisodeFilters);
  if (epFilterQuery) epFilterQuery.addEventListener("input", applyEpisodeFilters);
  if (epClearFilters) {
    epClearFilters.addEventListener("click", () => {
      activeStatusFilter = "all";
      for (const c of statusChips) {
        c.setAttribute("aria-pressed", c.dataset.filterStatus === "all" ? "true" : "false");
      }
      if (epFilterSource) epFilterSource.value = "";
      if (epFilterQuery) epFilterQuery.value = "";
      applyEpisodeFilters();
    });
  }

  function syncFailedControls(count) {
    const n = Math.max(0, Number(count) || 0);
    if (tabFailedPill) {
      if (n > 0) {
        tabFailedPill.hidden = false;
        tabFailedPill.dataset.tone = "danger";
        tabFailedPill.textContent = n + " failed";
      } else {
        tabFailedPill.hidden = true;
        tabFailedPill.textContent = "";
      }
    }
    if (failedTriageBar) {
      failedTriageBar.hidden = n === 0;
    }
    if (failedTriageSummary) {
      failedTriageSummary.textContent = n + " failed episode" + (n === 1 ? "" : "s") + " need attention.";
    }
    if (bulkRetryFailed) {
      bulkRetryFailed.dataset.count = String(n);
      bulkRetryFailed.disabled = n === 0;
    }
    if (bulkClearFailed) {
      bulkClearFailed.dataset.count = String(n);
      bulkClearFailed.textContent = "Clear failed (" + n + ")";
      bulkClearFailed.disabled = n === 0;
    }
  }

  function setCounterButton(btn, labelPrefix, nextCount) {
    if (!btn) return;
    const count = Math.max(0, Number(nextCount) || 0);
    btn.dataset.count = String(count);
    btn.textContent = labelPrefix + " (" + count + ")";
    btn.disabled = count === 0;
    if (btn === retryFailed) syncFailedControls(count);
  }

  function rowBodyOf(li) {
    return (li && li.querySelector(".ep-row-body")) || li;
  }

  function setRowFeedback(li, tone, text) {
    if (!li) return;
    const container = rowBodyOf(li);
    let actions = container.querySelector(".actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "actions";
      container.appendChild(actions);
    }
    let note = actions.querySelector(".row-feedback");
    if (!note) {
      note = document.createElement("span");
      note.className = "row-feedback";
      note.setAttribute("role", "status");
      note.setAttribute("aria-live", "polite");
      actions.appendChild(note);
    }
    note.dataset.tone = tone;
    note.textContent = text;
  }

  function setRowStatus(li, status, phaseText) {
    if (!li) return;
    li.dataset.episodeStatus = status;
    const badge = li.querySelector(".ep-status");
    if (badge) {
      badge.dataset.status = status;
      badge.textContent = status;
    }
    const phaseEl = li.querySelector(".ep-phase");
    if (phaseEl) {
      phaseEl.textContent = phaseText || "";
    }
    if (status !== "failed") {
      const disc = li.querySelector(".error-disclosure");
      if (disc) disc.remove();
      const errEl = li.querySelector(".error-detail");
      if (errEl) errEl.remove();
    }
  }

  function hasActiveEpisodes() {
    if (!episodesList) return false;
    for (const li of episodesList.querySelectorAll("li[data-episode-id]")) {
      const st = li.dataset.episodeStatus;
      if (st === "pending" || st === "synthesizing" || li.dataset.episodeRegenerating === "1") {
        return true;
      }
    }
    return false;
  }

  let pollTimer = null;
  let pollInFlight = false;

  function syncEpisodeRowFromServer(currentLi, freshLi) {
    const freshStatus = freshLi.dataset.episodeStatus || "";
    const freshRegen = freshLi.dataset.episodeRegenerating || "0";
    const freshOutdated = freshLi.dataset.episodeOutdated || "0";
    const freshPhaseEl = freshLi.querySelector(".ep-phase");
    const freshPhase = freshPhaseEl ? freshPhaseEl.textContent || "" : "";
    const prevStatus = currentLi.dataset.episodeStatus || "";
    const prevRegen = currentLi.dataset.episodeRegenerating || "0";
    const body = rowBodyOf(currentLi);

    currentLi.dataset.episodeRegenerating = freshRegen;
    currentLi.dataset.episodeOutdated = freshOutdated;
    setRowStatus(currentLi, freshStatus, freshPhase);

    const freshErr = freshLi.querySelector(".error-detail");
    const freshSummary = freshLi.querySelector(".error-disclosure > summary");
    const existingDisc = currentLi.querySelector(".error-disclosure");
    if (freshErr) {
      const summaryText = freshSummary ? freshSummary.textContent : freshErr.textContent;
      if (existingDisc) {
        const s = existingDisc.querySelector("summary");
        const d = existingDisc.querySelector(".error-detail");
        if (s) s.textContent = summaryText;
        if (d) d.textContent = freshErr.textContent;
      } else {
        const details = document.createElement("details");
        details.className = "error-disclosure";
        const summary = document.createElement("summary");
        summary.textContent = summaryText;
        const div = document.createElement("div");
        div.className = "error-detail";
        div.textContent = freshErr.textContent;
        details.appendChild(summary);
        details.appendChild(div);
        const actions = body.querySelector(".actions");
        if (actions) body.insertBefore(details, actions);
        else body.appendChild(details);
      }
    } else if (existingDisc) {
      existingDisc.remove();
    }

    const freshAudio = freshLi.querySelector("audio.ep-audio");
    const existingAudio = currentLi.querySelector("audio.ep-audio");
    if (freshAudio) {
      const src = freshAudio.getAttribute("src") || "";
      if (src) {
        const safeSrc = assertSameOriginPath(src);
        if (!existingAudio) {
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.preload = "none";
          audio.className = "ep-audio";
          audio.src = safeSrc;
          const meta = body.querySelector(".meta");
          if (meta && meta.nextSibling) body.insertBefore(audio, meta.nextSibling);
          else body.appendChild(audio);
        } else if (existingAudio.getAttribute("src") !== safeSrc && existingAudio.paused) {
          existingAudio.src = safeSrc;
        }
      }
    }

    // Update the action button only when the row crosses into a terminal or retryable state,
    // so we never clobber an in-flight button or steal focus while the user scrolls.
    if (prevStatus !== freshStatus || prevRegen !== freshRegen) {
      const freshBtn = freshLi.querySelector(".actions button");
      const actions = body.querySelector(".actions");
      const hadFocus = actions && actions.contains(document.activeElement);
      if (freshBtn) {
        const nextActions = actions || document.createElement("div");
        nextActions.className = "actions";
        const newBtn = document.createElement("button");
        newBtn.type = "button";
        newBtn.className = freshBtn.className;
        newBtn.textContent = freshBtn.textContent;
        for (const attr of freshBtn.attributes) {
          if (attr.name.startsWith("data-")) {
            newBtn.setAttribute(attr.name, attr.value);
          }
        }
        nextActions.replaceChildren(newBtn);
        if (!actions) body.appendChild(nextActions);
        if (hadFocus) newBtn.focus();
      } else if (actions && (freshStatus === "pending" || freshStatus === "synthesizing")) {
        const existingBtn = actions.querySelector("button");
        if (existingBtn) {
          existingBtn.setAttribute("aria-disabled", "true");
          existingBtn.textContent = freshStatus === "synthesizing" ? "Synthesizing…" : "Queued";
        }
      } else if (actions) {
        actions.remove();
      }
    }
    applyEpisodeFilters();
  }

  async function pollEpisodeStatuses() {
    if (pollInFlight || document.hidden || !episodesList) return;
    if (!hasActiveEpisodes()) {
      stopEpisodePoll();
      return;
    }
    pollInFlight = true;
    try {
      const res = await fetch(assertSameOriginPath("/account" + (location.search || "")), {
        headers: { accept: "text/html" },
        cache: "no-store",
      });
      if (!res.ok) return;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const freshRows = new Map();
      for (const li of doc.querySelectorAll("#episodesList li[data-episode-id]")) {
        freshRows.set(li.dataset.episodeId, li);
      }
      for (const currentLi of episodesList.querySelectorAll("li[data-episode-id]")) {
        const freshLi = freshRows.get(currentLi.dataset.episodeId);
        if (freshLi) syncEpisodeRowFromServer(currentLi, freshLi);
      }
      const freshRetry = doc.getElementById("retryFailed");
      if (freshRetry && retryFailed) {
        setCounterButton(retryFailed, "Retry failed", freshRetry.dataset.count);
      }
      const freshOutdated = doc.getElementById("regenOutdated");
      if (freshOutdated && regenOutdated) {
        setCounterButton(regenOutdated, "Regenerate outdated", freshOutdated.dataset.count);
      }
    } catch {
      // Transient poll failure: try again on the next interval.
    } finally {
      pollInFlight = false;
      if (!hasActiveEpisodes()) stopEpisodePoll();
    }
  }

  function stopEpisodePoll() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleEpisodePoll() {
    if (!episodesList || !hasActiveEpisodes() || pollTimer !== null) return;
    pollTimer = setInterval(() => {
      void pollEpisodeStatuses();
    }, 6000);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && hasActiveEpisodes()) {
      void pollEpisodeStatuses();
      scheduleEpisodePoll();
    }
  });

  // Event delegation keeps scroll position & focus intact on Retry/Regenerate without reloading,
  // and continues working on rows whose actions change after live status polling.
  if (episodesList) {
    episodesList.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const regenBtn = target.closest("[data-regenerate-episode]");
      if (regenBtn instanceof HTMLButtonElement) {
        if (regenBtn.getAttribute("aria-disabled") === "true" || regenBtn.disabled) return;
        const ok = await askConfirm(
          "Regenerate " + regenBtn.dataset.title + "? This narrates it again (1 episode of synthesis).",
          { title: "Regenerate Episode", confirmText: "Regenerate" },
        );
        if (!ok) return;
        const li = regenBtn.closest("li[data-episode-id]");
        const wasOutdated = li && li.dataset.episodeOutdated === "1";
        regenBtn.setAttribute("aria-disabled", "true");
        regenBtn.textContent = "Queuing…";
        try {
          const res = await send(
            "POST",
            "/api/account/episodes/" + encodeURIComponent(regenBtn.dataset.regenerateEpisode) + "/regenerate",
            {},
          );
          const msg = res.queued ? "Queued for regeneration." : "Already queued.";
          regenBtn.textContent = "Queued";
          if (li) {
            li.dataset.episodeRegenerating = "1";
            li.dataset.episodeOutdated = "0";
            setRowFeedback(li, "ok", msg);
          }
          if (wasOutdated && res.queued && regenOutdated) {
            setCounterButton(regenOutdated, "Regenerate outdated", Number(regenOutdated.dataset.count) - 1);
          }
          say($("regenFeedback"), "ok", msg);
          scheduleEpisodePoll();
        } catch (error) {
          const errMsg = String(error.message || error);
          regenBtn.removeAttribute("aria-disabled");
          regenBtn.textContent = "Regenerate";
          if (li) setRowFeedback(li, "error", errMsg);
          say($("regenFeedback"), "error", errMsg);
        }
        return;
      }

      const retryBtn = target.closest("[data-retry-episode]");
      if (retryBtn instanceof HTMLButtonElement) {
        if (retryBtn.getAttribute("aria-disabled") === "true" || retryBtn.disabled) return;
        const ok = await askConfirm(
          "Retry episode " + retryBtn.dataset.title + "? This will re-queue it for synthesis.",
          { title: "Retry Episode", confirmText: "Retry" },
        );
        if (!ok) return;
        const li = retryBtn.closest("li[data-episode-id]");
        const wasFailed = li && li.dataset.episodeStatus === "failed";
        retryBtn.setAttribute("aria-disabled", "true");
        retryBtn.textContent = "Queuing…";
        try {
          const res = await send(
            "POST",
            "/api/account/episodes/" + encodeURIComponent(retryBtn.dataset.retryEpisode) + "/retry",
            {},
          );
          const msg = res.queued ? "Queued for retry." : "Already queued.";
          retryBtn.textContent = "Queued";
          if (li) {
            setRowStatus(li, "pending", "");
            setRowFeedback(li, "ok", msg);
          }
          if (wasFailed && retryFailed) {
            setCounterButton(retryFailed, "Retry failed", Number(retryFailed.dataset.count) - 1);
          }
          say($("regenFeedback"), "ok", msg);
          scheduleEpisodePoll();
        } catch (error) {
          const errMsg = String(error.message || error);
          retryBtn.removeAttribute("aria-disabled");
          retryBtn.textContent = "Retry";
          if (li) setRowFeedback(li, "error", errMsg);
          say($("regenFeedback"), "error", errMsg);
        }
      }
    });
  }

  if (bulkRetryFailed) {
    bulkRetryFailed.addEventListener("click", async () => {
      const count = Number(bulkRetryFailed.dataset.count) || 0;
      if (count <= 0) return;
      const batch = Math.min(count, 10);
      const ok = await askConfirm(
        "Retry up to " + batch + " failed episode" + (batch === 1 ? "" : "s") + "? Each retried episode is re-queued for synthesis.",
        { title: "Retry Failed Episodes", confirmText: "Retry up to " + batch, danger: false },
      );
      if (!ok) return;
      bulkRetryFailed.disabled = true;
      try {
        const res = await send("POST", "/api/account/episodes/bulk-failed", { action: "retry", limit: 10 });
        const retriedSet = new Set(Array.isArray(res && res.episodeIds) ? res.episodeIds : []);
        if (episodesList && retriedSet.size > 0) {
          for (const li of episodesList.querySelectorAll("li[data-episode-id]")) {
            if (!retriedSet.has(li.dataset.episodeId)) continue;
            setRowStatus(li, "pending", "");
            setRowFeedback(li, "ok", "Queued for retry.");
            const btn = li.querySelector("[data-retry-episode]");
            if (btn) {
              btn.setAttribute("aria-disabled", "true");
              btn.textContent = "Queued";
            }
          }
        }
        const remaining = typeof (res && res.remainingFailed) === "number"
          ? res.remainingFailed
          : Math.max(0, count - (Number(res && res.retried) || 0));
        if (retryFailed) setCounterButton(retryFailed, "Retry failed", remaining);
        else syncFailedControls(remaining);
        applyEpisodeFilters();
        const retried = Number(res && res.retried) || 0;
        say(
          $("regenFeedback"),
          "ok",
          retried + " failed episode" + (retried === 1 ? "" : "s") + " queued for retry." +
            (remaining > 0 ? " " + remaining + " failed remaining." : ""),
        );
        scheduleEpisodePoll();
      } catch (error) {
        say($("regenFeedback"), "error", String(error.message || error));
        bulkRetryFailed.disabled = Number(bulkRetryFailed.dataset.count) === 0;
      }
    });
  }

  if (bulkClearFailed) {
    bulkClearFailed.addEventListener("click", async () => {
      const count = Number(bulkClearFailed.dataset.count) || 0;
      if (count <= 0) return;
      const batch = Math.min(count, 200);
      const ok = await askConfirm(
        "Permanently delete up to " + batch + " failed episode" + (batch === 1 ? "" : "s") +
          " and any partial audio segments? Ready episodes are never touched.",
        { title: "Clear Failed Episodes", confirmText: "Clear Failed", danger: true },
      );
      if (!ok) return;
      bulkClearFailed.disabled = true;
      try {
        const res = await send("POST", "/api/account/episodes/bulk-failed", { action: "delete", limit: 200 });
        const deletedSet = new Set(Array.isArray(res && res.episodeIds) ? res.episodeIds : []);
        if (episodesList && deletedSet.size > 0) {
          for (const li of [...episodesList.querySelectorAll("li[data-episode-id]")]) {
            if (deletedSet.has(li.dataset.episodeId)) li.remove();
          }
        }
        const remaining = typeof (res && res.remainingFailed) === "number"
          ? res.remainingFailed
          : Math.max(0, count - (Number(res && res.deleted) || 0));
        if (retryFailed) setCounterButton(retryFailed, "Retry failed", remaining);
        else syncFailedControls(remaining);
        applyEpisodeFilters();
        const deleted = Number(res && res.deleted) || 0;
        say(
          $("regenFeedback"),
          "ok",
          "Cleared " + deleted + " failed episode" + (deleted === 1 ? "" : "s") + "." +
            (remaining > 0 ? " " + remaining + " failed remaining." : ""),
        );
      } catch (error) {
        say($("regenFeedback"), "error", String(error.message || error));
        bulkClearFailed.disabled = Number(bulkClearFailed.dataset.count) === 0;
      }
    });
  }

  if (retryFailed) {
    retryFailed.addEventListener("click", async () => {
      const count = Number(retryFailed.dataset.count);
      const ok = await askConfirm("Retry " + count + " failed episode(s)? This will re-queue each failed episode for synthesis.", {
        title: "Retry Failed Episodes",
        confirmText: "Retry All",
      });
      if (!ok) return;
      retryFailed.disabled = true;
      try {
        const res = await send("POST", "/api/account/regenerate", { scope: "failed" });
        if (episodesList) {
          for (const li of episodesList.querySelectorAll('li[data-episode-status="failed"]')) {
            setRowStatus(li, "pending", "");
            const btn = li.querySelector("[data-retry-episode]");
            if (btn) {
              btn.setAttribute("aria-disabled", "true");
              btn.textContent = "Queued";
            }
          }
        }
        setCounterButton(retryFailed, "Retry failed", Math.max(0, count - (Number(res.queued) || 0)));
        say($("regenFeedback"), "ok", res.queued + " episode(s) queued for retry.");
        scheduleEpisodePoll();
      } catch (error) {
        say($("regenFeedback"), "error", String(error.message || error));
        retryFailed.disabled = false;
      }
    });
  }
  if (regenOutdated) {
    regenOutdated.addEventListener("click", async () => {
      const count = Number(regenOutdated.dataset.count);
      const ok = await askConfirm("Regenerate " + count + " outdated episode(s)? Each one is narrated again, which is " + count + " episode(s) of synthesis.", {
        title: "Regenerate Outdated Episodes",
        confirmText: "Regenerate All",
      });
      if (!ok) return;
      regenOutdated.disabled = true;
      try {
        const res = await send("POST", "/api/account/regenerate", {});
        if (episodesList) {
          for (const li of episodesList.querySelectorAll('li[data-episode-outdated="1"]')) {
            li.dataset.episodeRegenerating = "1";
            li.dataset.episodeOutdated = "0";
            const btn = li.querySelector("[data-regenerate-episode]");
            if (btn) {
              btn.setAttribute("aria-disabled", "true");
              btn.textContent = "Queued";
            }
          }
        }
        setCounterButton(regenOutdated, "Regenerate outdated", Math.max(0, count - (Number(res.queued) || 0)));
        say($("regenFeedback"), "ok", res.queued + " episode(s) queued for regeneration.");
        scheduleEpisodePoll();
      } catch (error) {
        say($("regenFeedback"), "error", String(error.message || error));
        regenOutdated.disabled = false;
      }
    });
  }

  // If episodes are already pending or synthesizing on load, track them live in-place.
  scheduleEpisodePoll();

  async function refreshEpisodesListFromServer() {
    if (!episodesList) return;
    try {
      const res = await fetch(assertSameOriginPath("/account" + (location.search || "")), {
        headers: { accept: "text/html" },
        cache: "no-store",
      });
      if (!res.ok) return;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const freshList = doc.getElementById("episodesList");
      if (freshList) {
        const existingById = new Map();
        for (const li of episodesList.querySelectorAll("li[data-episode-id]")) {
          existingById.set(li.dataset.episodeId, li);
        }
        const freshItems = [...freshList.querySelectorAll("li[data-episode-id]")];
        let insertBeforeNode = episodesList.firstElementChild;
        for (const freshLi of freshItems) {
          const id = freshLi.dataset.episodeId;
          const existing = existingById.get(id);
          if (existing) {
            syncEpisodeRowFromServer(existing, freshLi);
            insertBeforeNode = existing.nextElementSibling;
          } else {
            const adopted = document.importNode(freshLi, true);
            const importedAudio = adopted.querySelector("audio.ep-audio");
            if (importedAudio) {
              const src = importedAudio.getAttribute("src") || "";
              if (src) importedAudio.setAttribute("src", assertSameOriginPath(src));
            }
            episodesList.insertBefore(adopted, insertBeforeNode);
          }
        }
        const hasRows = episodesList.querySelectorAll("li[data-episode-id]").length > 0;
        episodesList.hidden = !hasRows;
        const emptyEl = $("episodesEmpty");
        if (emptyEl) emptyEl.hidden = hasRows;
      }
      const freshSourceSelect = doc.getElementById("epFilterSource");
      if (freshSourceSelect && epFilterSource) {
        const prevVal = epFilterSource.value;
        const opts = [...freshSourceSelect.querySelectorAll("option")].map((o) => {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.textContent;
          return opt;
        });
        epFilterSource.replaceChildren(...opts);
        epFilterSource.value = prevVal;
      }
      const freshRetry = doc.getElementById("retryFailed");
      if (freshRetry && retryFailed) {
        setCounterButton(retryFailed, "Retry failed", freshRetry.dataset.count);
      }
      const freshOutdated = doc.getElementById("regenOutdated");
      if (freshOutdated && regenOutdated) {
        setCounterButton(regenOutdated, "Regenerate outdated", freshOutdated.dataset.count);
      }
      applyEpisodeFilters();
      scheduleEpisodePoll();
    } catch {
      // Transient refresh failure: polling will pick up updates on next tick.
    }
  }

  $("rotateToken").addEventListener("click", async () => {
    const ok = await askConfirm("Make a new feed URL? The current one stops working in every podcast app straight away. Previously fetched audio links remain accessible until account suspension.", {
      title: "Rotate Feed URL",
      confirmText: "Make New URL",
    });
    if (!ok) return;
    try {
      await send("POST", "/api/account/rotate-token", {});
      location.reload();
    } catch (error) {
      say($("rotateFeedback"), "error", String(error.message || error));
    }
  });

  const addPasskey = $("addPasskey");
  const passkeyFeedback = $("passkeyFeedback");
  if (!passkeysSupported) {
    addPasskey.hidden = true;
    say(passkeyFeedback, "error", "This browser can't create passkeys. Add one from another device.");
  }
  addPasskey.addEventListener("click", async () => {
    addPasskey.disabled = true;
    say(passkeyFeedback, "ok", "Follow your device's prompt…");
    try {
      const data = await post("/api/auth/register/options", {});
      const cred = await navigator.credentials.create({ publicKey: creationOptions(data.options) });
      await post("/api/auth/register/verify", credentialJSON(cred));
      location.reload();
    } catch (error) {
      say(passkeyFeedback, "error", ceremonyError(error));
      addPasskey.disabled = false;
    }
  });

  for (const button of document.querySelectorAll("[data-remove-passkey]")) {
    button.addEventListener("click", async () => {
      const ok = await askConfirm("Remove this passkey? You won't be able to sign in with it again.", {
        title: "Remove Passkey",
        confirmText: "Remove",
      });
      if (!ok) return;
      button.disabled = true;
      try {
        await send("DELETE", "/api/account/passkeys/" + encodeURIComponent(button.dataset.removePasskey));
        location.reload();
      } catch (error) {
        say(passkeyFeedback, "error", String(error.message || error));
        button.disabled = false;
      }
    });
  }
})();`;

  return renderShell({
    title: "Your account — Audio Feed",
    viewer: viewerOf(user),
    current: "account",
    kit: true,
    css: CSS,
    head: `<meta name="robots" content="noindex">`,
    main,
    script,
    nonce: d.nonce,
  });
}

function isValidWebUrl(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function handleAccount({ ctx, req }: RouteContext<AppContext>): Promise<Response> {
  const store = ctx.stores.metadata;
  const user = await sessionUser(store, req);
  const reqUrl = new URL(req.url);
  if (!user) {
    const next = encodeURIComponent(reqUrl.pathname + reqUrl.search);
    return new Response(null, {
      status: 303,
      headers: { location: `/login?next=${next}`, "cache-control": "no-store" },
    });
  }
  const baseUrl = resolveOrigin(ctx.config, req).baseUrl;
  const nonce = newCspNonce();
  const rawLimit = reqUrl.searchParams.get("limit");
  const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : 10;
  const currentLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.max(parsedLimit, 10), 100)
    : 10;

  const [sources, credentials, rawEpisodes, outdatedCount, failedCount] = await Promise.all([
    store.listSources(user.id),
    store.listCredentials(user.id),
    store.listEpisodes({ userId: user.id, limit: currentLimit + 1 }),
    user.status === "approved" ? countOutdatedEpisodes(store, user.id) : 0,
    user.status === "approved"
      ? countEpisodeScan(store, { userId: user.id, status: "failed" })
      : 0,
  ]);

  const hasMoreEpisodes = rawEpisodes.length > currentLimit;
  const episodes = hasMoreEpisodes ? rawEpisodes.slice(0, currentLimit) : rawEpisodes;
  const nextEpisodesLimit = Math.min(currentLimit + 15, 100);

  const rawAdd = reqUrl.searchParams.get("add") || reqUrl.searchParams.get("url");
  const rawTitle = reqUrl.searchParams.get("title");
  const rawFeed = reqUrl.searchParams.get("feed");

  const prefill: PrefillData | null = isValidWebUrl(rawAdd)
    ? {
      url: rawAdd!,
      title: rawTitle ? rawTitle.slice(0, 200) : "",
      feedUrl: isValidWebUrl(rawFeed) ? rawFeed! : "",
    }
    : null;

  const rawTab = reqUrl.searchParams.get("tab");
  const initialTab: "episodes" | "add" | "feeds" | "settings" =
    rawTab === "episodes" || rawTab === "add" || rawTab === "feeds" || rawTab === "settings"
      ? rawTab
      : prefill
      ? "add"
      : "episodes";

  const html = renderAccountPage({
    user,
    baseUrl,
    rpId: relyingParty(baseUrl, ctx.config.webAuthnRpId).rpID,
    sources,
    credentials,
    episodes,
    hasMoreEpisodes,
    nextEpisodesLimit,
    currentLimit,
    outdatedCount,
    failedCount,
    prefill,
    initialTab,
    nonce,
  });
  // This page renders per-episode `<audio src="/audio/...">`. That load is no-cors, so it
  // follows the audio route's 302 to the blob store's cross-origin direct URL, and CSP
  // re-evaluates media-src against that target — permit the store's own origin by name
  // (audio-feed-327mm delta) rather than re-widening to a bare scheme-source.
  return htmlResponse(html, nonce, {
    mediaSrcOrigin: blobStoreDirectUrlOrigin(ctx.stores.blobs),
    headers: {
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
