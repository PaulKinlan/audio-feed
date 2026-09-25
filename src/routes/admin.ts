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
 *   from `/api/admin/users*`, which is token-gated server-side. Rendering the
 *   shell without a token reveals nothing, and it means the console can prompt
 *   for the token instead of looking broken.
 * - The admin token lives in `sessionStorage` (per the requirements) and travels
 *   in the `x-admin-token` HEADER, never a query string — same reasoning as the
 *   homepage form: a token in a URL ends up in history and proxy logs.
 * - Subscriber-supplied text (email, display name) is inserted with
 *   `textContent`, never `innerHTML`. A stored-XSS payload in a display name
 *   would otherwise run in the admin's session and read the admin token out of
 *   sessionStorage, i.e. one subscriber could take over the console.
 * - `feedToken` IS shown here, unlike in the approve response. The admin is the
 *   issuer: the token has to be handed to the subscriber somehow, and showing it
 *   once at creation is the only place that is true. The page is therefore
 *   `no-store` and never cached.
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { resolveOrigin } from "../origin.ts";
import { jsonForScript } from "./html.ts";

export interface AdminPageOptions {
  /** Absolute origin, so the shown feed URL is the one that actually works. */
  publicBaseUrl: string;
  /** Whether ADMIN_TOKEN is configured: without it no action can succeed. */
  adminConfigured: boolean;
}

export function renderAdminPage({ publicBaseUrl, adminConfigured }: AdminPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Audio Feed</title>
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📻</text></svg>">
<style>
  /* ---- tokens (identical to src/routes/home.ts) ------------------------- */
  :root {
    color-scheme: light dark;

    --bg: #fbfaf9;
    --surface: #ffffff;
    --surface-sunken: #f2f0ee;
    --text: #1b1a18;
    --text-muted: #55514c;
    --border: #ddd8d2;
    --accent: #7a3e12;
    --accent-text: #ffffff;
    --danger: #a3261a;
    --ok: #1e6b3a;

    --space-1: 0.25rem;
    --space-2: 0.5rem;
    --space-3: 0.75rem;
    --space-4: 1rem;
    --space-6: 1.5rem;
    --space-8: 2rem;
    --space-12: 3rem;

    --radius: 10px;
    --measure: 68ch;
    --page: 54rem;

    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #171614;
      --surface: #201e1c;
      --surface-sunken: #2a2724;
      --text: #f2efec;
      --text-muted: #b3aca4;
      --border: #3a3633;
      --accent: #e8a866;
      --accent-text: #201e1c;
      --danger: #f08a7e;
      --ok: #7fc99a;
    }
  }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    padding: var(--space-8) var(--space-4) var(--space-12);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    line-height: 1.6;
  }

  main { max-inline-size: var(--page); margin-inline: auto; }

  h1 { font-size: clamp(1.5rem, 1.2rem + 1.4vw, 2.1rem); line-height: 1.2; margin: 0 0 var(--space-2); }
  h2 { font-size: 1.15rem; margin: 0 0 var(--space-3); }
  p { max-inline-size: var(--measure); }
  .muted { color: var(--text-muted); }
  .mono { font-family: var(--mono); font-size: 0.85rem; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-6);
    margin-block: var(--space-6);
  }

  label { display: block; font-weight: 600; margin-block-end: var(--space-1); }
  .hint { display: block; font-weight: 400; color: var(--text-muted); font-size: 0.85rem; }

  input, select {
    font: inherit;
    inline-size: 100%;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
  }
  input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
  }

  .field { margin-block-end: var(--space-4); }

  button {
    font: inherit;
    padding: 0.5rem 0.9rem;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-text);
    cursor: pointer;
  }
  button.secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
  button.danger { background: var(--surface); color: var(--danger); border-color: var(--danger); }
  button[disabled] { opacity: 0.55; cursor: not-allowed; }
  .row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }

  /* The table scrolls inside its card rather than widening the page on a phone. */
  .table-wrap { max-inline-size: 100%; overflow-x: auto; }
  table { border-collapse: collapse; inline-size: 100%; font-size: 0.9rem; }
  caption { text-align: start; color: var(--text-muted); font-size: 0.85rem; padding-block-end: var(--space-2); }
  th, td { text-align: start; padding: var(--space-2) var(--space-3); border-block-end: 1px solid var(--border); vertical-align: top; }
  th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); }
  td.actions { white-space: nowrap; }

  .status { font-size: 0.8rem; font-weight: 600; padding: 0.1rem 0.45rem; border-radius: 999px; border: 1px solid var(--border); }
  .status[data-status="approved"] { color: var(--ok); border-color: var(--ok); }
  .status[data-status="suspended"] { color: var(--danger); border-color: var(--danger); }
  .status[data-status="rejected"] { color: var(--danger); border-color: var(--danger); }
  .status[data-status="pending"] { color: var(--text-muted); }

  .feedback { margin-block-start: var(--space-3); min-block-size: 1.5rem; font-weight: 600; }
  .feedback[data-tone="ok"] { color: var(--ok); }
  .feedback[data-tone="error"] { color: var(--danger); }

  .created { margin-block-start: var(--space-4); padding: var(--space-4); background: var(--surface-sunken); border-radius: var(--radius); }
  .created dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2) var(--space-3); margin: 0; }
  .created dt { font-weight: 600; }
  .created dd { margin: 0; overflow-wrap: anywhere; }
  .copy-row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-block-start: var(--space-3); }
  .copy-row input { flex: 1 1 22rem; min-inline-size: 0; }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<main>
  <h1>Audio Feed admin</h1>
  <p class="muted">
    Create subscribers, approve them, and hand out feed URLs. Subscribers cannot
    produce audio until they are approved — that gate is what keeps synthesis
    spend to people you have accepted.
  </p>

  ${
    adminConfigured ? "" : `<div class="card" role="alert">
    <h2>Admin token not configured</h2>
    <p>
      This server has no <code class="mono">ADMIN_TOKEN</code> set, so every
      action here will be refused. Set it in the deployment environment and
      reload. This is deliberate: an unconfigured server must not have an open
      approval endpoint.
    </p>
  </div>`
  }

  <section class="card" aria-labelledby="auth-h">
    <h2 id="auth-h">1. Admin token</h2>
    <p class="muted" id="auth-help">
      Stored in this tab's <code class="mono">sessionStorage</code> and sent as an
      <code class="mono">x-admin-token</code> request header. It is never put in
      the URL. Closing the tab forgets it.
    </p>
    <div class="field">
      <label for="adminToken">Admin token
        <span class="hint">The value of ADMIN_TOKEN on the server.</span>
      </label>
      <input id="adminToken" type="password" autocomplete="off" spellcheck="false"
             aria-describedby="auth-help" />
    </div>
    <div class="row">
      <button type="button" id="saveToken">Save token</button>
      <button type="button" id="loadUsers" class="secondary" disabled>Load subscribers</button>
    </div>
    <p class="feedback" id="authFeedback" role="status" aria-live="polite"></p>
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
        <input id="displayName" name="displayName" type="text" autocomplete="off" />
      </div>
      <div class="field">
        <label for="feedUrl">Initial RSS feed URL (optional)
          <span class="hint">Subscribes the new user immediately and queues recent posts.</span>
        </label>
        <input id="feedUrl" name="feedUrl" type="url" placeholder="https://example.com/feed.xml" autocomplete="off" />
      </div>
      <div class="row">
        <button type="submit" id="createUser">Create and approve</button>
      </div>
      <p class="feedback" id="createFeedback" role="status" aria-live="polite"></p>
    </form>
    <div id="created" hidden></div>
  </section>

  <section class="card" aria-labelledby="users-h">
    <h2 id="users-h">3. Subscribers</h2>
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
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody id="manageSourcesBody"></tbody>
      </table>
    </div>
    <p class="feedback" id="manageSourcesFeedback" role="status" aria-live="polite"></p>

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
      <div class="row">
        <button type="submit" id="submitAddSource">Add feed</button>
      </div>
      <p class="feedback" id="addSourceFeedback" role="status" aria-live="polite"></p>
    </form>
  </section>
</main>

<script>
(() => {
  "use strict";
  const ORIGIN = ${jsonForScript(publicBaseUrl)};
  const tokenInput = document.getElementById("adminToken");
  const authFeedback = document.getElementById("authFeedback");
  const usersFeedback = document.getElementById("usersFeedback");
  const usersBody = document.getElementById("usersBody");
  const usersCaption = document.getElementById("usersCaption");
  const created = document.getElementById("created");
  const loadUsersBtn = document.getElementById("loadUsers");
  const createForm = document.getElementById("createForm");
  const pollNowBtn = document.getElementById("pollNowBtn");
  const synthesizeNowBtn = document.getElementById("synthesizeNowBtn");
  const triggersFeedback = document.getElementById("triggersFeedback");

  const say = (el, tone, message) => {
    el.dataset.tone = tone;
    el.textContent = message;
  };

  const stored = sessionStorage.getItem("audio-feed-admin-token");
  if (stored) {
    tokenInput.value = stored;
    loadUsersBtn.disabled = false;
    if (pollNowBtn) pollNowBtn.disabled = false;
    if (synthesizeNowBtn) synthesizeNowBtn.disabled = false;
    say(authFeedback, "ok", "Token loaded from this session.");
    // Auto-load on refresh (audio-feed-e3n)
    loadUsers();
  } else {
    say(authFeedback, "error", "No token yet. Paste it and save.");
  }

  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("saveToken").click();
    }
  });

  function token() {
    return tokenInput.value.trim();
  }

  /** Every admin call goes through here, so the header is impossible to forget. */
  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        "x-admin-token": token(),
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

  document.getElementById("saveToken").addEventListener("click", () => {
    if (!token()) {
      say(authFeedback, "error", "Enter the admin token first.");
      tokenInput.focus();
      return;
    }
    sessionStorage.setItem("audio-feed-admin-token", token());
    loadUsersBtn.disabled = false;
    if (pollNowBtn) pollNowBtn.disabled = false;
    if (synthesizeNowBtn) synthesizeNowBtn.disabled = false;
    say(authFeedback, "ok", "Token saved for this session.");
    loadUsers();
  });

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
    tr.appendChild(actions);
    return tr;
  }

  async function loadUsers() {
    if (!token()) return;
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
    submit.disabled = true;
    try {
      const user = await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email,
          displayName: displayName || undefined,
          feedUrl: feedUrl || undefined,
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

  // ---- Subscriber Management (audio-feed-e3n) -----------------------------
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
    if (
      !confirm(
        "Are you sure you want to rotate this subscriber's feed token? All existing podcast app subscriptions will stop working.",
      )
    ) {
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

        const tdActions = document.createElement("td");
        tdActions.className = "actions";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger";
        delBtn.textContent = "Remove";
        delBtn.setAttribute("aria-label", "Remove feed " + source.title);
        delBtn.addEventListener("click", async () => {
          if (!confirm("Remove feed subscription \\"" + source.title + "\\"?")) return;
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
    manageSection.hidden = false;
    loadManageSources(user.id);
    manageSection.scrollIntoView({ behavior: "smooth" });
  }

  addSourceForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentManagingUser) return;
    const urlInput = document.getElementById("subFeedUrl");
    const titleInput = document.getElementById("subFeedTitle");
    const modeSelect = document.getElementById("subFeedMode");
    const feedUrl = urlInput.value.trim();
    const title = titleInput.value.trim();
    const mode = modeSelect.value;
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
}

/** `GET /admin` — the admin console shell (public; all data is token-gated). */
export function handleAdmin({ ctx, req }: RouteContext<AppContext>): Response {
  const origin = resolveOrigin(ctx.config, req);
  const html = renderAdminPage({
    publicBaseUrl: origin.baseUrl,
    adminConfigured: Boolean(ctx.config.adminToken),
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `no-store`: this document is the one place a feed token is displayed, and
      // it prompts for the admin token. It must never sit in a cache.
      "cache-control": "no-store",
      ...(origin.explicit ? {} : { vary: "Host" }),
      // Not a security boundary by itself, but it keeps the console out of
      // indexes and stops credentials leaking through referrers.
      "referrer-policy": "no-referrer",
    },
  });
}
