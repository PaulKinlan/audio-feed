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
import { ADMIN_NAV_CSS, renderAdminNav } from "./admin_nav.ts";
import {
  buildObservabilityReport,
  type ClaimAttempt,
  type FailureRow,
  type LiveClaimRow,
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
    css: ADMIN_NAV_CSS,
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
    case "retrying":
      return typeof attempt.uploadRetry === "number" && attempt.uploadRetry > 0
        ? `retrying (upload retry ${attempt.uploadRetry})`
        : "retrying";
    case "abandoned":
      if (attempt.endedWithTerminalWrite) return "abandoned";
      if (attempt.expiryEvidence === "recorded") {
        return "NO terminal write — lease expiry recorded";
      }
      if (attempt.expiryEvidence === "inferred") {
        return "NO terminal write — lease expired (inferred)";
      }
      return "NO terminal write";
    default:
      return attempt.leaseExpired === false ? "in flight" : "in flight (lease unknown)";
  }
}

function attemptsTableHtml(attempts: ClaimAttempt[]): string {
  if (attempts.length === 0) {
    return `<p class="muted">No claim-lifecycle records are retained for this episode.</p>`;
  }
  return `<table>
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
</table>`;
}

function failureRowHtml(failure: FailureRow, report: ObservabilityReport): string {
  const episode = failure.episodeId ? report.episodes[failure.episodeId] : undefined;
  const attempts = failure.episodeId ? report.attempts[failure.episodeId] ?? [] : [];
  const history = attemptsTableHtml(attempts);

  const episodeError = episode?.error
    ? `<p><strong>Episode record:</strong> <code>${esc(episode.error)}</code></p>`
    : "";

  return `<section class="card" id="ep-${esc(failure.episodeId ?? String(failure.seq))}">
  <h3>${cell(failure.severity)} · ${cell(failure.type)} · ${timeCell(failure.time)}</h3>
  <p><strong>${esc(failure.message)}</strong></p>
  ${
    failure.errorMessage
      ? `<p><strong>Message:</strong> <code>${esc(failure.errorMessage)}</code>
  <span class="muted">— screened before it was written: only phrases this service itself throws are
  stored, so a thrown message that quoted your request was discarded rather than stored
  (audio-feed-sw1r).</span></p>`
      : ""
  }
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
  const drainNote = queue.drain === "unknown" && queue.runsReadError
    ? "the run history could not be read, so progress cannot be judged"
    : {
      empty: "nothing queued",
      draining: "queued work is being processed (the last synthesis run made progress)",
      stalled: "queued work is NOT being processed (the last synthesis run made no progress)",
      unknown: "no synthesis run history is retained, so progress cannot be judged",
      unreadable: "the queue could not be read, so nothing about it can be claimed",
    }[queue.drain];

  // A count derived from the log records is UNKNOWN when the log read failed, not zero
  // (audio-feed-m11b): an operator reading only the Queue card must not conclude there were no live
  // claims during the incident that stopped us from seeing them.
  const countCell = (value: number | null, absence: string) =>
    value === null
      ? `<strong>Unavailable — the log store could not be read</strong> <span class="muted">so this is not "${
        esc(absence)
      }".</span>`
      : String(value);

  // audio-feed-yrg4 (found by an m11b-class sweep over aqms's new Retrying table): the reason cell is
  // sourced from the LOG store while the section only gated on the QUEUE read, so an unreadable log store
  // rendered a silent blank where a reason should be - the same "an absence reads as health" shape as the
  // counts above. Three states, in the same shape as countCell: a reason, "could not read", or "none
  // recorded" - never an empty cell whose meaning the operator has to guess.
  const retryReasonCell = (retry: { lastRetryReason?: string }) =>
    retry.lastRetryReason
      ? esc(retry.lastRetryReason)
      : logsUnreadable
      ? `<strong>Unavailable — the log store could not be read</strong>`
      : `<span class="muted">no reason recorded</span>`;

  // A read that failed is stated BEFORE the sections it affects (audio-feed-ciuw). The operator must
  // never have to infer "unreadable" from a zero, because a zero is what a healthy empty deployment
  // looks like - and that confusion is what sends an incident investigation the wrong way.
  const readFailureNotice = report.readErrors.length === 0 ? "" : `<div class="card" role="alert">
    <h2>Some durable state could not be read</h2>
    <p>These sections are NOT reporting an absence of problems — they could not be read at all:</p>
    <ul>${
    report.readErrors.map((failure) =>
      `<li><strong>${esc(failure.store)}</strong>: ${esc(failure.message)}</li>`
    ).join("")
  }</ul>
  </div>`;

  const queueCell = queue.claimable === null
    ? `<strong>Unavailable — the queue read failed</strong> <span class="muted">(${
      esc(queue.readError ?? "no reason recorded")
    }). This is NOT an empty queue.</span>`
    : `${queue.claimable}${queue.claimableCapped ? "+" : ""} ${
      queue.oldestClaimableAt ? `— oldest waiting since ${timeCell(queue.oldestClaimableAt)}` : ""
    }`;

  const lastRunCell = queue.runsReadError
    ? `<strong>Unavailable — the run history read failed</strong> <span class="muted">(${
      esc(queue.runsReadError)
    }). This is NOT "it never ran".</span>`
    : lastRun
    ? `${timeCell(lastRun.startedAt)} (${esc(lastRun.trigger)}) — ${
      lastRun.error
        ? `error: ${esc(lastRun.error)}`
        : `${lastRun.ready ?? 0} ready, ${lastRun.failed ?? 0} failed, ${
          lastRun.deferred ?? 0
        } deferred`
    }`
    : "no run recorded";

  const logsUnreadable = report.readErrors.some((failure) => failure.store === "logs");

  // audio-feed-exww: the live lease rows. Read from the episode store, so this is the one section
  // that is expected to keep rendering while the worker, the cron history and the log store are all
  // unavailable.
  const leaseExpiryCell = (claim: LiveClaimRow): string => {
    if (!claim.leaseExpiresAt) {
      return `<strong>Unknown</strong> <span class="muted">— this claim has no readable \`claimedAt\`, so no expiry can be computed</span>`;
    }
    const assumed = claim.leaseMsAssumed
      ? ` <span class="muted">(computed from the deployment lease of ${
        Math.round((claim.leaseMs ?? 0) / 60_000)
      } min: this claim's own lease record is not in the retained log window)</span>`
      : "";
    return `${timeCell(claim.leaseExpiresAt)}${
      claim.leaseExpired ? ` <strong>(expired)</strong>` : ""
    }${assumed}`;
  };

  const remainingCell = (claim: LiveClaimRow): string => {
    if (claim.remainingMs === null || claim.remainingMs === undefined) {
      return `<span class="muted">—</span>`;
    }
    const magnitude = Math.abs(claim.remainingMs);
    const amount = magnitude >= 60_000
      ? `${Math.floor(magnitude / 60_000)} min`
      : `${Math.round(magnitude / 1000)} s`;
    return claim.remainingMs < 0 ? `<strong>expired ${amount} ago</strong>` : `${amount} left`;
  };

  const heartbeatCell = (claim: LiveClaimRow): string => {
    if (!claim.lastHeartbeat) return `<span class="muted">—</span>`;
    if (claim.heartbeatAgeMs === undefined) return timeCell(claim.lastHeartbeat);
    const age = claim.heartbeatAgeMs >= 60_000
      ? `${Math.floor(claim.heartbeatAgeMs / 60_000)} min ago`
      : `${Math.round(claim.heartbeatAgeMs / 1000)} s ago`;
    return `${timeCell(claim.lastHeartbeat)} <span class="muted">(${age})</span>`;
  };

  // `uploading_audio` is singled out because it is the phase whose heartbeat runs on a timer and
  // whose work (the terminal audio PUT) cannot be resumed by a later invocation from scratch: a
  // lease that expires here is an upload nobody is holding, which is the incident this view exists
  // to make visible rather than something the operator has to infer from a phase string.
  const phaseCell = (claim: LiveClaimRow): string => {
    if (!claim.phase) return `<span class="muted">—</span>`;
    if (claim.phase !== "uploading_audio") return esc(claim.phase);
    return claim.leaseExpired
      ? `<strong>uploading_audio — LEASE EXPIRED with no terminal write</strong>`
      : `<strong>uploading_audio</strong>`;
  };

  const liveClaimsSection = `<section class="card" aria-labelledby="liveclaims-h">
    <h2 id="liveclaims-h">Live claims — lease expiries</h2>
    <p class="muted">Every episode a worker is holding right now, oldest claim first. Read from the
    episode store the claim transitions themselves write — never from the worker — so this list is
    still populated when no worker is running and the log store is unreadable. The lease expiry is
    <code>claimedAt + the claim's lease</code>: a lease that has expired while the episode still says
    <code>synthesizing</code> is a claim nobody finished, and the next worker may take it over.
    The heartbeat is NOT the lease — a worker can be heartbeating while its lease has already run
    out (audio-feed-siv1), which is exactly why both columns are here.</p>
    <p class="muted">Claim state read at ${timeCell(report.generatedAt)}. "Time left" is each row's
    lease expiry minus THAT instant — an expired lease reads as a negative amount — so every figure in
    this table can be retraced against the two instants it was computed from.</p>
    ${
    report.activeClaimsReadError
      ? `<p><strong>Unavailable — the episode store could not be read</strong> <span class="muted">(${
        esc(report.activeClaimsReadError)
      }). This is NOT "no worker holds a claim".</span></p>`
      : report.activeClaims.length === 0
      ? `<p>No worker holds a claim right now.</p>`
      : `${
        report.activeClaimsCapped
          ? `<p class="muted">Showing the first ${report.activeClaims.length} claims; the store held
        more, so this is a truncated listing rather than a total.</p>`
          : ""
      }<div class="table-wrap"><table>
      <caption>Claims a worker holds at the instant this page was rendered</caption>
      <thead><tr>
        <th scope="col">Episode</th><th scope="col">Phase</th><th scope="col">Claimed by</th>
        <th scope="col">Claimed at</th><th scope="col">Last heartbeat</th>
        <th scope="col">Lease expires</th><th scope="col">Time left</th>
        <th scope="col">Attempts</th><th scope="col">Upload retries</th>
      </tr></thead>
      <tbody>${
        report.activeClaims.map((claim) =>
          `<tr>
        <td><code>${esc(claim.episodeId)}</code>${
            claim.title ? `<br><span class="muted">${esc(claim.title)}</span>` : ""
          }</td>
        <td>${phaseCell(claim)}</td>
        <td><code>${cell(claim.claimedBy)}</code></td>
        <td>${timeCell(claim.claimedAt)}</td>
        <td>${heartbeatCell(claim)}</td>
        <td>${leaseExpiryCell(claim)}</td>
        <td>${remainingCell(claim)}</td>
        <td>${cell(claim.attempts)}</td>
        <td>${cell(claim.uploadRetry)}</td>
      </tr>`
        ).join("")
      }</tbody>
    </table></div>`
  }
  </section>`;

  const main = `<div class="wrap">
  <p class="eyebrow">Admin</p>
  <h1>Observability</h1>
  <p class="lede">Errors and job state, read straight from durable storage. Read-only: there are no
  controls on this page on purpose — the page that reports an incident must not be able to cause
  one. <a href="/admin">Back to the console</a>.</p>

  ${renderAdminNav("observability")}

  ${readFailureNotice}

  ${liveClaimsSection}

  <section class="card" aria-labelledby="queue-h">
    <h2 id="queue-h">Queue</h2>
    <dl>
      <dt>Claimable now</dt><dd>${queueCell}</dd>
      <dt>Draining</dt><dd>${esc(drainNote)}</dd>
      <dt>Live claims (from the log window)</dt><dd>${
    countCell(queue.liveClaims, "no live claims")
  }</dd>
      <dt>Abandoned attempts (retained window)</dt><dd>${
    countCell(queue.abandoned, "no abandoned attempts")
  }</dd>
      <dt>Last synthesis run</dt><dd>${lastRunCell}</dd>
    </dl>
  </section>

  <section aria-labelledby="retries-h">
    <h2 id="retries-h">Retrying (yielded claims)</h2>
    <p class="muted">Pending episodes the worker deliberately requeued so a later invocation
    resumes them — retrying, not failed and not abandoned. The verdict comes from the episode's own
    durable state; the reason quoted is the worker's last recorded one.</p>
    ${
    queue.readError
      ? `<p>The queue could not be read, so this list means nothing — see the notice above.</p>`
      : report.retries.length === 0
      ? `<p>No yielded claims in the pending queue.</p>`
      : `${
        logsUnreadable
          ? `<p><strong>The log store could not be read</strong>, so a missing reason below means "could not read", not "none recorded".</p>`
          : ""
      }<table><thead><tr><th>Episode</th><th>Phase</th><th>Attempts</th><th>Upload retries</th><th>Waiting since</th><th>Last recorded reason</th></tr></thead><tbody>${
        report.retries.map((retry) => {
          const age = retry.waitingMs >= 60_000
            ? `${Math.round(retry.waitingMs / 60_000)} min`
            : `${Math.round(retry.waitingMs / 1000)} s`;
          const title = report.episodes[retry.episodeId]?.title ?? retry.title ?? retry.episodeId;
          const retryCount = typeof retry.uploadRetry === "number"
            ? String(retry.uploadRetry)
            : "—";
          const retryAttempts = report.attempts[retry.episodeId] ?? [];
          const historyHtml = retryAttempts.length > 0
            ? `<details><summary class="muted">Claim history (${retryAttempts.length})</summary>${
              attemptsTableHtml(retryAttempts)
            }</details>`
            : "";
          return `<tr><td>${esc(title)}</td><td>${esc(retry.phase)}</td><td>${
            esc(String(retry.attempts ?? "?"))
          }</td><td>${esc(retryCount)}</td><td>${esc(age)}</td><td>${
            retryReasonCell(retry)
          }${historyHtml}</td></tr>`;
        }).join("")
      }</tbody></table>`
  }
  </section>

  <section aria-labelledby="failures-h">
    <h2 id="failures-h">Recent failures</h2>
    <p class="muted">${
    logsUnreadable
      ? `The retained-log window could not be read, so the failure list below means nothing — see the notice above.`
      : `Newest first, at most 25, over records ${readWindow.readFrom}..${
        esc(String(readWindow.newestSeq))
      } (retention keeps records from sequence ${readWindow.oldestRetained}; older failures have been
      pruned, not fixed).`
  }</p>
    ${
    logsUnreadable
      ? `<p><strong>The log store could not be read</strong>, so this is not a statement that there
      were no failures — see the notice above.</p>`
      : report.failures.length === 0
      ? `<p>No warn/error records in the retained window.</p>`
      : report.failures.map((failure) => failureRowHtml(failure, report)).join("")
  }
    <p class="u-mt-4">
      <a href="/admin/observability/issues" class="btn secondary">Browse all issues, filter by route / correlation ID, and dead letters &rarr;</a>
    </p>
  </section>

  <section class="card" aria-labelledby="limits-h">
    <h2 id="limits-h">What this page cannot tell you</h2>
    <ul>
      <li><strong>Counts are over the retained log window</strong>, not all time — the window above
      names the sequence range it read.</li>
      <li><strong>The live-claims table is a snapshot of the instant the page was rendered</strong>,
      taken from the episode store, and is capped (the cap is named above when it is hit). It is not
      the same population as the "Live claims (from the log window)" COUNT in the Queue card: the
      table lists claims that exist NOW, while the count lists in-flight claim ATTEMPTS whose records
      are still retained, so the two can differ and their disagreement is not an error.</li>
      <li><strong>"Retrying" rows come from the pending queue snapshot</strong>, capped like the
      queue card, and name the episode's durable phase — a yielded attempt is never a terminal
      write. Upload retries carry a distinct uploadRetry counter bounded by maxUploadRetries (audio-feed-lqd6)
      so interrupted uploads do not churn forever. The reason quoted there is the worker's recorded prose - it is read from the log store, so
      when that store is unreadable the cell says so instead of rendering blank (audio-feed-yrg4) - and the
      verdict is the state.</li>
      <li><strong>Unhandled request errors record their class and a SCREENED message, never the raw
      one.</strong> A thrown message can quote the request that caused it, which is how a client-chosen
      string would reach the store - so the stored value is drawn from a closed list: a phrase this
      service itself throws (matched as a prefix, with everything after it discarded: that tail is where
      the request gets quoted) or the words "message suppressed (not authored by this codebase)". A
      message you see here is therefore one of OUR phrases, and a message that is not ours shows as the
      suppression marker rather than as itself. To read the platform's own line for the request, take the
      correlation id and the route above (audio-feed-sw1r). Synthesis and claim
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
