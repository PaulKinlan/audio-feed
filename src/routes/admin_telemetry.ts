/**
 * Telemetry and diagnostics surface (audio-feed-1tj2).
 *
 * Dedicated route at GET /admin/observability/telemetry:
 * - Real-user Core Web Vitals (cwv.report).
 * - Browser & CSP violation reports (report.*).
 * - Outbox notification queue (listOutbox).
 * - Orphan storage blobs (listOrphanBlobs).
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
import type { LogRecord } from "../storage/mod.ts";
import type { OutboxNotification } from "../types.ts";

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
  <h1>Telemetry is for admins</h1>
  <p class="lede">${
    signedInAs
      ? `You're signed in as <strong>${esc(signedInAs)}</strong>, which is not an admin account.`
      : `Sign in with an admin passkey to inspect telemetry.`
  }</p>
  <div class="actions"><a class="btn" href="${signedInAs ? "/account" : "/login"}">${
    signedInAs ? "Go to your account" : "Sign in"
  }</a></div>
</div>`;
  const html = renderShell({
    title: "Telemetry — Audio Feed Admin",
    viewer,
    current: "admin",
    kit: true,
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });
  return htmlResponse(html, nonce, { status: 403, headers: baseHeaders(originIsExplicit) });
}

const TELEMETRY_PAGE_CSS = `
  ${ADMIN_NAV_CSS}
  .admin-telemetry-page {
    max-inline-size: var(--page);
    margin-inline: auto;
    padding: var(--space-8) var(--space-4) var(--space-12);
  }
  .telemetry-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-4);
    margin-block: var(--space-4);
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-4);
  }
  .stat-card dt {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-block-end: var(--space-1);
  }
  .stat-card dd {
    font-size: 1.6rem;
    font-weight: 700;
    margin: 0;
  }
  .rating-good { color: #22c55e; }
  .rating-warn { color: #eab308; }
  .rating-poor { color: #ef4444; }
  .mono-box {
    font-family: var(--mono);
    font-size: 0.82rem;
    padding: var(--space-3);
    background: var(--surface-2, rgba(0,0,0,0.2));
    border-radius: var(--radius-sm, 6px);
    overflow-x: auto;
  }
`;

/**
 * `GET /admin/observability/telemetry` — Telemetry & Diagnostics.
 */
export async function handleAdminTelemetry(
  { ctx, req }: RouteContext<AppContext>,
): Promise<Response> {
  const origin = resolveOrigin(ctx.config, req);
  const user = await sessionUser(ctx.stores.metadata, req);
  const nonce = newCspNonce();
  const viewer = viewerOf(user);

  if (!user || !isActiveAdmin(user)) {
    return notAuthorised(user?.email ?? null, nonce, viewer, origin.explicit);
  }

  // Fetch recent logs to aggregate CWV and browser reports, outbox, and orphan blobs
  let logs: LogRecord[] = [];
  let outbox: OutboxNotification[] = [];
  let orphanBlobs: string[] = [];
  let logsError: string | null = null;
  let outboxError: string | null = null;
  let orphansError: string | null = null;

  try {
    logs = await ctx.stores.metadata.listLogs({ limit: 400 });
  } catch (err) {
    logsError = String((err as Error)?.message ?? err);
  }

  try {
    outbox = await ctx.stores.metadata.listOutbox(50);
  } catch (err) {
    outboxError = String((err as Error)?.message ?? err);
  }

  try {
    orphanBlobs = await ctx.stores.metadata.listOrphanBlobs(100);
  } catch (err) {
    orphansError = String((err as Error)?.message ?? err);
  }

  const cwvLogs = logs.filter((l) => l.type === "cwv.report").reverse();
  const browserReports = logs.filter((l) => l.type.startsWith("report.")).reverse();

  // Aggregate CWV
  const cwvCounts = { lcp: 0, inp: 0, cls: 0 };
  const cwvRatings = { good: 0, warn: 0, poor: 0 };
  for (const cwv of cwvLogs) {
    const metric = cwv.context?.metric as string;
    if (metric === "lcp" || metric === "inp" || metric === "cls") {
      cwvCounts[metric]++;
    }
    if (cwv.severity === "error") cwvRatings.poor++;
    else if (cwv.severity === "warn") cwvRatings.warn++;
    else cwvRatings.good++;
  }

  const main = `
<div class="admin-telemetry-page">
  <h1>Telemetry &amp; Outbox</h1>
  <p class="muted">
    Surface collected real-user telemetry, browser security reports, asynchronous notification dispatch, and orphan storage blobs.
  </p>

  ${renderAdminNav("telemetry")}

  ${
    logsError || outboxError || orphansError
      ? `<div class="card" role="alert">
        <h2>Telemetry store errors</h2>
        ${logsError ? `<p><strong>Logs store:</strong> ${esc(logsError)}</p>` : ""}
        ${outboxError ? `<p><strong>Outbox store:</strong> ${esc(outboxError)}</p>` : ""}
        ${orphansError ? `<p><strong>Orphan blobs store:</strong> ${esc(orphansError)}</p>` : ""}
      </div>`
      : ""
  }

  <section class="card" aria-labelledby="cwv-h">
    <div class="card-head">
      <h2 id="cwv-h">Core Web Vitals (CWV Beacons)</h2>
      <span class="muted u-fs-sm">${
    logsError ? "Unavailable" : `${cwvLogs.length} recent beacon(s)`
  }</span>
    </div>
    <p class="muted">Real-user experience metrics collected from subscriber page loads via <code>POST /api/cwv</code>:</p>

    ${
    logsError
      ? `<p class="muted"><strong>Unavailable — the log store could not be read</strong> (${
        esc(logsError)
      }). This is NOT an empty state.</p>`
      : `<dl class="telemetry-grid">
      <div class="stat-card">
        <dt>Total Beacons</dt>
        <dd>${cwvLogs.length}</dd>
      </div>
      <div class="stat-card">
        <dt>Good Ratings</dt>
        <dd class="rating-good">${cwvRatings.good}</dd>
      </div>
      <div class="stat-card">
        <dt>Needs Improvement</dt>
        <dd class="rating-warn">${cwvRatings.warn}</dd>
      </div>
      <div class="stat-card">
        <dt>Poor Ratings</dt>
        <dd class="rating-poor">${cwvRatings.poor}</dd>
      </div>
    </dl>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Page</th>
            <th scope="col">Metric</th>
            <th scope="col">Value</th>
            <th scope="col">Rating</th>
          </tr>
        </thead>
        <tbody>
          ${
        cwvLogs.length === 0
          ? `<tr><td colspan="5" class="muted text-center">No Core Web Vitals reports received yet.</td></tr>`
          : cwvLogs.slice(0, 25).map((l) => {
            const metric = String(l.context?.metric ?? "—").toUpperCase();
            const value = l.context?.value !== undefined ? String(l.context.value) : "—";
            const unit = String(l.context?.unit ?? "");
            const page = String(l.context?.page ?? "—");
            const ratingClass = l.severity === "error"
              ? "rating-poor"
              : l.severity === "warn"
              ? "rating-warn"
              : "rating-good";
            const ratingLabel = l.severity === "error"
              ? "Poor"
              : l.severity === "warn"
              ? "Needs Improvement"
              : "Good";
            return `<tr>
              <td><time datetime="${esc(l.time)}">${
              esc(l.time.slice(0, 19).replace("T", " "))
            }Z</time></td>
              <td><code>/${esc(page)}</code></td>
              <td><strong>${esc(metric)}</strong></td>
              <td><span class="mono">${esc(value)}${esc(unit)}</span></td>
              <td><span class="${ratingClass} font-semibold">${esc(ratingLabel)}</span></td>
            </tr>`;
          }).join("")
      }
        </tbody>
      </table>
    </div>`
  }
  </section>

  <section class="card" aria-labelledby="reports-h">
    <div class="card-head">
      <h2 id="reports-h">Browser &amp; Security Reports (${
    logsError ? "Unavailable" : browserReports.length
  })</h2>
    </div>
    <p class="muted">Reports collected via W3C Reporting API and CSP endpoint (<code>/api/reports/csp</code>). Note: NEL <code>phase=dns status=0</code> and <code>type=abandoned status=0</code> events reflect client-side offline/DNS blips or cancelled browser navigations, not origin server errors.</p>

    ${
    logsError
      ? `<p class="muted"><strong>Unavailable — the log store could not be read</strong> (${
        esc(logsError)
      }). This is NOT an empty state.</p>`
      : `<div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Type</th>
            <th scope="col">Message / Directive</th>
            <th scope="col">Blocked URL / Target</th>
          </tr>
        </thead>
        <tbody>
          ${
        browserReports.length === 0
          ? `<tr><td colspan="4" class="muted text-center">No browser security or crash reports recorded.</td></tr>`
          : browserReports.slice(0, 25).map((r) => {
            const repType = r.type.replace(/^report\./, "");
            const body = (r.context?.body && typeof r.context.body === "object")
              ? r.context.body as Record<string, unknown>
              : {};
            const blockedUri = String(
              body["blockedURL"] ?? body["blocked-uri"] ?? r.context?.url ?? "—",
            );
            const isClientNel = repType === "network-error" &&
              (body["status_code"] === 0 || body["phase"] === "dns" ||
                body["type"] === "abandoned");
            return `<tr>
              <td><time datetime="${esc(r.time)}">${
              esc(r.time.slice(0, 19).replace("T", " "))
            }Z</time></td>
              <td><code>${esc(repType)}</code>${
              isClientNel ? ` <span class="muted u-fs-xs">(client network/nav)</span>` : ""
            }</td>
              <td>${esc(r.message)}</td>
              <td><span class="mono u-fs-xs">${esc(blockedUri)}</span></td>
            </tr>`;
          }).join("")
      }
        </tbody>
      </table>
    </div>`
  }
  </section>

  <section class="card" aria-labelledby="outbox-h">
    <div class="card-head">
      <h2 id="outbox-h">Notification Outbox Queue (${
    outboxError ? "Unavailable" : outbox.length
  })</h2>
    </div>
    <p class="muted">Pending on-demand article ingest notifications waiting for dispatch:</p>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Created</th>
            <th scope="col">Status</th>
            <th scope="col">Episode</th>
            <th scope="col">Subscriber</th>
            <th scope="col">Player URL</th>
          </tr>
        </thead>
        <tbody>
          ${
    outboxError
      ? `<tr><td colspan="5" class="muted text-center"><strong>Unavailable — the outbox store could not be read</strong> (${
        esc(outboxError)
      }). This is NOT an empty state.</td></tr>`
      : outbox.length === 0
      ? `<tr><td colspan="5" class="muted text-center">Outbox is empty. No pending notifications.</td></tr>`
      : outbox.map((item) => `
            <tr>
              <td><time datetime="${esc(item.createdAt)}">${
        esc(item.createdAt.slice(0, 19).replace("T", " "))
      }Z</time></td>
              <td><span class="subscriber-badge ${
        item.status === "ready" ? "badge-approved" : "badge-suspended"
      }">${esc(item.status)}</span></td>
              <td><strong>${esc(item.title || item.episodeId)}</strong></td>
              <td><a href="/admin/subscribers/${esc(item.userId)}" class="mono u-fs-xs">${
        esc(item.userId)
      }</a></td>
              <td><span class="mono u-fs-xs">${esc(item.playerUrl)}</span></td>
            </tr>
          `).join("")
  }
        </tbody>
      </table>
    </div>
  </section>

  <section class="card" aria-labelledby="orphans-h">
    <div class="card-head">
      <h2 id="orphans-h">Orphan Audio Blobs (${
    orphansError ? "Unavailable" : orphanBlobs.length
  })</h2>
    </div>
    <p class="muted">Audio storage blobs unreferenced by episodes, waiting for storage reclamation sweep:</p>

    ${
    orphansError
      ? `<p class="muted"><strong>Unavailable — the orphan blob store could not be read</strong> (${
        esc(orphansError)
      }). This is NOT an empty state.</p>`
      : orphanBlobs.length === 0
      ? `<p class="muted">No orphan audio blobs detected in storage.</p>`
      : `<ul class="mono-box">
          ${orphanBlobs.map((key) => `<li>${esc(key)}</li>`).join("")}
        </ul>`
  }
  </section>
</div>
`;

  const html = renderShell({
    title: "Telemetry — Audio Feed Admin",
    viewer,
    current: "admin",
    stylesheets: [assetUrl("admin.css")],
    css: TELEMETRY_PAGE_CSS,
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });

  return htmlResponse(html, nonce, { status: 200, headers: baseHeaders(origin.explicit) });
}
