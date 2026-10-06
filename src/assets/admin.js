/**
 * audio-feed-3xq part 4a — the admin console's client as a real module instead of a ~980-line
 * string inside src/routes/admin.ts's template literal.
 *
 * `// @ts-check` plus `/// <reference lib="dom" />` is what makes this file visible to the gate:
 * `deno check` reads a .js file carrying @ts-check, and it reaches this one because
 * src/routes/assets.ts imports it as text. Before this move ~980 lines of browser code — 101
 * document.* calls, 22 addEventListener calls — were checked by nothing, which is the exact
 * failure mode audio-feed-3xq exists to end.
 *
 * Served verbatim at /assets/<hash>.admin.js, so: plain ESM, no TypeScript syntax, no build step.
 * Types come from JSDoc and inference.
 *
 * SINGLE SOURCE (audio-feed-0r0s): the confirm-dialog client at the top of this file — the
 * region between the #confirm-shared markers — is the ONLY copy. src/routes/shell.ts imports
 * this file as text and embeds that exact region inline on the classic-script pages (account),
 * so editing the region edits every surface and there is no second copy to drift. Constraints the
 * region must keep: plain script (no import/export), self-contained (only DOM globals). When
 * audio-feed-3xq part 4c extracts the account script to a module, lift this region into a
 * composed shared asset and delete the shell-side slice.
 */
// @ts-check
/// <reference lib="dom" />

// #confirm-shared-begin
const confirmDialog = /** @type {HTMLDialogElement | null} */ (
  document.getElementById("confirmDialog")
);
if (
  confirmDialog && typeof HTMLDialogElement !== "undefined" &&
  !("closedBy" in HTMLDialogElement.prototype)
) {
  // TODO(baseline/dialog-closedby): remove this click shim; keep closedby="any" on the dialog.
  // Light-dismiss fallback for browsers without native closedby support (Modern Web Guidance)
  confirmDialog.addEventListener("click", (event) => {
    if (event.target !== confirmDialog) return;
    const rect = confirmDialog.getBoundingClientRect();
    const isInside = rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!isInside) confirmDialog.close("cancel");
  });
}

/**
 * The options askConfirm accepts.
 * @typedef {object} ConfirmOptions
 * @property {string} [title]
 * @property {string} [confirmText]
 * @property {string} [cancelText]
 * @property {boolean} [danger]
 */

/**
 * @param {string} message
 * @param {ConfirmOptions} [options]
 * @returns {Promise<boolean>}
 */
function askConfirm(message, options) {
  /** @type {ConfirmOptions} */
  const opts = options || {};
  if (!confirmDialog || typeof confirmDialog.showModal !== "function") {
    return Promise.resolve(confirm(message));
  }
  const titleEl = document.getElementById("confirmTitle");
  const msgEl = document.getElementById("confirmMessage");
  const okEl = document.getElementById("confirmOkBtn");
  const cancelEl = document.getElementById("confirmCancelBtn");
  if (titleEl) titleEl.textContent = opts.title || "Confirm Action";
  if (msgEl) msgEl.textContent = message;
  if (okEl) {
    okEl.textContent = opts.confirmText || "Confirm";
    if (opts.danger === false) {
      okEl.className = "btn primary";
    } else {
      okEl.className = "btn danger";
    }
  }
  if (cancelEl) cancelEl.textContent = opts.cancelText || "Cancel";
  return new Promise((resolve) => {
    const onClose = () => {
      confirmDialog.removeEventListener("close", onClose);
      resolve(confirmDialog.returnValue === "confirm");
    };
    confirmDialog.addEventListener("close", onClose);
    confirmDialog.showModal();
  });
}
// #confirm-shared-end

// ── Session identity, the admin token, and the API wrapper ───────────────
/**
 * The console's data, injected as JSON rather than as code (audio-feed-3xq part 4a).
 * `admin-data` is data the server writes and the client reads, so neither side has to be a
 * string inside the other — the same contract the listen page uses for `player-data`.
 * @typedef {object} AdminData
 * @property {string} origin
 * @property {boolean} signedIn
 */
const dataElement = document.getElementById("admin-data");
/** @type {AdminData} */
const DATA = dataElement
  ? JSON.parse(dataElement.textContent || "{}")
  : { origin: "", signedIn: false };

const ORIGIN = DATA.origin;
// audio-feed-8fc: a signed-in admin's requests carry the session cookie.
const SIGNED_IN = DATA.signedIn;

/**
 * The ids the console shell always renders. Missing one is a deploy bug, not a state to recover
 * from, so it is checked once here rather than optional-chained at every use: 40 `?.` would turn
 * a loud deploy bug into a console that silently does nothing. (Same guard, same reasoning, as
 * listen.js.) Elements the code already guards with `if (el)` keep their plain
 * `document.getElementById` + null type — those guards are deliberate and stay honest.
 * @param {string} id
 */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`admin console is missing #${id}`);
  return el;
};

/**
 * `catch` bindings are `unknown`; the console has always shown `error.message || error`.
 * Same expression, typed.
 * @param {unknown} error
 */
const messageOf = (error) =>
  String(/** @type {{ message?: unknown } | null | undefined } */ (error)?.message || error);

/**
 * The subscriber row shape from GET /api/admin/users, and what the manage pane holds in
 * `currentManagingUser`. Declared here rather than imported because the browser cannot import
 * the server's types; the server's own User shape is the authority this must match.
 * @typedef {object} AdminUser
 * @property {string} id
 * @property {string} email
 * @property {string} [displayName]
 * @property {string} status
 * @property {string} [feedToken]
 * @property {boolean} [isAdmin]
 * @property {{ title: string; queued: number }} [initialSource]
 * @property {number} [dailyEpisodeBudget]
 */

/**
 * The episode row shape from GET /api/admin/users/:id/episodes.
 * @typedef {object} AdminEpisode
 * @property {string} id
 * @property {string} [title]
 * @property {string} [mode]
 * @property {string} status
 * @property {string} [error]
 * @property {boolean} [outdated]
 * @property {boolean} [regenerating]
 */

/**
 * The run-history row shape inside GET /api/admin/stats.
 * @typedef {object} AdminRun
 * @property {string} startedAt
 * @property {string} kind
 * @property {string} trigger
 * @property {number} durationMs
 * @property {string | null} [error]
 * @property {number} [polled]
 * @property {number} [queued]
 * @property {number} [failed]
 * @property {number} [ready]
 * @property {number} [deferred]
 * @property {string[]} [errors]
 */

const usersFeedback = $("usersFeedback");
const usersBody = $("usersBody");
const usersCaption = $("usersCaption");
const created = $("created");
const loadUsersBtn = /** @type {HTMLButtonElement} */ ($("loadUsers"));
const createForm = /** @type {HTMLFormElement} */ ($("createForm"));
const pollNowBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("pollNowBtn"));
const synthesizeNowBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("synthesizeNowBtn")
);
const triggersFeedback = $("triggersFeedback");
const refreshStatsBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("refreshStats")
);
const statDownloads = $("statDownloads");
const statLastPoll = $("statLastPoll");
const statPollDuration = $("statPollDuration");
const statPollNote = $("statPollNote");
const statRuns = $("statRuns");
const statSynthesis = /** @type {HTMLElement | null} */ (document.getElementById("statSynthesis"));
const runsBody = $("runsBody");
const runsCaption = $("runsCaption");
const downloadsBody = $("downloadsBody");
const downloadsCaption = $("downloadsCaption");
const synthesisBody = /** @type {HTMLElement | null} */ (document.getElementById("synthesisBody"));
const synthesisCaption = /** @type {HTMLElement | null} */ (
  document.getElementById("synthesisCaption")
);
const statsFeedback = $("statsFeedback");

/**
 * @param {HTMLElement} el
 * @param {string} tone
 * @param {string} message
 */
const say = (el, tone, message) => {
  el.dataset.tone = tone;
  el.textContent = message;
};

/** @param {number | null | undefined} b */
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

/**
 * Every admin call goes through here, carrying session cookie auth.
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>} the parsed JSON body
 */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(/** @type {Record<string, string> | undefined} */ (options.headers) || {}),
    },
  });
  /** @type {any} */
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
    say(triggersFeedback, "error", messageOf(error));
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
      "Synthesis batch: " + res.ready + " ready, " + res.failed + " failed, " + res.deferred +
        " deferred.",
    );
  } catch (error) {
    say(triggersFeedback, "error", messageOf(error));
  } finally {
    synthesizeNowBtn.disabled = false;
  }
});

// ── User rows: cells, the actions a row takes, and what they report ──────
/**
 * @param {string} text
 * @param {string} [className]
 */
function cell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  // textContent, never innerHTML: a display name is subscriber-supplied text and
  // this document holds the admin token.
  td.textContent = text;
  return td;
}

/** @param {string} status */
function statusCell(status) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = "status";
  span.dataset.status = status;
  span.textContent = status;
  td.appendChild(span);
  return td;
}

/**
 * @param {string} userId
 * @param {string} action
 * @param {HTMLButtonElement} button
 */
async function act(userId, action, button) {
  button.disabled = true;
  try {
    await api("/api/admin/users/" + encodeURIComponent(userId) + "/" + action, { method: "POST" });
    say(usersFeedback, "ok", "User " + action + "d.");
    await loadUsers();
  } catch (error) {
    say(usersFeedback, "error", messageOf(error));
    button.disabled = false;
  }
}

const setupLinkBox = $("setupLinkBox");
const setupLinkUrl = /** @type {HTMLInputElement} */ ($("setupLinkUrl"));
const setupLinkNote = $("setupLinkNote");

/**
 * One-time passkey setup link. Shown once; the server keeps only its hash.
 * @param {AdminUser} user
 * @param {HTMLButtonElement} button
 */
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
    say(usersFeedback, "error", messageOf(error));
  } finally {
    button.disabled = false;
  }
}

$("copySetupLink").addEventListener("click", async () => {
  await navigator.clipboard.writeText(setupLinkUrl.value);
  say(usersFeedback, "ok", "Setup link copied.");
});

/**
 * @param {AdminUser} user
 * @param {boolean} isAdmin
 * @param {HTMLButtonElement} button
 */
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
    say(
      usersFeedback,
      "ok",
      user.email + (isAdmin ? " is now an admin." : " is no longer an admin."),
    );
    await loadUsers();
  } catch (error) {
    say(usersFeedback, "error", messageOf(error));
  } finally {
    button.disabled = false;
  }
}

/** @param {AdminUser} user */
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
  role.setAttribute("aria-label", (role.textContent ?? "") + ": " + user.email);
  role.addEventListener("click", () => setRole(user, !user.isAdmin, role));
  actions.appendChild(role);
  tr.appendChild(actions);
  return tr;
}

/** Relative time, because "4 minutes ago" answers "is cron alive?" and a timestamp does not. */
// ── Runs and stats ───────────────────────────────────────────────────────
/** @param {string | null | undefined} [iso] */
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

/** @param {AdminRun} run */
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
    const perJob = /** @type {Map<string, number>} */ (new Map());
    const shown = /** @type {AdminRun[]} */ (s.runs).filter((run) => {
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
    say(statsFeedback, "error", messageOf(error));
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
    say(usersFeedback, "error", messageOf(error));
  } finally {
    loadUsersBtn.disabled = false;
  }
}

loadUsersBtn.addEventListener("click", loadUsers);

/**
 * @param {string} label
 * @param {string} value
 * @param {string} [className]
 * @returns {[HTMLElement, HTMLElement]}
 */
function definition(label, value, className) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (className) dd.className = className;
  dd.textContent = value;
  return [dt, dd];
}

/**
 * Shows the new subscriber's feed URL once, with a copy control.
 * @param {AdminUser} user
 */
function showCreated(user) {
  // `?? ""`: feedToken is optional on the row shape and is always present on a freshly created
  // user; the checker wants that said out loud (audio-feed-3xq part 4a).
  const feedUrl = ORIGIN.replace(/\/+$/, "") + "/feed/" + encodeURIComponent(user.feedToken ?? "") +
    "/master.xml";
  created.replaceChildren();
  const h3 = document.createElement("h3");
  h3.textContent = "Subscriber created";
  created.appendChild(h3);

  const dl = document.createElement("dl");
  /** @type {[string, string, string?][]} */
  const listItems = [
    ["Email", user.email],
    ["Display name", user.displayName || "—"],
    ["Status", user.status],
    ["User ID", user.id, "mono"],
    // Latent fix found by the checker (audio-feed-3xq part 4a): feedToken is optional on the
    // row shape; before this file was typed, an absent token rendered the string "undefined".
    ["Feed token", user.feedToken ?? "—", "mono"],
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
  const feedback = $("createFeedback");
  const email = /** @type {HTMLInputElement} */ ($("email")).value.trim();
  const displayName = /** @type {HTMLInputElement} */ ($("displayName")).value.trim();
  const feedUrl = /** @type {HTMLInputElement} */ ($("feedUrl")).value.trim();
  if (!email) {
    say(feedback, "error", "An email address is required.");
    /** @type {HTMLInputElement} */ ($("email")).focus();
    return;
  }
  const submit = /** @type {HTMLButtonElement} */ ($("createUser"));
  const newCodeSelect = /** @type {HTMLSelectElement | null} */ (
    document.getElementById("newFeedCodeHandling")
  );
  const codeHandling = newCodeSelect ? newCodeSelect.value : "skip";
  const budgetInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById("newDailyBudget")
  );
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
        isAdmin: /** @type {HTMLInputElement} */ ($("newIsAdmin")).checked || undefined,
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
    say(feedback, "error", messageOf(error));
  } finally {
    submit.disabled = false;
  }
});

// ── Subscriber management: sources, feed URL and token rotation (audio-feed-e3n)
/** @type {AdminUser | null} */
let currentManagingUser = null;
const manageSection = $("manageSection");
const manageName = $("manageName");
const manageDetails = $("manageDetails");
const manageFeedUrl = /** @type {HTMLInputElement} */ ($("manageFeedUrl"));
const copyManageFeedUrl = /** @type {HTMLButtonElement} */ ($("copyManageFeedUrl"));
const rotateManageToken = /** @type {HTMLButtonElement} */ ($("rotateManageToken"));
const manageSourcesBody = $("manageSourcesBody");
const manageSourcesCaption = $("manageSourcesCaption");
const manageSourcesFeedback = $("manageSourcesFeedback");
const addSourceForm = /** @type {HTMLFormElement} */ ($("addSourceForm"));
const addSourceFeedback = $("addSourceFeedback");
const submitAddSource = /** @type {HTMLButtonElement} */ ($("submitAddSource"));
const closeManage = $("closeManage");

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
    const newFeedUrl = ORIGIN.replace(/\/+$/, "") + "/feed/" +
      encodeURIComponent(res.feedToken) + "/master.xml";
    manageFeedUrl.value = newFeedUrl;
    renderManageDetails(currentManagingUser);
    say(manageSourcesFeedback, "ok", "Feed token rotated successfully. Old URL revoked.");
  } catch (error) {
    say(manageSourcesFeedback, "error", messageOf(error));
  } finally {
    rotateManageToken.disabled = false;
  }
});

/** @param {AdminUser} user */
function renderManageDetails(user) {
  manageDetails.replaceChildren();
  /** @type {[string, string, string?][]} */
  const rows = [
    ["Email", user.email],
    ["Display name", user.displayName || "—"],
    ["Status", user.status],
    [
      "Daily budget",
      user.dailyEpisodeBudget !== undefined
        ? String(user.dailyEpisodeBudget) + " episodes/day"
        : "Unlimited",
    ],
    ["User ID", user.id, "mono"],
    ["Feed token", user.feedToken || "—", "mono"],
  ];
  for (const [label, value, cls] of rows) {
    const [dt, dd] = definition(label, value, cls);
    manageDetails.append(dt, dd);
  }
}

/** @param {string} userId */
async function loadManageSources(userId) {
  manageSourcesBody.replaceChildren();
  manageSourcesCaption.textContent = "Loading feeds…";
  try {
    const res = await api("/api/admin/users/" + encodeURIComponent(userId) + "/sources");
    if (res && res.feedToken && currentManagingUser && currentManagingUser.id === userId) {
      currentManagingUser.feedToken = res.feedToken;
      renderManageDetails(currentManagingUser);
      const feedUrl = ORIGIN.replace(/\/+$/, "") + "/feed/" +
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
        const ok = await askConfirm('Remove feed subscription "' + source.title + '"?', {
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
            ? "Removed feed: " + source.title + " (" + res.cancelledPending +
              " pending cancelled, " + res.retainedEpisodes + " retained)"
            : "Removed feed: " + source.title;
          say(manageSourcesFeedback, "ok", msg);
          await loadManageSources(userId);
        } catch (error) {
          say(manageSourcesFeedback, "error", messageOf(error));
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
    say(manageSourcesFeedback, "error", messageOf(error));
  }
}

// ── Regenerate: one episode, or the whole feed (audio-feed-8oz, audio-feed-6y9) ───
const manageEpisodesBody = $("manageEpisodesBody");
const manageEpisodesCaption = $("manageEpisodesCaption");
const manageEpisodesFeedback = $("manageEpisodesFeedback");
const regenOutdated = /** @type {HTMLButtonElement} */ ($("regenOutdated"));
const regenFailed = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("regenFailed")
);
const regenAll = /** @type {HTMLButtonElement} */ ($("regenAll"));
let regenCounts = { outdated: 0, all: 0, failed: 0 };

/** @param {number} n */
function plural(n) {
  return n + " episode" + (n === 1 ? "" : "s");
}

/** @param {string} userId */
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
    say(manageEpisodesFeedback, "error", messageOf(error));
  }
}

/**
 * @param {string} userId
 * @param {AdminEpisode} episode
 * @param {HTMLButtonElement} button
 */
async function regenerateEpisode(userId, episode, button) {
  const ok = await askConfirm(
    'Regenerate 1 episode ("' + (episode.title || episode.id) + '")? ' +
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
    say(manageEpisodesFeedback, "error", messageOf(error));
    button.disabled = false;
  }
}

/**
 * @param {string} userId
 * @param {AdminEpisode} episode
 * @param {HTMLButtonElement} button
 */
async function retrySingleEpisode(userId, episode, button) {
  const ok = await askConfirm(
    'Retry failed episode ("' + (episode.title || episode.id) + '")? ' +
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
      say(
        manageEpisodesFeedback,
        "ok",
        'Queued "' + (episode.title || episode.id) + '" for retry.',
      );
    } else {
      say(manageEpisodesFeedback, "ok", "Episode was already queued or cannot be retried.");
    }
    await loadManageEpisodes(userId);
  } catch (error) {
    say(manageEpisodesFeedback, "error", messageOf(error));
    button.disabled = false;
  }
}

/**
 * @param {"outdated" | "failed" | "all"} scope
 * @param {HTMLButtonElement} button
 */
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
    ? "Regenerate and retry " + plural(count) +
      "? Each ready episode is re-narrated with current prompts and failed episodes are retried."
    : "Regenerate " + plural(count) +
      " made with older prompts? Each is a billed TTS call. The old audio keeps playing until the new audio is ready.";
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
    say(manageEpisodesFeedback, "error", messageOf(error));
    button.disabled = false;
  }
}

regenOutdated.addEventListener("click", () => regenerateFeed("outdated", regenOutdated));
if (regenFailed) regenFailed.addEventListener("click", () => regenerateFeed("failed", regenFailed));
regenAll.addEventListener("click", () => regenerateFeed("all", regenAll));

// ── The manage pane: opening it, and adding a source ─────────────────────
/** @param {AdminUser} user */
function openManage(user) {
  currentManagingUser = user;
  manageName.textContent = user.displayName || user.email;
  renderManageDetails(user);
  const feedUrl = user.feedToken
    ? ORIGIN.replace(/\/+$/, "") + "/feed/" + encodeURIComponent(user.feedToken) + "/master.xml"
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
  const urlInput = /** @type {HTMLInputElement} */ ($("subFeedUrl"));
  const titleInput = /** @type {HTMLInputElement} */ ($("subFeedTitle"));
  const modeSelect = /** @type {HTMLSelectElement} */ ($("subFeedMode"));
  const codeSelect = /** @type {HTMLSelectElement | null} */ (
    document.getElementById("subFeedCodeHandling")
  );
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
    say(addSourceFeedback, "error", messageOf(error));
  } finally {
    submitAddSource.disabled = false;
  }
});
