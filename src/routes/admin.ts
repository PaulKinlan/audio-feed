/**
 * Admin console at `GET /admin` (audio-feed-z2s).
 *
 * Paul asked how to create subscribers: every existing route was machine-facing
 * (feed XML, audio, a JSON API) or the public homepage, so making a user meant
 * hand-writing KV records or the CLI. This is the human surface for the admin
 * approval gate that PRODUCT.md describes as "strictly required before audio
 * generation is authorized", and for handing a subscriber their feed URL.
 *
 * Design notes, because several are deliberate:
 *
 * - ONE self-contained document, like src/routes/home.ts: no build step, no
 *   bundle, no external fetch. It reuses that page's design tokens verbatim
 *   (there is no shared stylesheet in this project — the tokens are duplicated
 *   between the two pages, which is the established pattern rather than a new
 *   one).
 * - The PAGE is public and holds no data. Every byte of subscriber data comes
 *   from `/api/admin/users*`, which is session-gated (or token-gated) server-side.
 *   Rendering the shell without a session reveals nothing, and prompts the visitor
 *   to sign in with a passkey.
 * - Admins sign in via passkey (audio-feed-8fc); the token-paste UI path is
 *   deleted (audio-feed-0jp). Session state travels in an HttpOnly secure cookie,
 *   with no credential stored in web storage. Break-glass admin calls (e.g. curl)
 *   continue to use the `x-admin-token` request header server-side.
 * - Subscriber-supplied text (email, display name) is inserted with
 *   `textContent`, never `innerHTML`. A stored-XSS payload in a display name
 *   would otherwise run in the admin's session and perform actions on their behalf.
 * - `feedToken` IS shown here, unlike in the approve response. The admin is the
 *   issuer: the token has to be handed to the subscriber somehow, and showing it
 *   once at creation is the only place that is true. The page is therefore
 *   `no-store` and never cached.
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { resolveOrigin } from "../origin.ts";
import { assetUrl } from "./assets.ts";
import { esc, jsonForScript } from "./html.ts";
import { CONFIRM_DIALOG_CLIENT, renderShell, type Viewer, viewerOf } from "./shell.ts";
import { isActiveAdmin, sessionUser } from "../auth/sessions.ts";
import { RUN_HISTORY_LIMIT } from "../storage/mod.ts";

export interface AdminPageOptions {
  /** Absolute origin, so the shown feed URL is the one that actually works. */
  publicBaseUrl: string;
  /** Whether ADMIN_TOKEN is configured: the break-glass path needs it. */
  adminConfigured: boolean;
  /** Whether configured ADMIN_TOKEN is short (< 16 chars). Warn-only advisory (audio-feed-bns). */
  adminTokenShort?: boolean;
  /**
   * The signed-in admin (audio-feed-8fc). Present means the console runs on the
   * session cookie and the token box is a fallback behind a toggle.
   */
  viewer?: Viewer | null;
}

export function renderAdminPage(
  { publicBaseUrl, adminConfigured, adminTokenShort = false, viewer = null }: AdminPageOptions,
): string {
  const signedIn = Boolean(viewer?.isAdmin);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Audio Feed</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📻</text></svg>">
</head>
<body>
<div class="admin-page">
  <h1>Audio Feed admin</h1>
  <p class="muted">
    Create subscribers, approve them, and hand out feed URLs. Subscribers cannot
    produce audio until they are approved — that gate is what keeps synthesis
    spend to people you have accepted.
  </p>

  ${
    adminConfigured || signedIn ? "" : `<div class="card" role="alert">
    <h2>Admin token not configured</h2>
    <p>
      This server has no <code class="mono">ADMIN_TOKEN</code> set, so every
      action here will be refused. Set it in the deployment environment and
      reload. This is deliberate: an unconfigured server must not have an open
      approval endpoint.
    </p>
  </div>`
  }

  ${
    signedIn && adminTokenShort
      ? `<div class="card" role="status" style="border-inline-start: 4px solid var(--accent); margin-block-end: var(--space-4);">
    <h2>Security Advisory: Short ADMIN_TOKEN</h2>
    <p>
      The configured <code class="mono">ADMIN_TOKEN</code> is shorter than 16 characters.
      A multi-word passphrase of at least 16 characters is recommended to prevent brute-force attacks.
    </p>
  </div>`
      : ""
  }

  <section class="card signin-card" aria-labelledby="auth-h">
    ${
    signedIn
      ? `<h2 id="auth-h">Signed in</h2>
    <p class="muted">You're signed in as <strong>${esc(viewer!.displayName)}</strong>
      (${esc(viewer!.email)}) with your passkey. Everything below runs on that session.</p>`
      : `<h2 id="auth-h">Sign in to administer</h2>
    <p class="muted">Admins sign in with a passkey, like everyone else.</p>
    <div class="row"><a class="primary" href="/login?next=%2Fadmin">Sign in with a passkey</a></div>
    <p class="muted" style="margin-block-start: var(--space-3); font-size: 0.88rem;">
      Need to enroll with your admin token? <a href="/login?next=%2Fadmin#bootstrap">Bootstrap passkey</a>
    </p>`
  }
  </section>

  <section class="card" aria-labelledby="stats-h">
    <div class="card-head">
      <h2 id="stats-h">Operations</h2>
      <button type="button" id="refreshStats" class="secondary" disabled>Refresh</button>
    </div>

    <dl class="stats-grid">
      <div class="stat">
        <dt>Downloads / redirects</dt>
        <dd id="statDownloads">—</dd>
        <p class="stat-note">Whole-file requests. Range and HEAD probes excluded.</p>
      </div>
      <div class="stat">
        <dt>Last feed poll</dt>
        <dd id="statLastPoll">—</dd>
        <p class="stat-note">Cron runs every 15 minutes.</p>
      </div>
      <div class="stat">
        <dt>Avg poll time</dt>
        <dd id="statPollDuration">—</dd>
        <p class="stat-note" id="statPollNote">Mean of recent polls.</p>
      </div>
      <div class="stat">
        <dt>Runs recorded</dt>
        <dd id="statRuns">—</dd>
        <p class="stat-note">Newest ${RUN_HISTORY_LIMIT} of each job kept.</p>
      </div>
      <div class="stat">
        <dt>Episodes synthesised</dt>
        <dd id="statSynthesis">—</dd>
        <p class="stat-note">Total generated audio (audio-feed-9mp).</p>
      </div>
    </dl>

    <h3>Background runs</h3>
    <div class="table-wrap">
      <table class="runs">
        <caption id="runsCaption">Not loaded.</caption>
        <thead>
          <tr><th>When</th><th>Job</th><th>Started by</th><th>Took</th><th>Result</th></tr>
        </thead>
        <tbody id="runsBody"></tbody>
      </table>
    </div>

    <h3>Downloads by subscriber</h3>
    <div class="table-wrap">
      <table>
        <caption id="downloadsCaption">Not loaded.</caption>
        <thead><tr><th>Subscriber</th><th>Requests</th></tr></thead>
        <tbody id="downloadsBody"></tbody>
      </table>
    </div>

    <h3>Synthesis by subscriber</h3>
    <div class="table-wrap">
      <table>
        <caption id="synthesisCaption">Not loaded.</caption>
        <thead><tr><th>Subscriber</th><th>Episodes</th><th>Audio generated</th><th>Today</th></tr></thead>
        <tbody id="synthesisBody"></tbody>
      </table>
    </div>
    <p class="feedback" id="statsFeedback" role="status" aria-live="polite"></p>
  </section>

  <section class="card" aria-labelledby="create-h">
    <h2 id="create-h">2. Create a subscriber</h2>
    <form id="createForm" novalidate>
      <div class="field">
        <label for="email">Email
          <span class="hint">Also the sign-in identity for the subscriber.</span>
        </label>
        <input id="email" name="email" type="email" required autocomplete="off"
               aria-describedby="createFeedback" />
      </div>
      <div class="field">
        <label for="displayName">Display name
          <span class="hint">Shown as the podcast title, e.g. "Paul's Audio Feed".</span>
        </label>
        <input id="displayName" name="displayName" type="text" class="field-auto" autocomplete="off" />
      </div>
      <div class="field">
        <label for="feedUrl">Initial RSS feed URL (optional)
          <span class="hint">Subscribes the new user immediately and queues recent posts.</span>
        </label>
        <input id="feedUrl" name="feedUrl" type="url" placeholder="https://example.com/feed.xml" autocomplete="off" />
      </div>
      <div class="field">
        <label for="newFeedCodeHandling">Code handling
          <span class="hint">How to handle code blocks in speech (audio-feed-bdo).</span>
        </label>
        <select id="newFeedCodeHandling">
          <option value="skip" selected>Skip code blocks (never read aloud)</option>
          <option value="explain">Summarize / explain code</option>
        </select>
      </div>
      <div class="field">
        <label for="newDailyBudget">Daily episode budget (optional)
          <span class="hint">Ceiling on synthesized episodes per UTC day. Blank for unlimited (audio-feed-9mp).</span>
        </label>
        <input id="newDailyBudget" name="dailyBudget" type="number" min="0" class="field-auto" placeholder="Unlimited" autocomplete="off" />
      </div>
      <div class="check">
        <input type="checkbox" id="newIsAdmin" />
        <label for="newIsAdmin">Make this person an admin
          <span class="hint">They can then sign in here and manage everyone.</span>
        </label>
      </div>
      <div class="row">
        <button type="submit" id="createUser">Create and approve</button>
      </div>
      <p class="feedback" id="createFeedback" role="status" aria-live="polite"></p>
    </form>
    <div id="created" hidden></div>
  </section>

  <section class="card" aria-labelledby="users-h">
    <div class="card-head">
      <h2 id="users-h">3. Subscribers</h2>
      <button type="button" id="loadUsers" class="secondary" disabled>Load subscribers</button>
    </div>
    <p class="muted" id="users-help">
      Approve to let a subscriber generate audio; suspend to stop it immediately.
      A suspended subscriber's feed stops serving as well.
    </p>
    <div class="table-wrap">
      <table aria-describedby="users-help">
        <caption id="usersCaption">No subscribers loaded yet.</caption>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody id="usersBody"></tbody>
      </table>
    </div>
    <p class="feedback" id="usersFeedback" role="status" aria-live="polite"></p>
    <div id="setupLinkBox" class="created" hidden>
      <label for="setupLinkUrl"><strong>Setup link</strong>
        <span class="hint" id="setupLinkNote"></span>
      </label>
      <div class="copy-row">
        <input type="text" id="setupLinkUrl" readonly />
        <button type="button" id="copySetupLink">Copy link</button>
      </div>
    </div>
  </section>

  <section class="card" aria-labelledby="triggers-h">
    <h2 id="triggers-h">Background tasks &amp; triggers</h2>
    <p class="muted" id="triggers-help">
      Feeds and synthesis are scheduled on Deno Deploy via native <code class="mono">Deno.cron</code>
      (feeds every 15 min; synthesis every 2 min). Trigger an immediate batch run on demand below.
    </p>
    <div class="row">
      <button type="button" id="pollNowBtn" class="secondary" disabled>Poll Feeds Now</button>
      <button type="button" id="synthesizeNowBtn" class="secondary" disabled>Synthesize Queue Now</button>
    </div>
    <p class="feedback" id="triggersFeedback" role="status" aria-live="polite"></p>
  </section>

  <section class="card" id="manageSection" aria-labelledby="manage-h" hidden>
    <div class="row" style="justify-content: space-between; align-items: center;">
      <h2 id="manage-h" style="margin: 0;">4. Manage subscriber: <span id="manageName"></span></h2>
      <button type="button" id="closeManage" class="secondary">Close</button>
    </div>
    <div class="created" style="margin-block-start: var(--space-4);">
      <dl id="manageDetails"></dl>
      <div class="copy-row">
        <input type="text" id="manageFeedUrl" readonly aria-label="Subscriber master feed URL" />
        <button type="button" id="copyManageFeedUrl">Copy feed URL</button>
        <button type="button" id="rotateManageToken" class="danger">Rotate token</button>
      </div>
      <p class="muted" id="rotateHelp" style="margin-block-start: var(--space-2); margin-block-end: 0; font-size: 0.8rem;">
        Rotating the feed token revokes the old URL immediately.
      </p>
    </div>

    <h3 style="margin-block-start: var(--space-6); margin-block-end: var(--space-2);">Subscribed RSS feeds</h3>
    <div class="table-wrap">
      <table aria-describedby="manageSourcesHelp">
        <caption id="manageSourcesCaption">Loading feeds…</caption>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Feed URL</th>
            <th scope="col">Mode</th>
            <th scope="col">Code</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody id="manageSourcesBody"></tbody>
      </table>
    </div>
    <p class="feedback" id="manageSourcesFeedback" role="status" aria-live="polite"></p>

    <h3 style="margin-block-start: var(--space-6); margin-block-end: var(--space-2);">Episodes</h3>
    <p class="muted" id="manageEpisodesHelp">
      Regenerate re-synthesises audio with the current TTS prompts. Each episode is a billed
      TTS call. The old audio keeps playing until the new audio is ready.
    </p>
    <div class="row">
      <button type="button" id="regenOutdated" class="secondary" disabled>Regenerate outdated (0)</button>
      <button type="button" id="regenFailed" class="secondary" disabled>Retry failed (0)</button>
      <button type="button" id="regenAll" class="secondary" disabled>Regenerate all (0)</button>
    </div>
    <div class="table-wrap">
      <table aria-describedby="manageEpisodesHelp">
        <caption id="manageEpisodesCaption">Loading episodes…</caption>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Mode</th>
            <th scope="col">Status</th>
            <th scope="col">Prompts</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody id="manageEpisodesBody"></tbody>
      </table>
    </div>
    <p class="feedback" id="manageEpisodesFeedback" role="status" aria-live="polite"></p>

    <h3 style="margin-block-start: var(--space-6); margin-block-end: var(--space-2);">Add feed to subscriber</h3>
    <form id="addSourceForm" novalidate>
      <div class="field">
        <label for="subFeedUrl">RSS or Atom feed URL</label>
        <input id="subFeedUrl" type="url" required placeholder="https://example.com/feed.xml" autocomplete="off" />
      </div>
      <div class="field">
        <label for="subFeedTitle">Feed title (optional)</label>
        <input id="subFeedTitle" type="text" placeholder="Defaults to title in feed" autocomplete="off" />
      </div>
      <div class="field">
        <label for="subFeedMode">Audio mode</label>
        <select id="subFeedMode">
          <option value="direct" selected>Direct read (one voice)</option>
          <option value="deepdive">Deep dive (two voices)</option>
        </select>
      </div>
      <div class="field">
        <label for="subFeedCodeHandling">Code handling</label>
        <select id="subFeedCodeHandling">
          <option value="skip" selected>Skip code blocks (never read aloud)</option>
          <option value="explain">Summarize / explain code</option>
        </select>
      </div>
      <div class="row">
        <button type="submit" id="submitAddSource">Add feed</button>
      </div>
      <p class="feedback" id="addSourceFeedback" role="status" aria-live="polite"></p>
    </form>
  </section>
</div>

<script>
(() => {
  "use strict";
${CONFIRM_DIALOG_CLIENT}
  // ── Session identity, the admin token, and the API wrapper ───────────────
  const ORIGIN = ${jsonForScript(publicBaseUrl)};
  // audio-feed-8fc: a signed-in admin's requests carry the session cookie.
  const SIGNED_IN = ${signedIn ? "true" : "false"};
  const usersFeedback = document.getElementById("usersFeedback");
  const usersBody = document.getElementById("usersBody");
  const usersCaption = document.getElementById("usersCaption");
  const created = document.getElementById("created");
  const loadUsersBtn = document.getElementById("loadUsers");
  const createForm = document.getElementById("createForm");
  const pollNowBtn = document.getElementById("pollNowBtn");
  const synthesizeNowBtn = document.getElementById("synthesizeNowBtn");
  const triggersFeedback = document.getElementById("triggersFeedback");
  const refreshStatsBtn = document.getElementById("refreshStats");
  const statDownloads = document.getElementById("statDownloads");
  const statLastPoll = document.getElementById("statLastPoll");
  const statPollDuration = document.getElementById("statPollDuration");
  const statPollNote = document.getElementById("statPollNote");
  const statRuns = document.getElementById("statRuns");
  const statSynthesis = document.getElementById("statSynthesis");
  const runsBody = document.getElementById("runsBody");
  const runsCaption = document.getElementById("runsCaption");
  const downloadsBody = document.getElementById("downloadsBody");
  const downloadsCaption = document.getElementById("downloadsCaption");
  const synthesisBody = document.getElementById("synthesisBody");
  const synthesisCaption = document.getElementById("synthesisCaption");
  const statsFeedback = document.getElementById("statsFeedback");

  const say = (el, tone, message) => {
    el.dataset.tone = tone;
    el.textContent = message;
  };

  function fmtBytes(b) {
    if (!b || b <= 0) return "0 B";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  function enableActions() {
    loadUsersBtn.disabled = false;
    if (pollNowBtn) pollNowBtn.disabled = false;
    if (synthesizeNowBtn) synthesizeNowBtn.disabled = false;
    if (refreshStatsBtn) refreshStatsBtn.disabled = false;
  }

  function authorized() {
    return SIGNED_IN;
  }

  if (SIGNED_IN) {
    enableActions();
    loadUsers();
    loadStats();
  } else {
    loadUsersBtn.disabled = true;
    if (pollNowBtn) pollNowBtn.disabled = true;
    if (synthesizeNowBtn) synthesizeNowBtn.disabled = true;
    if (refreshStatsBtn) refreshStatsBtn.disabled = true;
  }

  /** Every admin call goes through here, carrying session cookie auth. */
  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail = body && (body.error || body.message);
      throw new Error(detail || ("Request failed (" + response.status + ")"));
    }
    return body;
  }

  // ── Trigger a poll or a synthesis pass now ───────────────────────────────
  pollNowBtn?.addEventListener("click", async () => {
    pollNowBtn.disabled = true;
    say(triggersFeedback, "ok", "Polling due feeds…");
    try {
      const res = await api("/api/admin/poll-now", { method: "POST" });
      say(
        triggersFeedback,
        "ok",
        "Polled " + res.polled + " feeds: " + res.queued + " queued, " + res.failed + " failed.",
      );
    } catch (error) {
      say(triggersFeedback, "error", String(error.message || error));
    } finally {
      pollNowBtn.disabled = false;
    }
  });

  synthesizeNowBtn?.addEventListener("click", async () => {
    synthesizeNowBtn.disabled = true;
    say(triggersFeedback, "ok", "Processing synthesis queue…");
    try {
      const res = await api("/api/admin/synthesize-now", { method: "POST" });
      say(
        triggersFeedback,
        "ok",
        "Synthesis batch: " + res.ready + " ready, " + res.failed + " failed, " + res.deferred + " deferred.",
      );
    } catch (error) {
      say(triggersFeedback, "error", String(error.message || error));
    } finally {
      synthesizeNowBtn.disabled = false;
    }
  });

  // ── User rows: cells, the actions a row takes, and what they report ──────
  function cell(text, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    // textContent, never innerHTML: a display name is subscriber-supplied text and
    // this document holds the admin token.
    td.textContent = text;
    return td;
  }

  function statusCell(status) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.className = "status";
    span.dataset.status = status;
    span.textContent = status;
    td.appendChild(span);
    return td;
  }

  async function act(userId, action, button) {
    button.disabled = true;
    try {
      await api("/api/admin/users/" + encodeURIComponent(userId) + "/" + action, { method: "POST" });
      say(usersFeedback, "ok", "User " + action + "d.");
      await loadUsers();
    } catch (error) {
      say(usersFeedback, "error", String(error.message || error));
      button.disabled = false;
    }
  }

  const setupLinkBox = document.getElementById("setupLinkBox");
  const setupLinkUrl = document.getElementById("setupLinkUrl");
  const setupLinkNote = document.getElementById("setupLinkNote");

  /** One-time passkey setup link. Shown once; the server keeps only its hash. */
  async function issueSetupLink(user, button) {
    button.disabled = true;
    try {
      const res = await api("/api/admin/users/" + encodeURIComponent(user.id) + "/setup-link", {
        method: "POST",
      });
      setupLinkUrl.value = res.url;
      setupLinkNote.textContent = "For " + user.email + ". Works once, until " +
        new Date(res.expiresAt).toLocaleDateString() + ". Send it privately.";
      setupLinkBox.hidden = false;
      setupLinkUrl.focus();
      setupLinkUrl.select();
      say(usersFeedback, "ok", "Setup link ready for " + user.email + ".");
    } catch (error) {
      say(usersFeedback, "error", String(error.message || error));
    } finally {
      button.disabled = false;
    }
  }

  document.getElementById("copySetupLink").addEventListener("click", async () => {
    await navigator.clipboard.writeText(setupLinkUrl.value);
    say(usersFeedback, "ok", "Setup link copied.");
  });

  async function setRole(user, isAdmin, button) {
    if (!isAdmin) {
      const ok = await askConfirm("Remove admin access from " + user.email + "?", {
        title: "Revoke Admin Access",
        confirmText: "Revoke",
      });
      if (!ok) return;
    }
    button.disabled = true;
    try {
      await api("/api/admin/users/" + encodeURIComponent(user.id) + "/role", {
        method: "POST",
        body: JSON.stringify({ isAdmin }),
      });
      say(usersFeedback, "ok", user.email + (isAdmin ? " is now an admin." : " is no longer an admin."));
      await loadUsers();
    } catch (error) {
      say(usersFeedback, "error", String(error.message || error));
    } finally {
      button.disabled = false;
    }
  }

  function row(user) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(user.email));
    tr.appendChild(cell(user.displayName || "—"));
    tr.appendChild(statusCell(user.status));

    const actions = document.createElement("td");
    actions.className = "actions";

    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "secondary";
    manage.textContent = "Manage";
    manage.setAttribute("aria-label", "Manage " + user.email);
    manage.addEventListener("click", () => openManage(user));
    actions.appendChild(manage);

    if (user.status !== "approved") {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "Approve";
      approve.setAttribute("aria-label", "Approve " + user.email);
      approve.addEventListener("click", () => act(user.id, "approve", approve));
      actions.appendChild(approve);
    }
    if (user.status !== "suspended") {
      const suspend = document.createElement("button");
      suspend.type = "button";
      suspend.className = "danger";
      suspend.textContent = "Suspend";
      suspend.setAttribute("aria-label", "Suspend " + user.email);
      suspend.addEventListener("click", () => act(user.id, "suspend", suspend));
      actions.appendChild(suspend);
    }

    // audio-feed-8fc: enrolment/recovery links and admin rights.
    const setup = document.createElement("button");
    setup.type = "button";
    setup.className = "secondary";
    setup.textContent = "Setup link";
    setup.setAttribute("aria-label", "Setup link for " + user.email);
    setup.addEventListener("click", () => issueSetupLink(user, setup));
    actions.appendChild(setup);

    const role = document.createElement("button");
    role.type = "button";
    role.className = "secondary";
    role.textContent = user.isAdmin ? "Remove admin" : "Make admin";
    role.setAttribute("aria-label", role.textContent + ": " + user.email);
    role.addEventListener("click", () => setRole(user, !user.isAdmin, role));
    actions.appendChild(role);
    tr.appendChild(actions);
    return tr;
  }

  /** Relative time, because "4 minutes ago" answers "is cron alive?" and a timestamp does not. */
  // ── Runs and stats ───────────────────────────────────────────────────────
  function ago(iso) {
    if (!iso) return "never";
    // audio-feed-ap45: replace manual millisecond math with Temporal.Duration
    // TODO(baseline/temporal): drop Date fallback when Temporal reaches Baseline
    if (typeof Temporal !== "undefined") {
      try {
        const now = Temporal.Now.instant();
        const then = Temporal.Instant.from(iso);
        const duration = now.since(then);
        const s = Math.round(duration.total({ unit: "seconds" }));
        if (s < 60) return s + "s ago";
        const m = Math.round(duration.total({ unit: "minutes" }));
        if (m < 60) return m + "m ago";
        const h = Math.round(duration.total({ unit: "hours" }));
        if (h < 48) return h + "h ago";
        const d = Math.round(h / 24);
        return d + "d ago";
      } catch {
        // fallback to Date
      }
    }
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return "unknown";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 48) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  function runRow(run) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(ago(run.startedAt)));
    tr.appendChild(cell(run.kind === "feed-poll" ? "Feed poll" : "Synthesis"));
    tr.appendChild(cell(run.trigger));
    tr.appendChild(cell(run.durationMs + "ms"));

    const resultTd = document.createElement("td");
    if (run.error) {
      resultTd.className = "error-text";
      resultTd.textContent = "failed: " + run.error;
    } else {
      const summaryText = run.kind === "feed-poll"
        ? (run.polled ?? 0) + " polled, " + (run.queued ?? 0) + " queued, " + (run.failed ?? 0) +
          " failed"
        : (run.ready ?? 0) + " ready, " + (run.failed ?? 0) + " failed, " + (run.deferred ?? 0) +
          " deferred";

      if (run.failed && run.failed > 0 && Array.isArray(run.errors) && run.errors.length > 0) {
        const details = document.createElement("details");
        details.className = "run-errors";
        const summary = document.createElement("summary");
        summary.className = "error-text";
        summary.textContent = summaryText + " (view log)";
        details.appendChild(summary);
        const ul = document.createElement("ul");
        ul.className = "run-errors-list";
        for (const err of run.errors) {
          const li = document.createElement("li");
          li.textContent = err;
          ul.appendChild(li);
        }
        details.appendChild(ul);
        resultTd.appendChild(details);
      } else {
        resultTd.textContent = summaryText;
      }
    }
    tr.appendChild(resultTd);
    return tr;
  }

  async function loadStats() {
    if (!authorized()) return;
    if (refreshStatsBtn) refreshStatsBtn.disabled = true;
    try {
      const s = await api("/api/admin/stats");
      statDownloads.textContent = String(s.downloads.total);
      statLastPoll.textContent = ago(s.feedProcessing.lastPolledAt);
      statPollDuration.textContent = s.feedProcessing.averageDurationMs === null
        ? "—"
        : s.feedProcessing.averageDurationMs + "ms";
      // Say how many polls the mean covers. "The last 10" is only true once ten
      // polls have run (audio-feed-ct1).
      const polls = s.feedProcessing.sampleSize;
      statPollNote.textContent = polls === 0
        ? "No polls recorded yet."
        : "Mean of the last " + polls + " poll" + (polls === 1 ? "" : "s") + ".";
      statRuns.textContent = String(s.runs.length);

      // The newest 10 of EACH job, merged by time. Synthesis ticks every 2
      // minutes and the poll every 15, so the newest 20 overall were almost all
      // idle synthesis ticks (audio-feed-ct1). s.runs is already newest first.
      const perJob = new Map();
      const shown = s.runs.filter((run) => {
        const seen = perJob.get(run.kind) || 0;
        perJob.set(run.kind, seen + 1);
        return seen < 10;
      });
      runsBody.replaceChildren();
      for (const run of shown) runsBody.appendChild(runRow(run));
      runsCaption.textContent = s.runs.length === 0
        ? "No background runs recorded yet."
        : "Showing the newest 10 of each job: " + shown.length + " of " + s.runs.length +
          " runs kept.";

      downloadsBody.replaceChildren();
      for (const d of s.downloads.perUser.slice(0, 20)) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(d.email || d.userId, d.email ? undefined : "mono"));
        tr.appendChild(cell(String(d.count)));
        downloadsBody.appendChild(tr);
      }
      downloadsCaption.textContent = s.downloads.perUser.length === 0
        ? "No enclosure requests recorded yet."
        : s.downloads.perUser.length + " subscriber" +
          (s.downloads.perUser.length === 1 ? "" : "s") + " with requests.";

      if (s.synthesis && synthesisBody) {
        if (statSynthesis) statSynthesis.textContent = String(s.synthesis.total);
        synthesisBody.replaceChildren();
        for (const u of s.synthesis.perUser.slice(0, 20)) {
          const tr = document.createElement("tr");
          tr.appendChild(cell(u.email || u.userId, u.email ? undefined : "mono"));
          tr.appendChild(cell(String(u.count)));
          tr.appendChild(cell(fmtBytes(u.bytes)));
          tr.appendChild(cell(String(u.todayCount)));
          synthesisBody.appendChild(tr);
        }
        if (synthesisCaption) {
          synthesisCaption.textContent = s.synthesis.perUser.length === 0
            ? "No synthesis recorded yet."
            : s.synthesis.perUser.length + " subscriber" +
              (s.synthesis.perUser.length === 1 ? "" : "s") + " with synthesis.";
        }
      }

      say(statsFeedback, "ok", "Updated " + new Date().toLocaleTimeString() + ".");
    } catch (error) {
      say(statsFeedback, "error", String(error.message || error));
    } finally {
      if (refreshStatsBtn) refreshStatsBtn.disabled = false;
    }
  }

  refreshStatsBtn?.addEventListener("click", loadStats);

  // ── Users: the list, the create form, and the one-time link it shows ─────
  async function loadUsers() {
    if (!authorized()) return;
    loadUsersBtn.disabled = true;
    try {
      const body = await api("/api/admin/users");
      const users = (body && body.users) || [];
      usersBody.replaceChildren();
      for (const user of users) usersBody.appendChild(row(user));
      usersCaption.textContent = users.length === 0
        ? "No subscribers yet."
        : users.length + " subscriber" + (users.length === 1 ? "" : "s") + ".";
      say(usersFeedback, "ok", "Loaded " + users.length + ".");
    } catch (error) {
      say(usersFeedback, "error", String(error.message || error));
    } finally {
      loadUsersBtn.disabled = false;
    }
  }

  loadUsersBtn.addEventListener("click", loadUsers);

  function definition(label, value, className) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (className) dd.className = className;
    dd.textContent = value;
    return [dt, dd];
  }

  /** Shows the new subscriber's feed URL once, with a copy control. */
  function showCreated(user) {
    const feedUrl = ORIGIN.replace(/\\/+$/, "") + "/feed/" + encodeURIComponent(user.feedToken) + "/master.xml";
    created.replaceChildren();
    const h3 = document.createElement("h3");
    h3.textContent = "Subscriber created";
    created.appendChild(h3);

    const dl = document.createElement("dl");
    const listItems = [
      ["Email", user.email],
      ["Display name", user.displayName || "—"],
      ["Status", user.status],
      ["User ID", user.id, "mono"],
      ["Feed token", user.feedToken, "mono"],
    ];
    if (user.initialSource) {
      listItems.push([
        "Initial feed",
        user.initialSource.title + " (" + user.initialSource.queued + " queued)",
      ]);
    }
    if (user.dailyEpisodeBudget !== undefined) {
      listItems.push(["Daily budget", String(user.dailyEpisodeBudget) + " episodes/day"]);
    }
    for (const [label, value, cls] of listItems) {
      const [dt, dd] = definition(label, value, cls);
      dl.append(dt, dd);
    }
    created.appendChild(dl);

    const copyRow = document.createElement("div");
    copyRow.className = "copy-row";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.readOnly = true;
    urlInput.value = feedUrl;
    urlInput.setAttribute("aria-label", "Master feed URL");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy feed URL";
    copy.addEventListener("click", async () => {
      urlInput.select();
      try {
        await navigator.clipboard.writeText(feedUrl);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Press Ctrl/Cmd+C";
      }
    });
    copyRow.append(urlInput, copy);
    created.appendChild(copyRow);

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent =
      "Send this URL to the subscriber. It contains their feed token, which is the only credential a podcast client can use — treat it as a secret, and expect it in every poll from now on.";
    created.appendChild(note);

    created.hidden = false;
    copy.focus();
  }

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = document.getElementById("createFeedback");
    const email = document.getElementById("email").value.trim();
    const displayName = document.getElementById("displayName").value.trim();
    const feedUrl = document.getElementById("feedUrl").value.trim();
    if (!email) {
      say(feedback, "error", "An email address is required.");
      document.getElementById("email").focus();
      return;
    }
    const submit = document.getElementById("createUser");
    const newCodeSelect = document.getElementById("newFeedCodeHandling");
    const codeHandling = newCodeSelect ? newCodeSelect.value : "skip";
    const budgetInput = document.getElementById("newDailyBudget");
    const budgetVal = budgetInput ? budgetInput.value.trim() : "";
    const dailyEpisodeBudget = budgetVal !== "" && Number.isFinite(Number(budgetVal))
      ? Number(budgetVal)
      : undefined;
    submit.disabled = true;
    try {
      const user = await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email,
          displayName: displayName || undefined,
          feedUrl: feedUrl || undefined,
          isAdmin: document.getElementById("newIsAdmin").checked || undefined,
          codeHandling: feedUrl ? codeHandling : undefined,
          dailyEpisodeBudget,
        }),
      });
      say(
        feedback,
        "ok",
        "Created and approved " + user.email +
          (user.initialSource ? (" with feed " + user.initialSource.title) : "") +
          ".",
      );
      showCreated(user);
      createForm.reset();
      await loadUsers();
    } catch (error) {
      say(feedback, "error", String(error.message || error));
    } finally {
      submit.disabled = false;
    }
  });

  // ── Subscriber management: sources, feed URL and token rotation (audio-feed-e3n) 
  let currentManagingUser = null;
  const manageSection = document.getElementById("manageSection");
  const manageName = document.getElementById("manageName");
  const manageDetails = document.getElementById("manageDetails");
  const manageFeedUrl = document.getElementById("manageFeedUrl");
  const copyManageFeedUrl = document.getElementById("copyManageFeedUrl");
  const rotateManageToken = document.getElementById("rotateManageToken");
  const manageSourcesBody = document.getElementById("manageSourcesBody");
  const manageSourcesCaption = document.getElementById("manageSourcesCaption");
  const manageSourcesFeedback = document.getElementById("manageSourcesFeedback");
  const addSourceForm = document.getElementById("addSourceForm");
  const addSourceFeedback = document.getElementById("addSourceFeedback");
  const submitAddSource = document.getElementById("submitAddSource");
  const closeManage = document.getElementById("closeManage");

  closeManage.addEventListener("click", () => {
    manageSection.hidden = true;
    currentManagingUser = null;
  });

  copyManageFeedUrl.addEventListener("click", async () => {
    manageFeedUrl.select();
    try {
      await navigator.clipboard.writeText(manageFeedUrl.value);
      copyManageFeedUrl.textContent = "Copied";
      setTimeout(() => (copyManageFeedUrl.textContent = "Copy feed URL"), 2000);
    } catch {
      copyManageFeedUrl.textContent = "Press Ctrl/Cmd+C";
    }
  });

  rotateManageToken.addEventListener("click", async () => {
    if (!currentManagingUser) return;
    const ok = await askConfirm(
      "Are you sure you want to rotate this subscriber's feed token? All existing podcast app subscriptions will stop working.",
      {
        title: "Rotate Feed Token",
        confirmText: "Rotate Token",
      },
    );
    if (!ok) {
      return;
    }
    rotateManageToken.disabled = true;
    try {
      const res = await api(
        "/api/admin/users/" + encodeURIComponent(currentManagingUser.id) + "/rotate-token",
        { method: "POST" },
      );
      currentManagingUser.feedToken = res.feedToken;
      const newFeedUrl = ORIGIN.replace(/\\/+$/, "") + "/feed/" +
        encodeURIComponent(res.feedToken) + "/master.xml";
      manageFeedUrl.value = newFeedUrl;
      renderManageDetails(currentManagingUser);
      say(manageSourcesFeedback, "ok", "Feed token rotated successfully. Old URL revoked.");
    } catch (error) {
      say(manageSourcesFeedback, "error", String(error.message || error));
    } finally {
      rotateManageToken.disabled = false;
    }
  });

  function renderManageDetails(user) {
    manageDetails.replaceChildren();
    for (const [label, value, cls] of [
      ["Email", user.email],
      ["Display name", user.displayName || "—"],
      ["Status", user.status],
      ["Daily budget", user.dailyEpisodeBudget !== undefined ? String(user.dailyEpisodeBudget) + " episodes/day" : "Unlimited"],
      ["User ID", user.id, "mono"],
      ["Feed token", user.feedToken || "—", "mono"],
    ]) {
      const [dt, dd] = definition(label, value, cls);
      manageDetails.append(dt, dd);
    }
  }

  async function loadManageSources(userId) {
    manageSourcesBody.replaceChildren();
    manageSourcesCaption.textContent = "Loading feeds…";
    try {
      const res = await api("/api/admin/users/" + encodeURIComponent(userId) + "/sources");
      if (res && res.feedToken && currentManagingUser && currentManagingUser.id === userId) {
        currentManagingUser.feedToken = res.feedToken;
        renderManageDetails(currentManagingUser);
        const feedUrl = ORIGIN.replace(/\\/+$/, "") + "/feed/" +
          encodeURIComponent(res.feedToken) + "/master.xml";
        manageFeedUrl.value = feedUrl;
      }
      const sources = res.sources || [];
      manageSourcesBody.replaceChildren();
      for (const source of sources) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(source.title || "—"));
        const tdUrl = document.createElement("td");
        tdUrl.className = "mono";
        tdUrl.textContent = source.feedUrl || "—";
        tr.appendChild(tdUrl);
        tr.appendChild(cell((source.modes || []).join(", ")));
        tr.appendChild(cell(source.codeHandling || "skip"));

        const tdStatus = document.createElement("td");
        if (source.lastPollError) {
          const span = document.createElement("span");
          span.className = "status";
          span.dataset.status = "suspended";
          span.textContent = "Error";
          tdStatus.appendChild(span);
          const errText = document.createElement("div");
          errText.className = "error-detail";
          errText.textContent = source.lastPollError;
          tdStatus.appendChild(errText);
        } else if (source.lastPolledAt) {
          const span = document.createElement("span");
          span.className = "status";
          span.dataset.status = "approved";
          span.textContent = "OK";
          tdStatus.appendChild(span);
        } else {
          const span = document.createElement("span");
          span.className = "status";
          span.dataset.status = "pending";
          span.textContent = "Pending";
          tdStatus.appendChild(span);
        }
        tr.appendChild(tdStatus);

        const tdActions = document.createElement("td");
        tdActions.className = "actions";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger";
        delBtn.textContent = "Remove";
        delBtn.setAttribute("aria-label", "Remove feed " + source.title);
        delBtn.addEventListener("click", async () => {
          const ok = await askConfirm("Remove feed subscription \\"" + source.title + "\\"?", {
            title: "Remove Feed Subscription",
            confirmText: "Remove",
          });
          if (!ok) return;
          delBtn.disabled = true;
          try {
            const res = await api(
              "/api/admin/users/" + encodeURIComponent(userId) + "/sources/" +
                encodeURIComponent(source.id),
              { method: "DELETE" },
            );
            const msg = res && res.cancelledPending > 0
              ? "Removed feed: " + source.title + " (" + res.cancelledPending + " pending cancelled, " + res.retainedEpisodes + " retained)"
              : "Removed feed: " + source.title;
            say(manageSourcesFeedback, "ok", msg);
            await loadManageSources(userId);
          } catch (error) {
            say(manageSourcesFeedback, "error", String(error.message || error));
            delBtn.disabled = false;
          }
        });
        tdActions.appendChild(delBtn);
        tr.appendChild(tdActions);
        manageSourcesBody.appendChild(tr);
      }
      manageSourcesCaption.textContent = sources.length === 0
        ? "No feeds subscribed yet."
        : sources.length + " feed" + (sources.length === 1 ? "" : "s") + " subscribed.";
    } catch (error) {
      say(manageSourcesFeedback, "error", String(error.message || error));
    }
  }

  // ── Regenerate: one episode, or the whole feed (audio-feed-8oz, audio-feed-6y9) ───
  const manageEpisodesBody = document.getElementById("manageEpisodesBody");
  const manageEpisodesCaption = document.getElementById("manageEpisodesCaption");
  const manageEpisodesFeedback = document.getElementById("manageEpisodesFeedback");
  const regenOutdated = document.getElementById("regenOutdated");
  const regenFailed = document.getElementById("regenFailed");
  const regenAll = document.getElementById("regenAll");
  let regenCounts = { outdated: 0, all: 0, failed: 0 };

  function plural(n) {
    return n + " episode" + (n === 1 ? "" : "s");
  }

  async function loadManageEpisodes(userId) {
    manageEpisodesBody.replaceChildren();
    manageEpisodesCaption.textContent = "Loading episodes…";
    try {
      const res = await api("/api/admin/users/" + encodeURIComponent(userId) + "/episodes");
      regenCounts = (res && res.counts) || { outdated: 0, all: 0, failed: 0 };
      regenOutdated.textContent = "Regenerate outdated (" + (regenCounts.outdated || 0) + ")";
      if (regenFailed) {
        regenFailed.textContent = "Retry failed (" + (regenCounts.failed || 0) + ")";
        regenFailed.disabled = !regenCounts.failed;
      }
      regenAll.textContent = "Regenerate all (" + (regenCounts.all || 0) + ")";
      regenOutdated.disabled = !regenCounts.outdated;
      regenAll.disabled = !regenCounts.all;
      const episodes = (res && res.episodes) || [];
      manageEpisodesBody.replaceChildren();
      for (const episode of episodes) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(episode.title || "—"));
        tr.appendChild(cell(episode.mode || "—"));

        const statusTd = document.createElement("td");
        if (episode.status === "failed") {
          const badge = document.createElement("span");
          badge.className = "status";
          badge.dataset.status = "suspended";
          badge.textContent = "failed";
          statusTd.appendChild(badge);
          if (episode.error) {
            const errDiv = document.createElement("div");
            errDiv.className = "error-detail";
            errDiv.textContent = episode.error;
            statusTd.appendChild(errDiv);
          }
        } else {
          statusTd.textContent = episode.regenerating ? "regenerating" : episode.status;
        }
        tr.appendChild(statusTd);

        tr.appendChild(cell(
          episode.status !== "ready" ? "—" : episode.outdated ? "outdated" : "current",
        ));
        const tdActions = document.createElement("td");
        tdActions.className = "actions";
        if (episode.status === "ready") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "secondary";
          btn.textContent = "Regenerate";
          btn.setAttribute("aria-label", "Regenerate " + (episode.title || episode.id));
          btn.addEventListener("click", () => regenerateEpisode(userId, episode, btn));
          tdActions.appendChild(btn);
        } else if (episode.status === "failed") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "primary";
          btn.textContent = "Retry";
          btn.setAttribute("aria-label", "Retry " + (episode.title || episode.id));
          btn.addEventListener("click", () => retrySingleEpisode(userId, episode, btn));
          tdActions.appendChild(btn);
        }
        tr.appendChild(tdActions);
        manageEpisodesBody.appendChild(tr);
      }
      manageEpisodesCaption.textContent = episodes.length === 0
        ? "No episodes yet."
        : "Newest " + plural(episodes.length) + ".";
    } catch (error) {
      say(manageEpisodesFeedback, "error", String(error.message || error));
    }
  }

  async function regenerateEpisode(userId, episode, button) {
    const ok = await askConfirm(
      "Regenerate 1 episode (\\"" + (episode.title || episode.id) + "\\")? " +
        "This is a billed TTS call. The old audio keeps playing until the new audio is ready.",
      {
        title: "Regenerate Episode",
        confirmText: "Regenerate",
      },
    );
    if (!ok) {
      return;
    }
    button.disabled = true;
    try {
      const res = await api(
        "/api/admin/users/" + encodeURIComponent(userId) + "/episodes/" +
          encodeURIComponent(episode.id) + "/regenerate",
        { method: "POST" },
      );
      say(
        manageEpisodesFeedback,
        "ok",
        res && res.queued ? "Queued 1 episode for regeneration." : "Already queued; nothing changed.",
      );
      await loadManageEpisodes(userId);
    } catch (error) {
      say(manageEpisodesFeedback, "error", String(error.message || error));
      button.disabled = false;
    }
  }

  async function retrySingleEpisode(userId, episode, button) {
    const ok = await askConfirm(
      "Retry failed episode (\\"" + (episode.title || episode.id) + "\\")? " +
        "This will re-queue it for synthesis.",
      {
        title: "Retry Failed Episode",
        confirmText: "Retry",
      },
    );
    if (!ok) {
      return;
    }
    button.disabled = true;
    try {
      const res = await api(
        "/api/admin/users/" + encodeURIComponent(userId) + "/episodes/" +
          encodeURIComponent(episode.id) + "/regenerate",
        { method: "POST" },
      );
      if (res && res.queued) {
        say(manageEpisodesFeedback, "ok", "Queued \\"" + (episode.title || episode.id) + "\\" for retry.");
      } else {
        say(manageEpisodesFeedback, "ok", "Episode was already queued or cannot be retried.");
      }
      await loadManageEpisodes(userId);
    } catch (error) {
      say(manageEpisodesFeedback, "error", String(error.message || error));
      button.disabled = false;
    }
  }

  async function regenerateFeed(scope, button) {
    if (!currentManagingUser) return;
    const userId = currentManagingUser.id;
    const count = scope === "all"
      ? regenCounts.all
      : scope === "failed"
      ? regenCounts.failed
      : regenCounts.outdated;
    if (!count) return;
    const promptMessage = scope === "failed"
      ? "Retry " + plural(count) + " failed? This will re-queue each failed episode for synthesis."
      : scope === "all"
      ? "Regenerate and retry " + plural(count) + "? Each ready episode is re-narrated with current prompts and failed episodes are retried."
      : "Regenerate " + plural(count) + " made with older prompts? Each is a billed TTS call. The old audio keeps playing until the new audio is ready.";
    const ok = await askConfirm(promptMessage, {
      title: scope === "failed" ? "Retry Failed Episodes" : "Regenerate Episodes",
      confirmText: scope === "failed" ? "Retry All" : "Regenerate",
    });
    if (!ok) {
      return;
    }
    button.disabled = true;
    try {
      const res = await api("/api/admin/users/" + encodeURIComponent(userId) + "/regenerate", {
        method: "POST",
        body: JSON.stringify({ scope }),
      });
      say(
        manageEpisodesFeedback,
        "ok",
        "Queued " + plural((res && res.queued) || 0) + " for " +
          (scope === "failed" ? "retry." : "regeneration."),
      );
      await loadManageEpisodes(userId);
    } catch (error) {
      say(manageEpisodesFeedback, "error", String(error.message || error));
      button.disabled = false;
    }
  }

  regenOutdated.addEventListener("click", () => regenerateFeed("outdated", regenOutdated));
  if (regenFailed) regenFailed.addEventListener("click", () => regenerateFeed("failed", regenFailed));
  regenAll.addEventListener("click", () => regenerateFeed("all", regenAll));

  // ── The manage pane: opening it, and adding a source ─────────────────────
  function openManage(user) {
    currentManagingUser = user;
    manageName.textContent = user.displayName || user.email;
    renderManageDetails(user);
    const feedUrl = user.feedToken
      ? ORIGIN.replace(/\\/+$/, "") + "/feed/" + encodeURIComponent(user.feedToken) + "/master.xml"
      : "Loading feed URL…";
    manageFeedUrl.value = feedUrl;
    say(manageSourcesFeedback, "", "");
    say(addSourceFeedback, "", "");
    say(manageEpisodesFeedback, "", "");
    manageSection.hidden = false;
    loadManageSources(user.id);
    loadManageEpisodes(user.id);
    manageSection.scrollIntoView({ behavior: "smooth" });
  }

  addSourceForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentManagingUser) return;
    const urlInput = document.getElementById("subFeedUrl");
    const titleInput = document.getElementById("subFeedTitle");
    const modeSelect = document.getElementById("subFeedMode");
    const codeSelect = document.getElementById("subFeedCodeHandling");
    const feedUrl = urlInput.value.trim();
    const title = titleInput.value.trim();
    const mode = modeSelect.value;
    const codeHandling = codeSelect ? codeSelect.value : "skip";
    if (!feedUrl) {
      say(addSourceFeedback, "error", "Feed URL is required.");
      urlInput.focus();
      return;
    }
    submitAddSource.disabled = true;
    try {
      const res = await api(
        "/api/admin/users/" + encodeURIComponent(currentManagingUser.id) + "/sources",
        {
          method: "POST",
          body: JSON.stringify({
            feedUrl,
            title: title || undefined,
            modes: [mode],
            codeHandling,
          }),
        },
      );
      const queued = res.poll && typeof res.poll.queued === "number" ? res.poll.queued : 0;
      say(addSourceFeedback, "ok", "Feed added! " + queued + " post(s) queued for synthesis.");
      addSourceForm.reset();
      await loadManageSources(currentManagingUser.id);
    } catch (error) {
      say(addSourceFeedback, "error", String(error.message || error));
    } finally {
      submitAddSource.disabled = false;
    }
  });
})();
</script>
</body>
</html>
`;
  // Rendered as one document above so the markup reads top to bottom; the shell
  // supplies the header, footer and tokens around its three parts.
  const main = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script>")).trim();
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>")).trim();
  return renderShell({
    title: "Admin — Audio Feed",
    viewer,
    current: "admin",
    stylesheets: [assetUrl("admin.css")],
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    script,
  });
}

/**
 * `GET /admin` — the admin console (audio-feed-8fc).
 *
 * A signed-in admin gets the console on their session. A signed-in non-admin
 * gets 403: they are somebody, just not an admin. A visitor gets the sign-in
 * prompt, with the break-glass token box behind a toggle. All data still comes
 * from /api/admin/*, which is gated independently of this page.
 */
export async function handleAdmin({ ctx, req }: RouteContext<AppContext>): Promise<Response> {
  const origin = resolveOrigin(ctx.config, req);
  const user = await sessionUser(ctx.stores.metadata, req);
  const headers = {
    "content-type": "text/html; charset=utf-8",
    // `no-store`: this document is the one place a feed token is displayed, and
    // it prompts for the admin token. It must never sit in a cache.
    "cache-control": "no-store",
    ...(origin.explicit ? {} : { vary: "Host" }),
    // Not a security boundary by itself, but it keeps the console out of
    // indexes and stops credentials leaking through referrers.
    "referrer-policy": "no-referrer",
  };

  if (user && !isActiveAdmin(user)) {
    const main = `<div class="wrap narrow">
  <p class="eyebrow">Admin</p>
  <h1>This page is for admins</h1>
  <p class="lede">You're signed in as <strong>${esc(user.email)}</strong>, which is not an
  admin account. If you expected otherwise, ask an admin to grant access, or sign out
  and sign in with the right passkey.</p>
  <div class="actions"><a class="btn" href="/account">Go to your account</a></div>
</div>`;
    return new Response(
      renderShell({
        title: "Admin — Audio Feed",
        viewer: viewerOf(user),
        current: "admin",
        kit: true,
        head: `<meta name="robots" content="noindex, nofollow">`,
        main,
      }),
      { status: 403, headers },
    );
  }

  const adminTokenShort = Boolean(ctx.config.adminToken && ctx.config.adminToken.length < 16);
  const html = renderAdminPage({
    publicBaseUrl: origin.baseUrl,
    adminConfigured: Boolean(ctx.config.adminToken),
    adminTokenShort,
    viewer: viewerOf(user),
  });
  return new Response(html, { status: 200, headers });
}
