/**
 * Routed admin subscriber directory and subscriber detail pages (audio-feed-1tj2).
 *
 * Replaces the inline #manageSection from /admin with dedicated, bookmarkable,
 * routed pages:
 * - GET /admin/subscribers: Directory of all subscribers with status filtering, search, and creation.
 * - GET /admin/subscribers/:id: Detailed subscriber page with feed token, sources, and episode history.
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { htmlResponse, newCspNonce } from "./csp.ts";
import { esc } from "./html.ts";
import { renderShell, viewerOf } from "./shell.ts";
import { isActiveAdmin, sessionUser } from "../auth/sessions.ts";
import { resolveOrigin } from "../origin.ts";
import { ADMIN_NAV_CSS, renderAdminNav } from "./admin_nav.ts";
import { assetUrl } from "./assets.ts";
import type { Episode, Source, User } from "../types.ts";

function baseHeaders(originIsExplicit: boolean): HeadersInit {
  return {
    "cache-control": "no-store",
    ...(originIsExplicit ? {} : { vary: "Host" }),
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  };
}

function notAuthorised(
  signedInAs: string | null,
  nonce: string,
  viewer: ReturnType<typeof viewerOf>,
  originIsExplicit: boolean,
): Response {
  const main = `<div class="wrap narrow">
  <p class="eyebrow">Admin</p>
  <h1>Subscribers management is for admins</h1>
  <p class="lede">${
    signedInAs
      ? `You're signed in as <strong>${esc(signedInAs)}</strong>, which is not an admin account.`
      : `Sign in with an admin passkey to manage subscribers.`
  }</p>
  <div class="actions"><a class="btn" href="${signedInAs ? "/account" : "/login"}">${
    signedInAs ? "Go to your account" : "Sign in"
  }</a></div>
</div>`;
  const html = renderShell({
    title: "Subscribers — Audio Feed Admin",
    viewer,
    current: "admin",
    kit: true,
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });
  return htmlResponse(html, nonce, { status: 403, headers: baseHeaders(originIsExplicit) });
}

const SUBSCRIBERS_PAGE_CSS = `
  ${ADMIN_NAV_CSS}
  .admin-subscribers-page {
    max-inline-size: var(--page);
    margin-inline: auto;
    padding: var(--space-8) var(--space-4) var(--space-12);
  }
  .subscriber-badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .badge-approved { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
  .badge-pending { background: rgba(234, 179, 8, 0.15); color: #eab308; }
  .badge-suspended { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
  .badge-admin { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
  .filter-bar {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    align-items: center;
    margin-block-end: var(--space-4);
  }
  .filter-bar input[type="search"] {
    max-inline-size: 320px;
  }
  .filter-bar select {
    max-inline-size: 180px;
  }
  .detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-4);
    margin-block: var(--space-4);
  }
  .detail-item dt {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-block-end: var(--space-1);
  }
  .detail-item dd {
    margin: 0;
    font-weight: 500;
  }
  .copy-box {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin-block-start: var(--space-2);
  }
  .action-buttons {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-block-start: var(--space-4);
  }
`;

/**
 * `GET /admin/subscribers` — Subscriber directory.
 */
export async function handleAdminSubscribers(
  { ctx, req }: RouteContext<AppContext>,
): Promise<Response> {
  const origin = resolveOrigin(ctx.config, req);
  const user = await sessionUser(ctx.stores.metadata, req);
  const nonce = newCspNonce();
  const viewer = viewerOf(user);

  if (!user || !isActiveAdmin(user)) {
    return notAuthorised(user?.email ?? null, nonce, viewer, origin.explicit);
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const statusFilter = url.searchParams.get("status") ?? "all";

  let allUsers: User[] = [];
  let usersError: string | null = null;
  try {
    allUsers = await ctx.stores.metadata.listUsers();
  } catch (err) {
    usersError = String((err as Error)?.message ?? err);
  }

  const filteredUsers = allUsers.filter((u) => {
    if (statusFilter !== "all" && u.status !== statusFilter) return false;
    if (query) {
      const email = u.email.toLowerCase();
      const name = (u.displayName ?? "").toLowerCase();
      if (!email.includes(query) && !name.includes(query)) return false;
    }
    return true;
  });

  const main = `
<div class="admin-subscribers-page">
  <h1>Subscribers</h1>
  <p class="muted">Manage Audio Feed subscribers, review pending requests, approve access, and inspect individual subscriber feeds and episode histories.</p>
  
  ${renderAdminNav("subscribers")}

  ${
    usersError
      ? `<div class="card" role="alert">
        <h2>Subscriber store unreadable</h2>
        <p><strong>Unavailable — the subscriber store could not be read</strong> (${
        esc(usersError)
      }). This is NOT an empty state.</p>
      </div>`
      : ""
  }

  <section class="card" aria-labelledby="directory-h">
    <div class="card-head">
      <h2 id="directory-h">Subscriber Directory (${filteredUsers.length} of ${allUsers.length})</h2>
    </div>

    <form method="GET" action="/admin/subscribers" class="filter-bar">
      <input type="search" name="q" value="${
    esc(query)
  }" placeholder="Search by email or name…" aria-label="Search subscribers">
      <select name="status" aria-label="Filter by status">
        <option value="all"${statusFilter === "all" ? " selected" : ""}>All statuses</option>
        <option value="approved"${statusFilter === "approved" ? " selected" : ""}>Approved</option>
        <option value="pending"${statusFilter === "pending" ? " selected" : ""}>Pending</option>
        <option value="suspended"${
    statusFilter === "suspended" ? " selected" : ""
  }>Suspended</option>
      </select>
      <button type="submit" class="secondary">Filter</button>
      ${
    query || statusFilter !== "all"
      ? '<a href="/admin/subscribers" class="btn quiet">Clear</a>'
      : ""
  }
    </form>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Subscriber</th>
            <th scope="col">Status</th>
            <th scope="col">Role</th>
            <th scope="col">Daily Budget</th>
            <th scope="col">Created</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${
    usersError
      ? `<tr><td colspan="6" class="muted text-center"><strong>Unavailable — the subscriber store could not be read</strong> (${
        esc(usersError)
      }). This is NOT an empty state.</td></tr>`
      : filteredUsers.length === 0
      ? `<tr><td colspan="6" class="muted text-center">No subscribers found matching this filter.</td></tr>`
      : filteredUsers.map((u) => {
        const badgeClass = u.status === "approved"
          ? "badge-approved"
          : u.status === "suspended"
          ? "badge-suspended"
          : "badge-pending";
        return `<tr>
              <td>
                <a href="/admin/subscribers/${esc(u.id)}" class="u-strong-link"><strong>${
          esc(u.displayName || u.email)
        }</strong></a>
                ${u.displayName ? `<div class="muted u-fs-xs">${esc(u.email)}</div>` : ""}
              </td>
              <td><span class="subscriber-badge ${badgeClass}">${esc(u.status)}</span></td>
              <td>${
          u.isAdmin
            ? '<span class="subscriber-badge badge-admin">Admin</span>'
            : '<span class="muted">User</span>'
        }</td>
              <td>${
          typeof u.dailyEpisodeBudget === "number"
            ? u.dailyEpisodeBudget
            : '<span class="muted">Default</span>'
        }</td>
              <td><span class="muted u-fs-sm">${
          esc(u.createdAt ? u.createdAt.slice(0, 10) : "—")
        }</span></td>
              <td>
                <a href="/admin/subscribers/${esc(u.id)}" class="btn small quiet">Manage &rarr;</a>
              </td>
            </tr>`;
      }).join("")
  }
        </tbody>
      </table>
    </div>
  </section>

  <section class="card" aria-labelledby="create-h">
    <h2 id="create-h">Add New Subscriber</h2>
    <p class="muted">Create an account directly and approve them to start generating audio immediately.</p>
    <form id="createForm" method="POST" action="/api/admin/users" novalidate>
      <div class="field">
        <label for="newEmail">Email address</label>
        <input id="newEmail" name="email" type="email" required placeholder="subscriber@example.com" autocomplete="off" />
      </div>
      <div class="field">
        <label for="newDisplayName">Display name (optional)</label>
        <input id="newDisplayName" name="displayName" type="text" placeholder="e.g. Alex's Podcast" autocomplete="off" />
      </div>
      <div class="field">
        <label for="newFeedUrl">Initial RSS feed URL (optional)</label>
        <input id="newFeedUrl" name="feedUrl" type="url" placeholder="https://example.com/feed.xml" autocomplete="off" />
      </div>
      <div class="row">
        <button type="submit" id="createUserBtn" class="primary">Create and approve</button>
      </div>
      <p class="feedback" id="createFeedback" role="status" aria-live="polite"></p>
    </form>
  </section>
</div>
`;

  const html = renderShell({
    title: "Subscribers — Audio Feed Admin",
    viewer,
    current: "admin",
    stylesheets: [assetUrl("admin.css")],
    css: SUBSCRIBERS_PAGE_CSS,
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });

  return htmlResponse(html, nonce, { status: 200, headers: baseHeaders(origin.explicit) });
}

/**
 * `GET /admin/subscribers/:id` — Dedicated subscriber detail page.
 */
export async function handleAdminSubscriberDetail(
  { ctx, req, params }: RouteContext<AppContext>,
): Promise<Response> {
  const origin = resolveOrigin(ctx.config, req);
  const user = await sessionUser(ctx.stores.metadata, req);
  const nonce = newCspNonce();
  const viewer = viewerOf(user);

  if (!user || !isActiveAdmin(user)) {
    return notAuthorised(user?.email ?? null, nonce, viewer, origin.explicit);
  }

  const subscriberId = params?.id ?? "";
  const subscriber = subscriberId ? await ctx.stores.metadata.getUser(subscriberId) : null;

  if (!subscriber) {
    const notFoundHtml = renderShell({
      title: "Subscriber Not Found — Audio Feed Admin",
      viewer,
      current: "admin",
      kit: true,
      head: `<meta name="robots" content="noindex, nofollow">`,
      main: `<div class="wrap narrow">
        <p class="eyebrow"><a href="/admin/subscribers">&larr; Subscribers</a></p>
        <h1>Subscriber not found</h1>
        <p class="lede">No subscriber exists with ID <code>${esc(subscriberId)}</code>.</p>
        <div class="actions"><a class="btn" href="/admin/subscribers">Return to subscriber directory</a></div>
      </div>`,
      nonce,
    });
    return htmlResponse(notFoundHtml, nonce, {
      status: 404,
      headers: baseHeaders(origin.explicit),
    });
  }

  let sources: Source[] = [];
  let episodes: Episode[] = [];
  let sourcesError: string | null = null;
  let episodesError: string | null = null;

  try {
    sources = await ctx.stores.metadata.listSources(subscriber.id);
  } catch (err) {
    sourcesError = String((err as Error)?.message ?? err);
  }

  try {
    episodes = await ctx.stores.metadata.listEpisodes({ userId: subscriber.id, limit: 50 });
  } catch (err) {
    episodesError = String((err as Error)?.message ?? err);
  }

  const masterFeedUrl = `${origin.baseUrl}/feed/${subscriber.feedToken}/master.xml`;

  const main = `
<div class="admin-subscribers-page">
  <p class="eyebrow"><a href="/admin/subscribers">&larr; Back to Subscribers</a></p>
  <h1>${esc(subscriber.displayName || subscriber.email)}</h1>
  <p class="muted">Subscriber ID: <code class="mono">${esc(subscriber.id)}</code></p>

  ${renderAdminNav("subscribers")}

  <section class="card" aria-labelledby="profile-h">
    <div class="card-head">
      <h2 id="profile-h">Subscriber Profile</h2>
      <div>
        <span class="subscriber-badge ${
    subscriber.status === "approved"
      ? "badge-approved"
      : subscriber.status === "suspended"
      ? "badge-suspended"
      : "badge-pending"
  }">
          ${esc(subscriber.status)}
        </span>
        ${subscriber.isAdmin ? '<span class="subscriber-badge badge-admin">Admin</span>' : ""}
      </div>
    </div>

    <dl class="detail-grid">
      <div class="detail-item">
        <dt>Email</dt>
        <dd>${esc(subscriber.email)}</dd>
      </div>
      <div class="detail-item">
        <dt>Display Name</dt>
        <dd>${esc(subscriber.displayName || "—")}</dd>
      </div>
      <div class="detail-item">
        <dt>Daily Episode Budget</dt>
        <dd>${
    typeof subscriber.dailyEpisodeBudget === "number"
      ? subscriber.dailyEpisodeBudget
      : "Deployment default"
  }</dd>
      </div>
      <div class="detail-item">
        <dt>Created At</dt>
        <dd>${
    esc(subscriber.createdAt ? subscriber.createdAt.replace("T", " ").slice(0, 19) + "Z" : "—")
  }</dd>
      </div>
    </dl>

    <h3>Master Podcast Feed</h3>
    <p class="muted u-fs-sm">Private RSS feed URL containing all synthesised episodes for this subscriber:</p>
    <div class="copy-box">
      <input type="text" readonly value="${
    esc(masterFeedUrl)
  }" id="masterFeedInput" class="mono u-fs-sm" aria-label="Master Feed URL">
    </div>

    <div class="action-buttons">
      ${
    subscriber.status === "approved"
      ? `<form method="POST" action="/api/admin/users/${esc(subscriber.id)}/suspend">
            <button type="submit" class="secondary">Suspend Subscriber</button>
          </form>`
      : `<form method="POST" action="/api/admin/users/${esc(subscriber.id)}/approve">
            <button type="submit" class="primary">Approve Subscriber</button>
          </form>`
  }

      <form method="POST" action="/api/admin/users/${esc(subscriber.id)}/role">
        <input type="hidden" name="isAdmin" value="${subscriber.isAdmin ? "false" : "true"}">
        <button type="submit" class="secondary">${
    subscriber.isAdmin ? "Revoke Admin Role" : "Grant Admin Role"
  }</button>
      </form>

      <form method="POST" action="/api/admin/users/${esc(subscriber.id)}/rotate-token">
        <button type="submit" class="secondary danger">Rotate Feed Token</button>
      </form>
    </div>
  </section>

  <section class="card" aria-labelledby="sources-h">
    <div class="card-head">
      <h2 id="sources-h">Subscribed Feeds (${sources.length})</h2>
    </div>
    
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Feed Title</th>
            <th scope="col">Feed URL</th>
            <th scope="col">Mode</th>
            <th scope="col">Code Handling</th>
            <th scope="col">Last Polled</th>
          </tr>
        </thead>
        <tbody>
          ${
    sourcesError
      ? `<tr><td colspan="5" class="muted text-center"><strong>Unavailable — the feeds store could not be read</strong> (${
        esc(sourcesError)
      }). This is NOT an empty state.</td></tr>`
      : sources.length === 0
      ? `<tr><td colspan="5" class="muted text-center">No feeds subscribed yet.</td></tr>`
      : sources.map((s) => `
            <tr>
              <td><strong>${esc(s.title || s.id)}</strong></td>
              <td><span class="mono u-fs-xs">${esc(s.feedUrl || "—")}</span></td>
              <td><span class="subscriber-badge">${
        esc(s.modes ? s.modes.join(", ") : "direct")
      }</span></td>
              <td>${esc(s.codeHandling ?? "skip")}</td>
              <td><span class="muted u-fs-sm">${
        esc(s.lastPolledAt ? s.lastPolledAt.slice(0, 19).replace("T", " ") : "Never")
      }</span></td>
            </tr>
          `).join("")
  }
        </tbody>
      </table>
    </div>
  </section>

  <section class="card" aria-labelledby="episodes-h">
    <div class="card-head">
      <h2 id="episodes-h">Episodes (${episodes.length})</h2>
      <form method="POST" action="/api/admin/users/${esc(subscriber.id)}/regenerate">
        <button type="submit" class="secondary small">Regenerate Outdated</button>
      </form>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Mode</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col">Audio</th>
          </tr>
        </thead>
        <tbody>
          ${
    episodesError
      ? `<tr><td colspan="5" class="muted text-center"><strong>Unavailable — the episodes store could not be read</strong> (${
        esc(episodesError)
      }). This is NOT an empty state.</td></tr>`
      : episodes.length === 0
      ? `<tr><td colspan="5" class="muted text-center">No episodes created yet.</td></tr>`
      : episodes.map((e) => `
            <tr>
              <td><strong>${esc(e.title || "Untitled")}</strong></td>
              <td><span class="subscriber-badge">${esc(e.mode)}</span></td>
              <td><span class="subscriber-badge ${
        e.status === "ready"
          ? "badge-approved"
          : e.status === "failed"
          ? "badge-suspended"
          : "badge-pending"
      }">${esc(e.status)}</span></td>
              <td><span class="muted u-fs-sm">${
        esc(e.createdAt ? e.createdAt.slice(0, 10) : "—")
      }</span></td>
              <td>${
        e.audioKey
          ? `<a href="/audio/${esc(e.audioKey)}" class="btn small quiet" target="_blank">Listen</a>`
          : '<span class="muted">—</span>'
      }</td>
            </tr>
          `).join("")
  }
        </tbody>
      </table>
    </div>
  </section>
</div>
`;

  const html = renderShell({
    title: `${subscriber.displayName || subscriber.email} — Audio Feed Admin`,
    viewer,
    current: "admin",
    stylesheets: [assetUrl("admin.css")],
    css: SUBSCRIBERS_PAGE_CSS,
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });

  return htmlResponse(html, nonce, { status: 200, headers: baseHeaders(origin.explicit) });
}
