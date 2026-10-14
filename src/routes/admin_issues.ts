/**
 * Browsable, paginated issue & log explorer (audio-feed-1tj2 & audio-feed-r7sb).
 *
 * Dedicated route at GET /admin/observability/issues:
 * - Query filters: severity (warn/error/info), log type, route, episodeId, correlationId.
 * - Dedicated Dead-Letter / Pre-Episode Ingest Failures view (audio-feed-r7sb).
 * - Pagination beyond the 25-row summary cap.
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
  <h1>Observability issues is for admins</h1>
  <p class="lede">${
    signedInAs
      ? `You're signed in as <strong>${esc(signedInAs)}</strong>, which is not an admin account.`
      : `Sign in with an admin passkey to inspect logs and issues.`
  }</p>
  <div class="actions"><a class="btn" href="${signedInAs ? "/account" : "/login"}">${
    signedInAs ? "Go to your account" : "Sign in"
  }</a></div>
</div>`;
  const html = renderShell({
    title: "Issues & Logs — Audio Feed Admin",
    viewer,
    current: "admin",
    kit: true,
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });
  return htmlResponse(html, nonce, { status: 403, headers: baseHeaders(originIsExplicit) });
}

const ISSUES_PAGE_CSS = `
  ${ADMIN_NAV_CSS}
  .admin-issues-page {
    max-inline-size: var(--page);
    margin-inline: auto;
    padding: var(--space-8) var(--space-4) var(--space-12);
  }
  .filter-form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
    margin-block-end: var(--space-6);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: var(--space-4);
    border-radius: var(--radius);
  }
  .filter-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-inline-size: 150px;
    flex: 1 1 150px;
  }
  .filter-field label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
  }
  .filter-actions {
    flex: 0 0 auto;
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .severity-pill {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .sev-error { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
  .sev-warn { background: rgba(234, 179, 8, 0.15); color: #eab308; }
  .sev-info { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
  .sev-debug { background: rgba(148, 163, 184, 0.15); color: #94a3b8; }
  .log-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-4);
    margin-block-end: var(--space-3);
  }
  .log-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-block-end: var(--space-2);
  }
  .log-meta {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    font-size: 0.85rem;
  }
  .log-body {
    margin-block-start: var(--space-2);
    font-size: 0.95rem;
  }
  .log-context {
    margin-block-start: var(--space-2);
    padding: var(--space-2);
    background: var(--surface-2, rgba(0,0,0,0.2));
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 0.8rem;
    overflow-x: auto;
  }
  .log-stack {
    color: #ef4444;
  }
  .log-links {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-block-start: var(--space-2);
    font-size: 0.8rem;
  }
  .dead-letter-box {
    border-inline-start: 4px solid var(--accent, #eab308);
  }
  .pagination-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-block-start: var(--space-6);
  }
`;

/**
 * `GET /admin/observability/issues` — Browsable, paginated issue & log explorer.
 */
export async function handleAdminIssues({ ctx, req }: RouteContext<AppContext>): Promise<Response> {
  const origin = resolveOrigin(ctx.config, req);
  const user = await sessionUser(ctx.stores.metadata, req);
  const nonce = newCspNonce();
  const viewer = viewerOf(user);

  if (!user || !isActiveAdmin(user)) {
    return notAuthorised(user?.email ?? null, nonce, viewer, origin.explicit);
  }

  const url = new URL(req.url);
  const severityFilter = url.searchParams.get("severity") ?? "warn_error";
  const typeFilter = (url.searchParams.get("type") ?? "").trim();
  const routeFilter = (url.searchParams.get("route") ?? "").trim();
  const correlationFilter = (url.searchParams.get("correlationId") ?? "").trim();
  const episodeFilter = (url.searchParams.get("episodeId") ?? "").trim();
  const beforeSeqParam = url.searchParams.get("beforeSeq");
  const beforeSeq = beforeSeqParam ? parseInt(beforeSeqParam, 10) : undefined;

  const PAGE_LIMIT = 50;
  let bounds = { oldestSeq: 0, newestSeq: 0 };
  let rawRecords: LogRecord[] = [];
  let logsError: string | null = null;

  // Read window: if beforeSeq given, read until beforeSeq
  const queryWindow: { untilSeq?: number; limit: number } = {
    limit: 200,
    ...(beforeSeq !== undefined && Number.isFinite(beforeSeq) ? { untilSeq: beforeSeq - 1 } : {}),
  };

  try {
    bounds = await ctx.stores.metadata.logBounds();
    rawRecords = await ctx.stores.metadata.listLogs(queryWindow);
  } catch (err) {
    logsError = String((err as Error)?.message ?? err);
  }
  // Sort descending (newest first)
  const sortedRecords = [...rawRecords].reverse();

  // Apply filters
  const filtered = sortedRecords.filter((rec) => {
    if (severityFilter === "warn_error" && rec.severity !== "warn" && rec.severity !== "error") {
      return false;
    } else if (
      severityFilter !== "all" && severityFilter !== "warn_error" && rec.severity !== severityFilter
    ) {
      return false;
    }
    if (typeFilter && !rec.type.toLowerCase().includes(typeFilter.toLowerCase())) {
      return false;
    }
    if (
      routeFilter && (!rec.route || !rec.route.toLowerCase().includes(routeFilter.toLowerCase()))
    ) {
      return false;
    }
    if (correlationFilter && rec.correlationId !== correlationFilter) {
      return false;
    }
    if (episodeFilter && rec.episodeId !== episodeFilter) {
      return false;
    }
    return true;
  });

  const displayRecords = filtered.slice(0, PAGE_LIMIT);

  // Dead letters (ingest.failed) within current filtered results
  const deadLetters = displayRecords.filter((r) => r.type === "ingest.failed");

  // Determine oldest displayed seq for pagination
  const oldestDisplayedSeq = displayRecords.length > 0
    ? displayRecords[displayRecords.length - 1]!.seq
    : undefined;
  const hasOlder = oldestDisplayedSeq !== undefined && oldestDisplayedSeq > bounds.oldestSeq;

  const buildQuery = (params: Record<string, string | undefined>) => {
    const nextUrl = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) nextUrl.searchParams.delete(k);
      else nextUrl.searchParams.set(k, v);
    }
    return nextUrl.pathname + nextUrl.search;
  };

  const main = `
<div class="admin-issues-page">
  <h1>Issues &amp; Dead Letters</h1>
  <p class="muted">
    Explore structured application logs, filter by severity and correlation ID, and inspect pre-episode ingest failures (dead letters).
  </p>

  ${renderAdminNav("issues")}

  <form method="GET" action="/admin/observability/issues" class="filter-form"
        toolname="filter_observability_issues"
        tooldescription="Filter observability issues by severity, event type, route, correlation ID or episode ID."
        toolautosubmit>
    <div class="filter-field">
      <label for="filterSeverity">Severity</label>
      <select id="filterSeverity" name="severity">
        <option value="warn_error"${
    severityFilter === "warn_error" ? " selected" : ""
  }>Warnings &amp; Errors</option>
        <option value="all"${severityFilter === "all" ? " selected" : ""}>All Severities</option>
        <option value="error"${severityFilter === "error" ? " selected" : ""}>Error only</option>
        <option value="warn"${severityFilter === "warn" ? " selected" : ""}>Warn only</option>
        <option value="info"${severityFilter === "info" ? " selected" : ""}>Info only</option>
      </select>
    </div>

    <div class="filter-field">
      <label for="filterType">Event Type</label>
      <input type="text" id="filterType" name="type" value="${
    esc(typeFilter)
  }" placeholder="e.g. ingest.failed, synthesis.claim">
    </div>

    <div class="filter-field">
      <label for="filterRoute">Route</label>
      <input type="text" id="filterRoute" name="route" value="${
    esc(routeFilter)
  }" placeholder="e.g. /api/ingest">
    </div>

    <div class="filter-field">
      <label for="filterCorrelation">Correlation ID</label>
      <input type="text" id="filterCorrelation" name="correlationId" value="${
    esc(correlationFilter)
  }" placeholder="Lookup correlation ID">
    </div>

    <div class="filter-field">
      <label for="filterEpisode">Episode ID</label>
      <input type="text" id="filterEpisode" name="episodeId" value="${
    esc(episodeFilter)
  }" placeholder="Lookup episode ID">
    </div>

    <div class="filter-field filter-actions">
      <button type="submit" class="primary">Apply Filters</button>
      <a href="/admin/observability/issues" class="btn quiet small">Reset</a>
    </div>
  </form>

  ${
    logsError
      ? `<div class="card" role="alert">
        <h2>Log store unreadable</h2>
        <p><strong>Unavailable — the log store could not be read</strong> (${
        esc(logsError)
      }). This is NOT an empty state.</p>
      </div>`
      : ""
  }

  ${
    deadLetters.length > 0 && !typeFilter.includes("ingest.failed")
      ? `<section class="card dead-letter-box" aria-labelledby="dead-letter-h">
        <h2 id="dead-letter-h">Dead-Letter Queue (Recent Pre-Episode Ingest Failures: ${deadLetters.length})</h2>
        <p class="muted u-fs-sm">Article submissions or feed polls that failed before creating an episode record:</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Source / Route</th>
                <th scope="col">Reason</th>
                <th scope="col">Subscriber</th>
                <th scope="col">Correlation ID</th>
              </tr>
            </thead>
            <tbody>
              ${
        deadLetters.map((dl) => `
                <tr>
                  <td><time datetime="${esc(dl.time)}">${
          esc(dl.time.slice(0, 19).replace("T", " "))
        }Z</time></td>
                  <td><code>${esc(dl.route ?? dl.job ?? "ingest")}</code></td>
                  <td><span class="subscriber-badge badge-suspended">${
          esc(dl.reason ?? "failed")
        }</span></td>
                  <td>${
          dl.userId
            ? `<a href="/admin/subscribers/${esc(dl.userId)}" class="mono u-fs-xs">${
              esc(dl.userId)
            }</a>`
            : '<span class="muted">—</span>'
        }</td>
                  <td><a href="${
          esc(buildQuery({ correlationId: dl.correlationId }))
        }" class="mono u-fs-xs">${esc(dl.correlationId ?? "—")}</a></td>
                </tr>
              `).join("")
      }
            </tbody>
          </table>
        </div>
      </section>`
      : ""
  }

  <section aria-labelledby="records-h">
    <div class="u-flex-between-wrap u-mb-3">
      <h2 id="records-h" class="u-m-0">Log Events (${displayRecords.length} shown)</h2>
      <span class="muted u-fs-sm">Retained sequences: ${bounds.oldestSeq}..${bounds.newestSeq}</span>
    </div>

    ${
    logsError
      ? `<div class="card"><p class="muted text-center"><strong>Unavailable — the log store could not be read</strong> (${
        esc(logsError)
      }). This is NOT an empty state.</p></div>`
      : displayRecords.length === 0
      ? `<div class="card"><p class="muted text-center">No log events found matching the selected filters.</p></div>`
      : displayRecords.map((rec) => {
        const sevClass = rec.severity === "error"
          ? "sev-error"
          : rec.severity === "warn"
          ? "sev-warn"
          : rec.severity === "info"
          ? "sev-info"
          : "sev-debug";
        return `
        <article class="log-card">
          <div class="log-head">
            <div class="log-meta">
              <span class="severity-pill ${sevClass}">${esc(rec.severity)}</span>
              <strong><code class="mono">${esc(rec.type)}</code></strong>
              <span class="muted u-fs-xs">#${rec.seq}</span>
              <time datetime="${esc(rec.time)}" class="muted u-fs-xs">${
          esc(rec.time.replace("T", " ").slice(0, 19))
        }Z</time>
            </div>
            <div class="muted u-fs-xs">
              ${rec.process ? `<span class="mono">${esc(rec.process)}</span>` : ""}
              ${rec.route ? ` &bull; <span class="mono">${esc(rec.route)}</span>` : ""}
              ${rec.job ? ` &bull; <span class="mono">${esc(rec.job)}</span>` : ""}
            </div>
          </div>
          <div class="log-body">
            <div>${esc(rec.message)}</div>
            ${
          rec.reason
            ? `<div class="muted u-fs-sm u-mt-1">Reason: <strong><code class="mono">${
              esc(rec.reason)
            }</code></strong></div>`
            : ""
        }
          </div>
          ${
          rec.correlationId || rec.episodeId || rec.userId
            ? `<div class="muted log-links">
                ${
              rec.correlationId
                ? `<span>Correlation: <a href="${
                  esc(buildQuery({ correlationId: rec.correlationId }))
                }" class="mono">${esc(rec.correlationId)}</a></span>`
                : ""
            }
                ${
              rec.episodeId
                ? `<span>Episode: <a href="${
                  esc(buildQuery({ episodeId: rec.episodeId }))
                }" class="mono">${esc(rec.episodeId)}</a></span>`
                : ""
            }
                ${
              rec.userId
                ? `<span>Subscriber: <a href="/admin/subscribers/${esc(rec.userId)}" class="mono">${
                  esc(rec.userId)
                }</a></span>`
                : ""
            }
              </div>`
            : ""
        }
          ${
          rec.context && Object.keys(rec.context).length > 0
            ? `<pre class="log-context"><code>${
              esc(JSON.stringify(rec.context, null, 2))
            }</code></pre>`
            : ""
        }
          ${
          rec.stack ? `<pre class="log-context log-stack"><code>${esc(rec.stack)}</code></pre>` : ""
        }
        </article>`;
      }).join("")
  }

    <nav class="pagination-bar" aria-label="Logs pagination">
      ${
    beforeSeq !== undefined
      ? `<a href="${
        esc(buildQuery({ beforeSeq: undefined }))
      }" class="btn secondary small">&larr; Back to Newest</a>`
      : "<span></span>"
  }
      ${
    hasOlder
      ? `<a href="${
        esc(buildQuery({ beforeSeq: String(oldestDisplayedSeq) }))
      }" class="btn secondary small">Older Records (before #${oldestDisplayedSeq}) &rarr;</a>`
      : "<span></span>"
  }
    </nav>
  </section>
</div>
`;

  const html = renderShell({
    title: "Issues & Logs — Audio Feed Admin",
    viewer,
    current: "admin",
    stylesheets: [assetUrl("admin.css")],
    css: ISSUES_PAGE_CSS,
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });

  return htmlResponse(html, nonce, { status: 200, headers: baseHeaders(origin.explicit) });
}
