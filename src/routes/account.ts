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
import type { RouteContext } from "../router.ts";
import { resolveOrigin } from "../origin.ts";
import { base64url, sessionUser } from "../auth/sessions.ts";
import { relyingParty } from "../auth/passkeys.ts";
import { GEMINI_TTS_VOICES } from "../tts/gemini.ts";
import { INBOX_SOURCE_ID } from "../types.ts";
import type { Episode, PasskeyCredential, Source, User } from "../types.ts";
import { esc, jsonForScript } from "./html.ts";
import { PASSKEY_CLIENT, renderShell, viewerOf } from "./shell.ts";
import { countOutdatedEpisodes } from "../compose.ts";

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
  /** Published episodes made by other prompts, across the whole feed (audio-feed-ktn). */
  outdatedCount: number;
  /** Optional prefill from query params or bookmarklet (audio-feed-ep1). */
  prefill?: PrefillData | null;
}

const CSS = `
  .account-head { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 0.5rem 1rem; margin-block-end: 1.25rem; }
  .account-head h1 { margin: 0; }
  .account-head .meta { margin: 0.25rem 0 0; }
  .section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
  .feed-paths { display: grid; gap: 0.4rem; margin-block-start: 0.5rem; }
  .ep-status { font-size: 0.78rem; font-weight: 600; color: var(--muted); }
  .ep-status[data-status="ready"] { color: var(--ok); }
  .ep-status[data-status="failed"] { color: var(--danger); }
  .send-row { display: grid; gap: 0.75rem; }
  @media (min-width: 40rem) { .send-row { grid-template-columns: 1fr auto; align-items: end; } }
  .send .choices { margin-block-start: 0.75rem; }
  .danger-zone { border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
  .quick-add { border-inline-start: 4px solid var(--accent); background: var(--surface); margin-block-end: 1.5rem; }
  .quick-grid { display: grid; gap: 1rem; margin-block: 1rem; }
  @media (min-width: 44rem) { .quick-grid { grid-template-columns: 1fr 1fr; } }
  .quick-card { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); display: flex; flex-direction: column; justify-content: space-between; gap: 0.75rem; }
  .bookmarklet-box { margin-block-start: 1rem; padding: var(--space-4); border: 1px dashed var(--border); border-radius: var(--radius); background: var(--surface-2); }
  .bookmarklet-btn { cursor: grab; display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 600; text-decoration: none; user-select: none; }
  .bookmarklet-btn:active { cursor: grabbing; }
`;

function when(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "never";
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
  const approved = user.status === "approved";

  const sourceItems = d.sources.map((s) => {
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
      }" data-title="${esc(s.title)}">Remove</button>`;
    return `<li><div class="row-head"><span class="row-title">${esc(s.title)}</span>${remove}</div>
      <div class="meta">${s.feedUrl ? esc(s.feedUrl) : "Articles you send"} · last polled ${
      when(s.lastPolledAt)
    }</div>
      <div class="feed-paths">${paths}</div></li>`;
  }).join("");

  const episodeItems = d.episodes.map((e) =>
    `<li><div class="row-head"><span class="row-title">${esc(e.title)}</span>
      <span class="ep-status" data-status="${esc(e.status)}">${esc(e.status)}</span></div>
      <div class="meta">${e.mode === "direct" ? "Read aloud" : "Deep dive"} · ${
      esc(e.sourceTitle ?? e.sourceId)
    } · ${when(e.createdAt)}</div>
${
      approved && e.status === "ready" && !e.regenerating
        ? `
      <div class="actions"><button class="btn quiet small" type="button" data-regenerate-episode="${
          esc(e.id)
        }" data-title="${esc(e.title)}">Regenerate</button></div>`
        : ""
    }
    </li>`
  ).join("");

  const passkeyItems = d.credentials.map((c) =>
    `<li><div class="row-head"><span class="row-title">${esc(c.name)}</span>
      <button class="btn danger small" type="button" data-remove-passkey="${esc(c.id)}"${
      d.credentials.length <= 1
        ? ` disabled title="Add another passkey before removing this one"`
        : ""
    }>Remove</button></div>
      <div class="meta">Added ${when(c.createdAt)} · last used ${when(c.lastUsedAt)}</div></li>`
  ).join("");

  const voiceOptions = [
    `<option value=""${user.voice ? "" : " selected"}>Deployment default</option>`,
    ...GEMINI_TTS_VOICES.map((v) =>
      `<option value="${v}"${user.voice === v ? " selected" : ""}>${v}</option>`
    ),
  ].join("");

  const pending = approved
    ? ""
    : `<p class="callout">Your account is ${
      user.status === "pending" ? "waiting for approval" : esc(user.status)
    }. Nothing is turned into audio until an admin approves it, because synthesis is the part that costs money.</p>`;

  const bookmarkletCode =
    `javascript:(function(){var u=location.href,t=document.title||'',l=document.querySelector('link[rel="alternate"][type*="rss"],link[rel="alternate"][type*="atom"],link[rel*="alternate"][type*="xml"]'),f=l?l.href:'',dest='${baseUrl}/account?add='+encodeURIComponent(u)+'&title='+encodeURIComponent(t)+(f?'&feed='+encodeURIComponent(f):'');window.open(dest,'_blank')||(location.href=dest);})();`;

  const quickAddSection = d.prefill
    ? `
  <section class="panel quick-add" id="quickAddPanel" aria-labelledby="quick-add-h">
    <h2 id="quick-add-h">Add to Audio Feed</h2>
    <p class="sub">URL detected: <strong class="prefill-title">${
      esc(d.prefill.title || d.prefill.url)
    }</strong></p>
    
    ${
      d.prefill.feedUrl
        ? `
    <div class="quick-grid">
      <div class="quick-card">
        <div>
          <h3 style="margin-top: 0; font-size: 1rem;">🎙️ Option 1: Queue this single page</h3>
          <p class="meta" style="font-size: 0.85rem; word-break: break-all;"><code>${
          esc(d.prefill.url)
        }</code></p>
          <div class="choices" role="radiogroup" aria-label="Format" style="margin-block: 0.5rem;">
            <label><input type="radio" name="quickMode" value="direct" checked> Read aloud</label>
            <label><input type="radio" name="quickMode" value="deepdive"> Deep dive</label>
          </div>
        </div>
        <button type="button" class="btn small" id="quickSingleBtn"${
          approved ? "" : " disabled"
        }>Queue Single Episode</button>
      </div>

      <div class="quick-card">
        <div>
          <h3 style="margin-top: 0; font-size: 1rem;">📡 Option 2: Subscribe to RSS feed</h3>
          <p class="meta" style="font-size: 0.85rem; word-break: break-all;">Detected feed: <code>${
          esc(d.prefill.feedUrl)
        }</code></p>
          <p class="sub" style="font-size: 0.85rem; margin-block-start: 0.25rem;">Follow publication for future articles.</p>
        </div>
        <button type="button" class="btn quiet small" id="quickSubscribeBtn"${
          approved ? "" : " disabled"
        }>Subscribe to RSS Feed</button>
      </div>
    </div>`
        : `
    <div style="margin-block: 1rem;">
      <p class="meta" style="font-size: 0.85rem; word-break: break-all;"><code>${
          esc(d.prefill.url)
        }</code></p>
      <div class="choices" role="radiogroup" aria-label="Format" style="margin-block: 0.5rem;">
        <label><input type="radio" name="quickMode" value="direct" checked> Read aloud</label>
        <label><input type="radio" name="quickMode" value="deepdive"> Deep dive</label>
      </div>
      <button type="button" class="btn small" id="quickSingleBtn"${
          approved ? "" : " disabled"
        }>Queue for Audio</button>
    </div>`
    }
    <p class="feedback" id="quickFeedback" role="status" aria-live="polite"></p>
  </section>`
    : "";

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
  ${quickAddSection}

  <section class="panel send" aria-labelledby="send-h">
    <h2 id="send-h">Send an article to audio</h2>
    <p class="sub">Paste a link. It's queued, narrated, and added to your feed.</p>
    <form id="sendForm">
      <div class="send-row">
        <div class="field"><label for="sendUrl">Article URL</label>
          <input id="sendUrl" type="url" required placeholder="https://example.com/an-article" autocomplete="url" spellcheck="false"></div>
        <button class="btn" type="submit"${approved ? "" : " disabled"}>Send to Audio</button>
      </div>
      <div class="choices" role="radiogroup" aria-label="How should it sound?">
        <label><input type="radio" name="sendMode" value="direct" checked> Read aloud</label>
        <label><input type="radio" name="sendMode" value="deepdive"> Deep dive, two voices</label>
      </div>
      <p class="feedback" id="sendFeedback" role="status" aria-live="polite"></p>
    </form>
    <div class="bookmarklet-box">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem;">
        <div>
          <strong style="display: block; font-size: 0.92rem;">Browser Bookmarklet</strong>
          <span class="sub" style="font-size: 0.85rem; color: var(--muted);">Drag this button to your bookmarks bar to add articles or feeds from any tab:</span>
        </div>
        <a class="btn quiet small bookmarklet-btn" href="${
    esc(bookmarkletCode)
  }" draggable="true" title="Drag to your bookmarks bar">
          <span aria-hidden="true">🎙️</span> Add to Audio Feed
        </a>
      </div>
    </div>
  </section>

  <section class="panel" aria-labelledby="feeds-h">
    <div class="section-title"><h2 id="feeds-h">Your feeds</h2></div>
    <p class="sub">Paste into Pocket Casts, Apple Podcasts, Overcast or any app that takes an RSS URL. The URL is your password for listening: keep it to yourself.</p>
    <div class="field"><span class="legend">Everything, newest first</span>${
    copyRow(`${feedBase}/master.xml`, "master feed URL")
  }</div>
    <h3 class="legend" style="margin: 1.25rem 0 0.4rem">Sources</h3>
    ${
    sourceItems
      ? `<ul class="rows">${sourceItems}</ul>`
      : `<p class="empty">No sources yet. Add a blog or newsletter below.</p>`
  }
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
        <div class="actions"><button class="btn" type="submit"${
    approved ? "" : " disabled"
  }>Add feed</button></div>
        <p class="feedback" id="addSourceFeedback" role="status" aria-live="polite"></p>
      </form>
    </details>
  </section>

  <div class="grid two">
    <section class="panel" aria-labelledby="profile-h">
      <h2 id="profile-h">Profile</h2>
      <p class="sub">How you appear, and the voice that reads to you.</p>
      <form id="profileForm" class="stack">
        <div class="field"><label for="displayName">Display name</label>
          <input id="displayName" type="text" maxlength="80" required value="${
    esc(user.displayName)
  }" autocomplete="name"></div>
        <div class="field"><label for="voice">Preferred voice <span class="hint">for read-aloud episodes</span></label>
          <select id="voice">${voiceOptions}</select></div>
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
      <div class="actions" style="margin-block-start: 0.75rem"><button class="btn quiet" type="button" id="addPasskey">Add a passkey</button></div>
      <p class="feedback" id="passkeyFeedback" role="status" aria-live="polite"></p>
    </section>
  </div>

  <section class="panel" aria-labelledby="episodes-h">
    <div class="section-title"><h2 id="episodes-h">Recent episodes</h2>${
    approved
      ? `<button class="btn quiet small" type="button" id="regenOutdated" data-count="${d.outdatedCount}"${
        d.outdatedCount ? "" : " disabled"
      }>Regenerate outdated (${d.outdatedCount})</button>`
      : ""
  }</div>
    <p class="sub">Regenerate re-narrates with the current prompts. The old audio stays in your feed until the new one is ready.</p>
    ${
    episodeItems
      ? `<ul class="rows">${episodeItems}</ul>`
      : `<p class="empty">Nothing yet. Send an article above and it appears here.</p>`
  }
    <p class="feedback" id="regenFeedback" role="status" aria-live="polite"></p>
  </section>

  <section class="panel danger-zone" aria-labelledby="rotate-h">
    <h2 id="rotate-h">Leaked your feed URL?</h2>
    <p class="sub">Rotating makes a new feed URL and stops the old one at once. Every podcast app you subscribed needs the new one.</p>
    <div class="actions"><button class="btn danger" type="button" id="rotateToken">Rotate feed URL</button></div>
    <p class="feedback" id="rotateFeedback" role="status" aria-live="polite"></p>
  </section>
</div>`;

  const script = `(() => {
  "use strict";
  const RP_ID = ${jsonForScript(d.rpId)};
  const USER_HANDLE = ${jsonForScript(base64url(new TextEncoder().encode(user.id)))};
  const CREDENTIAL_IDS = ${jsonForScript(d.credentials.map((c) => c.id))};
  const DISPLAY = ${jsonForScript({ name: user.email, displayName: user.displayName })};
  const PREFILL = ${jsonForScript(d.prefill ?? null)};
${PASSKEY_CLIENT}
  const $ = (id) => document.getElementById(id);
  const say = (el, tone, text) => { el.dataset.tone = tone; el.textContent = text; };

  if (PREFILL && PREFILL.url && $("sendUrl") && !$("sendUrl").value) {
    $("sendUrl").value = PREFILL.url;
  }

  const quickSingleBtn = $("quickSingleBtn");
  if (quickSingleBtn && PREFILL) {
    quickSingleBtn.addEventListener("click", async () => {
      const feedback = $("quickFeedback");
      const modeEl = document.querySelector("input[name=quickMode]:checked");
      const mode = modeEl ? modeEl.value : "direct";
      quickSingleBtn.disabled = true;
      say(feedback, "ok", "Queuing article for audio…");
      try {
        const res = await send("POST", "/api/ingest", { url: PREFILL.url, mode });
        const title = (res && res.article && res.article.title) || PREFILL.title || "Article";
        say(feedback, "ok", "Queued for synthesis: " + title + ". It will appear in your feed once ready.");
      } catch (err) {
        say(feedback, "error", String(err.message || err));
      } finally {
        quickSingleBtn.disabled = false;
      }
    });
  }

  const quickSubscribeBtn = $("quickSubscribeBtn");
  if (quickSubscribeBtn && PREFILL && PREFILL.feedUrl) {
    quickSubscribeBtn.addEventListener("click", async () => {
      const feedback = $("quickFeedback");
      quickSubscribeBtn.disabled = true;
      say(feedback, "ok", "Subscribing to feed…");
      try {
        const res = await send("POST", "/api/account/sources", {
          feedUrl: PREFILL.feedUrl,
          title: PREFILL.title || undefined,
          modes: ["direct", "deepdive"],
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
  async function send(method, path, body) {
    const res = await fetch(path, {
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

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1800);
    });
  }

  $("sendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = $("sendFeedback");
    const mode = document.querySelector("input[name=sendMode]:checked").value;
    say(feedback, "ok", "Fetching the article…");
    try {
      const res = await send("POST", "/api/ingest", { url: $("sendUrl").value.trim(), mode });
      say(feedback, "ok", "Queued: " + res.article.title + ". It appears in your feed once narrated.");
      $("sendUrl").value = "";
    } catch (error) {
      say(feedback, "error", String(error.message || error));
    }
  });

  $("profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = $("profileFeedback");
    try {
      const saved = await send("POST", "/api/account/profile", {
        displayName: $("displayName").value.trim(), voice: $("voice").value,
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

  $("addSourceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = $("addSourceFeedback");
    const modes = [...document.querySelectorAll("input[name=sourceMode]:checked")].map((i) => i.value);
    say(feedback, "ok", "Reading the feed…");
    try {
      const res = await send("POST", "/api/account/sources", {
        feedUrl: $("sourceUrl").value.trim(), title: $("sourceTitle").value.trim(), modes,
      });
      say(feedback, "ok", "Added " + res.source.title + ". " + res.poll.queued + " post(s) queued.");
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      say(feedback, "error", String(error.message || error));
    }
  });

  for (const button of document.querySelectorAll("[data-remove-source]")) {
    button.addEventListener("click", async () => {
      if (!confirm("Remove " + button.dataset.title + "? Episodes already made stay in your feed.")) return;
      button.disabled = true;
      try {
        await send("DELETE", "/api/account/sources/" + encodeURIComponent(button.dataset.removeSource));
        location.reload();
      } catch (error) {
        say($("sourcesFeedback"), "error", String(error.message || error));
        button.disabled = false;
      }
    });
  }

  // Regenerating is paid synthesis: every press confirms what it will spend.
  for (const button of document.querySelectorAll("[data-regenerate-episode]")) {
    button.addEventListener("click", async () => {
      if (!confirm("Regenerate " + button.dataset.title + "? This narrates it again (1 episode of synthesis).")) return;
      button.disabled = true;
      try {
        const res = await send("POST", "/api/account/episodes/" + encodeURIComponent(button.dataset.regenerateEpisode) + "/regenerate", {});
        say($("regenFeedback"), "ok", res.queued ? "Queued for regeneration." : "Already queued.");
        // Reload so the outdated count, and the spend its confirm states, stay true.
        setTimeout(() => location.reload(), 700);
      } catch (error) {
        say($("regenFeedback"), "error", String(error.message || error));
        button.disabled = false;
      }
    });
  }
  const regenOutdated = $("regenOutdated");
  if (regenOutdated) {
    regenOutdated.addEventListener("click", async () => {
      const count = Number(regenOutdated.dataset.count);
      if (!confirm("Regenerate " + count + " outdated episode(s)? Each one is narrated again, which is " + count + " episode(s) of synthesis.")) return;
      regenOutdated.disabled = true;
      try {
        const res = await send("POST", "/api/account/regenerate", {});
        say($("regenFeedback"), "ok", res.queued + " episode(s) queued for regeneration.");
      } catch (error) {
        say($("regenFeedback"), "error", String(error.message || error));
        regenOutdated.disabled = false;
      }
    });
  }

  $("rotateToken").addEventListener("click", async () => {
    if (!confirm("Make a new feed URL? The current one stops working in every podcast app straight away.")) return;
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
      if (!confirm("Remove this passkey? You won't be able to sign in with it again.")) return;
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
  const [sources, credentials, episodes, outdatedCount] = await Promise.all([
    store.listSources(user.id),
    store.listCredentials(user.id),
    store.listEpisodes({ userId: user.id, limit: 10 }),
    user.status === "approved" ? countOutdatedEpisodes(store, user.id) : 0,
  ]);

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

  const html = renderAccountPage({
    user,
    baseUrl,
    rpId: relyingParty(baseUrl).rpID,
    sources,
    credentials,
    episodes,
    outdatedCount,
    prefill,
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
