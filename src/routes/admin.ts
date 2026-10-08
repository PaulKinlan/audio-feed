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
import { renderShell, type Viewer, viewerOf } from "./shell.ts";
import { htmlContentSecurityPolicy, newCspNonce } from "./csp.ts";
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
  /** CSP nonce for this response (audio-feed-syhu); stamped on the shell's inline tags. */
  nonce: string;
}

export function renderAdminPage(
  {
    publicBaseUrl,
    adminConfigured,
    adminTokenShort = false,
    viewer = null,
    nonce,
  }: AdminPageOptions,
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
      ? `<div class="card u-accent-start u-mb-4" role="status">
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
    <p class="muted u-mt-3 u-fs-088">
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
      <button type="button" id="pollNowBtn" class="secondary" disabled data-tooltip="Poll all configured RSS feeds immediately">Poll Feeds Now</button>
      <button type="button" id="synthesizeNowBtn" class="secondary" disabled data-tooltip="Process pending audio synthesis jobs">Synthesize Queue Now</button>
    </div>
    <p class="feedback" id="triggersFeedback" role="status" aria-live="polite"></p>
  </section>

  <section class="card" id="manageSection" aria-labelledby="manage-h" hidden>
    <div class="row u-center-between">
      <h2 id="manage-h" class="u-m-0">4. Manage subscriber: <span id="manageName"></span></h2>
      <button type="button" id="closeManage" class="secondary">Close</button>
    </div>
    <div class="created u-mt-4">
      <dl id="manageDetails"></dl>
      <div class="copy-row">
        <input type="text" id="manageFeedUrl" readonly aria-label="Subscriber master feed URL" />
        <button type="button" id="copyManageFeedUrl" data-tooltip="Copy master feed URL">Copy feed URL</button>
        <button type="button" id="rotateManageToken" class="danger" data-tooltip="Revoke old URL and generate new feed token">Rotate token</button>
      </div>
      <p class="muted u-mt-2 u-mb-0 u-fs-xs" id="rotateHelp">
        Rotating the feed token revokes the old URL immediately.
      </p>
    </div>

    <h3 class="u-mt-6 u-mb-2">Subscribed RSS feeds</h3>
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

    <h3 class="u-mt-6 u-mb-2">Episodes</h3>
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

    <h3 class="u-mt-6 u-mb-2">Add feed to subscriber</h3>
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

<!-- audio-feed-3xq part 4a: the console's client is a content-addressed module
     (src/assets/admin.js), and everything the server knows is one JSON document. Data in the
     page, code in a file — the same contract the listen page uses for #player-data. -->
<script type="application/json" id="admin-data" nonce="${esc(nonce)}">${
    jsonForScript({
      origin: publicBaseUrl,
      signedIn,
    })
  }</script>
</body>
</html>
`;
  // Rendered as one document above so the markup reads top to bottom; the shell
  // supplies the header, footer and tokens around its parts. The data island is part of main:
  // it is the page's payload, not code. The client itself is a module the shell links.
  const main = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</script>") + 9).trim();
  return renderShell({
    title: "Admin — Audio Feed",
    viewer,
    current: "admin",
    stylesheets: [assetUrl("admin.css")],
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    scriptModule: assetUrl("admin.js"),
    nonce,
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
  const nonce = newCspNonce();
  const headers = {
    "content-type": "text/html; charset=utf-8",
    // The nonce-bearing policy is attached here because this handler builds its own headers
    // for both the 403 and the 200 branch (audio-feed-syhu).
    "content-security-policy": htmlContentSecurityPolicy(nonce),
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
        nonce,
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
    nonce,
  });
  return new Response(html, { status: 200, headers });
}
