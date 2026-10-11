/**
 * `GET /admin/observability` — errors and job state, for the operator (audio-feed-n6uu).
 *
 * REQUESTED BY PAUL: "I asked you to build in observability. I need you to manage this so I can see
 * it from the admin page in audio-feed." He had to copy a failed episode and its claim history out
 * of the UI and paste it to the fleet. This page is that surface, and it is read-only on purpose:
 * the page that reports an incident must not be able to cause one.
 *
 * AUTH IS THE EXISTING ADMIN GATE, deliberately. `sessionUser` reads the signed-in user from the
 * `__Host-af_session` cookie and `isActiveAdmin` decides; the same `no-store` / `no-referrer` /
 * `x-robots-tag: noindex` headers and the same `htmlResponse` CSP-nonce pattern as `GET /admin`.
 * `ADMIN_TOKEN` stays a bootstrap token for registering a passkey and is NOT a page password.
 *
 * EVERY READ IS IN-PROCESS AND DURABLE (src/observability/admin_report.ts): the log store, the
 * episode records those failures name, the claimable queue and the run history. Nothing here calls
 * the worker, the cron machinery or another route, because this page has to render while the thing
 * it reports on is broken.
 *
 * THE HONEST LIMIT, stated on the page itself: the host gate runs before every route, so while a
 * deployment has no usable PUBLIC_BASE_URL this page cannot be reached at all (audio-feed-du8w).
 * audio-feed-2tbv is the complementary read path that is not behind the gate.
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { htmlResponse, newCspNonce } from "./csp.ts";
import { esc } from "./html.ts";
import { renderShell, viewerOf } from "./shell.ts";
import { isActiveAdmin, sessionUser } from "../auth/sessions.ts";
import { resolveOrigin } from "../origin.ts";
import {
  buildObservabilityReport,
  type ClaimAttempt,
  type FailureRow,
  type ObservabilityReport,
} from "../observability/admin_report.ts";

/** Same headers as the admin console: never cached, never indexed, no referrer. */
function baseHeaders(originIsExplicit: boolean): HeadersInit {
  return {
    "cache-control": "no-store",
    ...(originIsExplicit ? {} : { vary: "Host" }),
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  };
}

function page(
  main: string,
  nonce: string,
  viewer: ReturnType<typeof viewerOf>,
  status: number,
  originIsExplicit: boolean,
): Response {
  const html = renderShell({
    title: "Observability — Audio Feed",
    viewer,
    current: "admin",
    head: `<meta name="robots" content="noindex, nofollow">`,
    main,
    nonce,
  });
  return htmlResponse(html, nonce, { status, headers: baseHeaders(originIsExplicit) });
}

/** The refusal page for anyone who is not an active admin, and never any data in it. */
function notAuthorised(
  signedInAs: string | null,
  nonce: string,
  viewer: ReturnType<typeof viewerOf>,
  originIsExplicit: boolean,
): Response {
  const main = `<div class="wrap narrow">
  <p class="eyebrow">Admin</p>
  <h1>Observability is for admins</h1>
  <p class="lede">${
    signedInAs
      ? `You're signed in as <strong>${esc(signedInAs)}</strong>, which is not an admin account.`
      : `Sign in with an admin passkey to see error and job state.`
  }</p>
  <p>The page carries failure detail for other people's subscriptions, so it is behind the same
  admin gate as <a href="/admin">the console</a>.</p>
  <div class="actions"><a class="btn" href="${signedInAs ? "/account" : "/login"}">${
    signedInAs ? "Go to your account" : "Sign in"
  }</a></div>
</div>`;
  return page(main, nonce, viewer, 403, originIsExplicit);
}

function timeCell(value: string | undefined): string {
  if (!value) return `<span class="muted">—</span>`;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return esc(value);
  return `<time datetime="${esc(value)}">${esc(value.replace("T", " ").slice(0, 19))}Z</time>`;
}

function cell(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") {
    return `<span class="muted">—</span>`;
  }
  return esc(String(value));
}

/** How an attempt ended, in words an operator can act on. */
function outcomeLabel(attempt: ClaimAttempt): string {
  switch (attempt.outcome) {
    case "finished":
      return "finished (terminal write)";
    case "failed":
      return "failed (terminal write)";
    case "abandoned":
      return attempt.endedWithTerminalWrite
        ? "abandoned"
        : attempt.leaseExpired
        ? "NO terminal write — lease expired"
        : "NO terminal write";
    default:
      return attempt.leaseExpired === false ? "in flight" : "in flight (lease unknown)";
  }
}

function failureRowHtml(failure: FailureRow, report: ObservabilityReport): string {
  const episode = failure.episodeId ? report.episodes[failure.episodeId] : undefined;
  const attempts = failure.episodeId ? report.attempts[failure.episodeId] ?? [] : [];
  const history = attempts.length > 0
    ? `<table>
  <caption>Attempt history for this episode — every claim, the phase it reached, and whether it ended with a terminal write</caption>
  <thead><tr>
    <th scope="col">Attempt</th><th scope="col">Owner</th><th scope="col">Started</th>
    <th scope="col">Last heartbeat</th><th scope="col">Phase reached</th>
    <th scope="col">Lease expiry</th><th scope="col">Ended</th>
    <th scope="col">Reason</th>
  </tr></thead>
  <tbody>${
      attempts.map((attempt) =>
        `<tr>
    <td>${attempt.attempt}</td>
    <td><code>${cell(attempt.owner)}</code></td>
    <td>${timeCell(attempt.startedAt)}</td>
    <td>${timeCell(attempt.lastHeartbeat)}</td>
    <td>${
          attempt.phases.length > 0
            ? attempt.phases.map((phase) => esc(phase)).join(" → ")
            : cell(attempt.phase)
        }</td>    <td>${timeCell(attempt.leaseExpiresAt)}${
          attempt.leaseExpired === true ? ` <strong>(expired)</strong>` : ""
        }</td>
    <td>${esc(outcomeLabel(attempt))}</td>
    <td>${cell(attempt.reason)}</td>
  </tr>`
      ).join("")
    }</tbody>
</table>`
    : `<p class="muted">No claim-lifecycle records are retained for this episode.</p>`;

  const episodeError = episode?.error
    ? `<p><strong>Episode record:</strong> <code>${esc(episode.error)}</code></p>`
    : "";

  return `<section class="card" id="ep-${esc(failure.episodeId ?? String(failure.seq))}">
  <h3>${cell(failure.severity)} · ${cell(failure.type)} · ${timeCell(failure.time)}</h3>
  <p><strong>${esc(failure.message)}</strong></p>
  <dl>
    <dt>Route</dt><dd>${cell(failure.route)}</dd>
    <dt>Status</dt><dd>${cell(failure.status)}</dd>
    <dt>Correlation id</dt><dd><code>${cell(failure.correlationId)}</code>
      <span class="muted">— copy this to find every record and log line for the request</span></dd>
    <dt>Episode</dt><dd>${cell(failure.episodeId)}${
    episode?.title ? ` — ${esc(episode.title)}` : ""
  }${episode ? ` (status: ${esc(episode.status)})` : ""}</dd>
    <dt>Attempt / phase</dt><dd>${cell(failure.attempt)} / ${cell(failure.phase)}</dd>
    <dt>Duration</dt><dd>${failure.durationMs === undefined ? "—" : `${failure.durationMs}ms`}</dd>
  </dl>
  ${episodeError}
  ${history}
</section>`;
}

export async function handleAdminObservability(
  { ctx, req }: RouteContext<AppContext>,
): Promise<Response> {
  const origin = resolveOrigin(ctx.config, req);
  const nonce = newCspNonce();
  const user = await sessionUser(ctx.stores.metadata, req);
  const viewer = viewerOf(user);
  if (!user || !isActiveAdmin(user)) {
    return notAuthorised(user?.email ?? null, nonce, viewer, origin.explicit);
  }

  const report = await buildObservabilityReport(ctx.stores);
  const { queue, window: readWindow } = report;
  const lastRun = queue.lastSynthesisRun;
  const drainNote = {
    empty: "nothing queued",
    draining: "queued work is being processed (the last synthesis run made progress)",
    stalled: "queued work is NOT being processed (the last synthesis run made no progress)",
    unknown: "no synthesis run history is retained, so progress cannot be judged",
  }[queue.drain];

  const main = `<div class="wrap">
  <p class="eyebrow">Admin</p>
  <h1>Observability</h1>
  <p class="lede">Errors and job state, read straight from durable storage. Read-only: there are no
  controls on this page on purpose — the page that reports an incident must not be able to cause
  one. <a href="/admin">Back to the console</a>.</p>

  <section class="card" aria-labelledby="queue-h">
    <h2 id="queue-h">Queue</h2>
    <dl>
      <dt>Claimable now</dt><dd>${queue.claimable}${queue.claimableCapped ? "+" : ""} ${
    queue.oldestClaimableAt ? `— oldest waiting since ${timeCell(queue.oldestClaimableAt)}` : ""
  }</dd>
      <dt>Draining</dt><dd>${esc(drainNote)}</dd>
      <dt>Live claims (retained window)</dt><dd>${queue.liveClaims}</dd>
      <dt>Abandoned attempts (retained window)</dt><dd>${queue.abandoned}</dd>
      <dt>Last synthesis run</dt><dd>${
    lastRun
      ? `${timeCell(lastRun.startedAt)} (${esc(lastRun.trigger)}) — ${
        lastRun.error
          ? `error: ${esc(lastRun.error)}`
          : `${lastRun.ready ?? 0} ready, ${lastRun.failed ?? 0} failed, ${
            lastRun.deferred ?? 0
          } deferred`
      }`
      : "no run recorded"
  }</dd>
    </dl>
  </section>

  <section aria-labelledby="failures-h">
    <h2 id="failures-h">Recent failures</h2>
    <p class="muted">Newest first, at most 25, over records ${readWindow.readFrom}..${
    esc(String(readWindow.newestSeq))
  } (retention keeps records from sequence ${readWindow.oldestRetained}; older failures have been
  pruned, not fixed).</p>
    ${
    report.failures.length === 0
      ? `<p>No warn/error records in the retained window.</p>`
      : report.failures.map((failure) => failureRowHtml(failure, report)).join("")
  }
  </section>

  <section class="card" aria-labelledby="limits-h">
    <h2 id="limits-h">What this page cannot tell you</h2>
    <ul>
      <li><strong>Counts are over the retained log window</strong>, not all time — the window above
      names the sequence range it read.</li>
      <li><strong>Unhandled request errors record their class, not their message.</strong> A thrown
      message can quote the request that caused it, which is how a client-chosen string would reach
      the store, so the message is deliberately not stored. For those, take the correlation id and
      the route above and read the platform log line for the same request. Synthesis and claim
      failures — the ones this page is for — do carry their reason and error text, because our own
      worker and storage code write them.</li>
      <li><strong>This page cannot render while the host gate is refusing this host.</strong> The
      gate runs before every route, so an unconfigured deployment answers 500/421 here too, with no
      page at all. That is why a read path outside the gate is tracked separately.</li>
    </ul>
  </section>
</div>`;

  return page(main, nonce, viewer, 200, origin.explicit);
}
