/**
 * compose/ingest — the ingest route, and the bounded episode scan it shares.
 *
 * The scan helpers live here because the ingest drain and the admin/account counters
 * are the same question ("how many episodes match this query") asked from three
 * places; they page rather than materialise the catalogue. Moved out of compose.ts
 * by audio-feed-bd0 with no behaviour change.
 */
import { createUrlIngestHandler, type ExtractedArticle } from "../ingest/url.ts";
import { createUploadIngestHandler } from "../ingest/upload.ts";
import { SlidingWindowRateLimiter } from "../auth/rate_limit.ts";
import { type AudioMode, INBOX_SOURCE_ID, type User } from "../types.ts";
import { sameOrigin, sessionUser } from "../auth/sessions.ts";
import type { EpisodeQuery, MetadataStore } from "../storage/mod.ts";
import type { Episode } from "../types.ts";
import { resolveOrigin } from "../origin.ts";
import { DEFAULT_DAILY_EPISODE_BUDGET } from "../config.ts";
import { dailyEpisodeBudgetFor } from "../worker/synthesis.ts";
import { approvedUserFor, type ComposeDeps, forbidden, presentedToken } from "./shared.ts";
import type { AppContext, AppHandlers } from "../app.ts";
import { newArticleId, newEpisodeId } from "../ids.ts";
import { type Article } from "../types.ts";
import {
  screenErrorForLogging,
  screenErrorMessage,
  SUPPRESSED_MESSAGE,
} from "../observability/error_screen.ts";

/**
 * Walk a whole-catalogue episode scan one batch at a time (audio-feed-att).
 *
 * `listEpisodes` with an uncapped limit materialised every matching Episode into
 * one array — measured at ~0.33 KB/episode, so a 50k-episode source cost ~16 MB
 * per call and a single admin request made up to four of them. Reinstating a cap
 * is NOT the fix: audio-feed-c9q showed rows past a cap are silently skipped and
 * then orphaned unrecoverably. This pages the same scan and discards each batch,
 * so the peak working set is one batch while coverage stays complete.
 */
const EPISODE_SCAN_BATCH = 100;
export async function* episodeScan(
  metadata: MetadataStore,
  query: Omit<EpisodeQuery, "limit">,
): AsyncGenerator<Episode[]> {
  let cursor: string | undefined;
  for (;;) {
    const page = await metadata.listEpisodePage({
      ...query,
      limit: EPISODE_SCAN_BATCH,
      cursor,
    });
    yield page.episodes;
    // A cursor that stops advancing means the scan is done. Without this a
    // misbehaving adapter spins here forever, and a hang is the worst refusal.
    if (!page.cursor || page.cursor === cursor) return;
    cursor = page.cursor;
  }
}
/** Count a scan without holding it: the counting sites never need the objects. */
export async function countEpisodeScan(
  metadata: MetadataStore,
  query: Omit<EpisodeQuery, "limit">,
): Promise<number> {
  let total = 0;
  for await (const batch of episodeScan(metadata, query)) total += batch.length;
  return total;
}
/** Authorize an ingest or upload request using either presented feed-token or signed-in session user. */
export async function authorizeIngest(
  ctx: AppContext,
  request: Request,
): Promise<User | Response> {
  if (!presentedToken(request)) {
    // audio-feed-8fc: a signed-in browser may send without pasting its token,
    // but a cookie is ambient, so it only counts from this origin. This is a
    // state change (POST), so the strict `sameOrigin` wall applies rather than
    // the same-site-read wall a GET route uses.
    const signedIn = await sessionUser(ctx.stores.metadata, request);
    if (!signedIn) return forbidden("A feed token is required (x-feed-token).");
    if (!sameOrigin(request, resolveOrigin(ctx.config, request).baseUrl)) {
      return forbidden("Cross-origin request refused.");
    }
    return signedIn.status === "approved" ? signedIn : forbidden("An approved user is required.");
  }
  // The explicit-token path is the gate every user-scoped API route owns
  // (`approvedUserFor`); sharing it stops the spend check drifting between
  // routes with its own copy of the try/catch.
  const resolved = await approvedUserFor(ctx, request);
  return "denied" in resolved ? resolved.denied : resolved.user;
}

/**
 * Accepted episode-creation ceiling per subscriber, per rolling 24 hours (audio-feed-kp30l).
 *
 * WHY A CREATION CAP AND NOT A SPEND ACCOUNTING FIX: the daily synthesis counter bills at the SAME
 * atomic commit that marks an episode `ready` (src/storage/kv/episodes.ts), so an episode that
 * burns paid attempts and then fails terminally is paid for and never counted. Counting attempts
 * instead would change what the daily budget MEANS — one broken article retried three times would
 * spend three of a subscriber's fifty — and still would not bound how many episodes exist.
 * Creation is the quantity a token actually chooses, and it is countable BEFORE the Article+Episode
 * pair commits (`enqueueInboxArticle`), so the cap sits here.
 *
 * WHY THE CAP IS THE BUDGET: it is the SAME number the completion budget charges against —
 * `dailyEpisodeBudgetFor(user, ctx.config.defaultDailyEpisodeBudget)` (src/worker/synthesis.ts):
 * the subscriber's own budget when they have one, else the configured deployment default, else
 * `DEFAULT_DAILY_EPISODE_BUDGET` (src/config.ts). Resolving it here rather than hardcoding the
 * constant is what keeps the cap from refusing a legitimate subscriber when an operator raises
 * DEFAULT_DAILY_EPISODE_BUDGET or sets a personal budget: the cap and the budget read the same
 * number by construction, so the cap never refuses a day the budget would fund. Worst case per
 * subscriber per day goes from unbounded to budget creations x `maxAttempts` 3 paid attempts.
 *
 * WHY 24 HOURS, NOT A UTC DAY: the limiter is a sliding window; a rolling 24 hours cannot be reset
 * by waiting for midnight, and it needs no day key.
 *
 * SCOPE — ingest/upload refuse over-budget submissions; feed polls defer new items instead.
 * Feed polling retains its per-source 10-item ceiling and CAS deduplication. A feed item not
 * admitted by the shared creation window is not persisted as seen, so a later poll retries it.
 * Subscription initial polls keep their separate 5-item ceiling (audio-feed-uhfis).
 *
 * WHY ADMIN-DRIVEN CREATION IS NOT CAPPED (audio-feed-l9l63):
 * Admin operations (createUser with initial feed, addSourceForUser, adminPollNow, admin regenerate) are
 * operator-driven and guarded by `adminGate`. Capping operator actions with subscriber creation limits
 * would break legitimate bulk operations such as subscriber onboarding batches, prompt migrations,
 * and disaster-recovery feed regenerations.
 */
export const INGEST_CREATION_RATE = {
  maxRequests: DEFAULT_DAILY_EPISODE_BUDGET,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

/** Exported so tests exercise the SAME window row the handlers write. */
export const INGEST_CREATION_WINDOW = "ingest_creation";

/** The bound's name, so a refusal says WHICH limit refused rather than only that one did. */
export const INGEST_CREATION_BOUND = "episode_creations_per_token";

/** The bound's name for maximum sources held by a subscriber. */
export const SOURCE_CEILING_BOUND = "sources_per_subscriber";

/**
 * Derives the maximum number of sources a subscriber may hold.
 *
 * Code-tied to dailyEpisodeBudgetFor so a subscriber cannot hold more sources
 * than their funded daily episode budget can sustain in one 24-hour window.
 * An unconfigured subscriber gets DEFAULT_DAILY_EPISODE_BUDGET; an operator-raised
 * deployment default or subscriber-specific budget scales the ceiling proportionally.
 */
export function sourceCeilingFor(
  user: { dailyEpisodeBudget?: number } | null | undefined,
  deploymentDefault?: number,
): { limit: number; source: "user" | "default" } {
  return dailyEpisodeBudgetFor(user, deploymentDefault);
}

/**
 * Count one accepted episode creation against `user`, or return the refusal.
 *
 * The limiter is keyed on the USER, not the client address: one subscriber may hold
 * several tokens and addresses. Both route checks and feed polls resolve the same
 * funded budget and 24-hour storage row here.
 */
/** The shared funded creation window for ingest/upload and periodic feed polling. */
export function ingestCreationLimiter(
  ctx: AppContext,
  user: { dailyEpisodeBudget?: number; id?: string } | null | undefined,
): SlidingWindowRateLimiter {
  const { limit } = dailyEpisodeBudgetFor(user, ctx.config.defaultDailyEpisodeBudget);
  return new SlidingWindowRateLimiter(
    { maxRequests: limit, windowMs: INGEST_CREATION_RATE.windowMs },
    ctx.stores.metadata,
    INGEST_CREATION_WINDOW,
  );
}

/**
 * Count one submit BEFORE the article fetch, so a refused submit costs no outbound fetch.
 * A submission whose episode later fails still consumed its creation slot.
 */
export async function refuseIngestOverCreationCap(
  ctx: AppContext,
  user: User,
): Promise<Response | null> {
  // The SAME resolution the synthesis spend check applies for this subscriber, from the SAME
  // config object — a hardcoded literal here would refuse submissions a raised or personal
  // budget happily funds. tests/ingest_creation_cap_test.ts pins this relation.
  const { limit: creationLimit } = dailyEpisodeBudgetFor(
    user,
    ctx.config.defaultDailyEpisodeBudget,
  );
  const rate = { maxRequests: creationLimit, windowMs: INGEST_CREATION_RATE.windowMs };
  const limit = await ingestCreationLimiter(ctx, user).check(user.id);
  if (limit.allowed) return null;
  return Response.json(
    {
      error: `Episode creation limit reached: at most ${creationLimit} accepted ` +
        `ingest/upload requests per subscriber per 24 hours.`,
      bound: INGEST_CREATION_BOUND,
      limit: creationLimit,
      windowMs: rate.windowMs,
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(Math.max(1, Math.ceil(limit.resetMs / 1000))),
      },
    },
  );
}

/**
 * `authorizeIngest` plus the creation cap, for the two routes that create episodes.
 *
 * Composed here rather than inside each handler so ingest and upload cannot drift: a route that
 * skips the cap silently reopens audio-feed-kp30l for its own surface.
 */
async function authorizeIngestWithCap(ctx: AppContext, request: Request): Promise<User | Response> {
  const user = await authorizeIngest(ctx, request);
  if (user instanceof Response) return user;
  return (await refuseIngestOverCreationCap(ctx, user)) ?? user;
}

export interface EnqueueInboxItemInput {
  article: ExtractedArticle;
  mode: AudioMode;
  user: User;
  articleId?: string;
  episodeId?: string;
  route?: string;
}

/** Construct and persist an Article+Episode pair for the inbox source, seeding the source if needed. */
export async function enqueueInboxArticle(
  ctx: AppContext,
  input: EnqueueInboxItemInput,
): Promise<{ articleId: string; episodeId: string }> {
  const { article, mode, user, route = "/api/ingest" } = input;
  // 202 means QUEUED, not synthesized: no worker exists yet, so this records
  // a pending job rather than pretending an episode is ready.
  const articleId = input.articleId ?? newArticleId();
  const episodeId = input.episodeId ?? newEpisodeId();
  const now = new Date().toISOString();
  const record: Article = {
    id: articleId,
    userId: user.id,
    sourceId: INBOX_SOURCE_ID,
    url: article.url,
    title: article.title,
    author: article.author ?? undefined,
    publishedAt: article.publishedAt ?? undefined,
    content: article.body,
    excerpt: article.lead,
    ingestedAt: now,
  };
  const episode: Episode = {
    id: episodeId,
    userId: user.id,
    sourceId: INBOX_SOURCE_ID,
    sourceTitle: "Inbox",
    articleId,
    mode,
    status: "pending",
    title: article.title,
    description: article.lead,
    createdAt: now,
  };
  // audio-feed-d8q: one commit for the pair. Written as two calls, a failed
  // putEpisode left the article stored with no audio behind it — and because
  // queueItems dedupes on the article alone, a URL that came through the inbox once
  // like that was skipped by every later poll of a feed carrying it (measured on
  // main before this: queued=0 skipped=1 episodes=0, permanently). A retry still
  // re-queues here, since this write is deliberately blind; what it can no longer do
  // is half-succeed.
  await ctx.stores.metadata.putArticleWithEpisode(record, episode);
  // audio-feed-0s2j, audio-feed-16jq: once the pair write commits, the episode IS
  // persisted in KV as pending. Nothing in the post-commit auxiliary path (source seeding,
  // degradation logging, stderr warnings) must ever throw or escape enqueue to fail the 202
  // response or emit a false pre-episode dead-letter log.
  try {
    if (!(await ctx.stores.metadata.getSource(user.id, INBOX_SOURCE_ID))) {
      await ctx.stores.metadata.putSource({
        id: INBOX_SOURCE_ID,
        userId: user.id,
        title: "Send to Audio",
        modes: ["direct", "deepdive"],
        // Unspecified on purpose (audio-feed-4xt): the inbox is not a source that
        // ever chose a voice, so hard-coding "Charon" here would shadow both the
        // user's own preference and the operator's DEFAULT_VOICE.
        voices: {},
        createdAt: now,
      });
    }
  } catch (err) {
    // audio-feed-0xdm: screen operational stderr logs to eliminate unscreened error/stack/article text
    const screened = screenErrorForLogging(err);
    console.warn(
      `[audio-feed] failed to seed inbox source for user ${user.id}; episode ${episodeId} was queued: ${screened.message}`,
    );
    // audio-feed-l5w1, audio-feed-16jq: record a distinct durable warn event for post-commit
    // auxiliary failure; wrap in nested try/catch so a failure to record degradation cannot
    // fail the enqueue or escalate to an enqueue_failed 503 dead-letter.
    try {
      await ctx.stores.metadata.appendLog({
        time: new Date().toISOString(),
        severity: "warn",
        type: "ingest.source_seed_failed",
        message: "Failed to seed inbox source after episode was queued",
        process: "app",
        route,
        userId: user.id,
        correlationId: crypto.randomUUID(),
        reason: "source_seed_failed",
        context: {
          status: 202,
          episodeId,
          articleId,
          sourceId: INBOX_SOURCE_ID,
          error: screened.message,
        },
      });
    } catch (logErr) {
      // audio-feed-m0sk: accepted containment trade. Once `putArticleWithEpisode` has
      // committed, the episode is durably queued and returning 5xx would report failure for a
      // write that already succeeded (causing a retrying client to duplicate the episode).
      // Because `appendLog` writes to the same metadata store that just failed, no separate
      // in-process durable fallback channel exists; if `appendLog` also fails during a store
      // outage, only this screened operational stderr warning remains, and a reader of the
      // durable observability feed cannot distinguish this post-commit auxiliary degradation
      // from clean 202 success during that outage.
      const screenedLogErr = screenErrorForLogging(logErr);
      console.warn(
        `[audio-feed] failed to record source_seed_failed log for episode ${episodeId}: ${screenedLogErr.message}`,
      );
    }
  }
  return { articleId, episodeId };
}

/** `POST /api/ingest` — queue an arbitrary article for synthesis. */
export function createIngestHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["ingest"] {
  const handler = createUrlIngestHandler({
    fetchArticle: deps.fetchArticle,
    // Identity is the feed token, the same capability the feed routes use.
    authorize: (request) => authorizeIngestWithCap(ctx, request),
    enqueue: ({ article, mode, user }) =>
      enqueueInboxArticle(ctx, { article, mode, user, route: "/api/ingest" }),
    onFailure: async ({ user, reason, status, mode, error, article }) => {
      // audio-feed-r7sb, audio-feed-tm97, audio-feed-fapx, audio-feed-8v53: surface pre-episode ingest failures
      // in structured logs for dead-letter visibility, preserving article URL/title and screened error cause.
      // Follow throw-presence discipline (k3x6, 2zik, j8n4): presence of error, not truthiness of error string.
      const screenedError = error !== undefined ? screenErrorMessage(error) : undefined;
      await ctx.stores.metadata.appendLog({
        time: new Date().toISOString(),
        severity: "warn",
        type: "ingest.failed",
        message: screenedError && screenedError !== SUPPRESSED_MESSAGE
          ? `Article ingest failed before episode creation: ${screenedError}`
          : "Article ingest failed before episode creation",
        process: "app",
        route: "/api/ingest",
        userId: user?.id,
        correlationId: crypto.randomUUID(),
        reason,
        context: {
          status,
          ...(mode ? { mode } : {}),
          ...(screenedError ? { error: screenedError } : {}),
          ...(article?.url ? { articleUrl: article.url } : {}),
          ...(article?.title ? { articleTitle: article.title } : {}),
        },
      });
    },
  });
  // The ingest seam is a Router handler; the lane factory is a Request handler.
  return ({ req }) => handler(req);
}

/** `POST /api/upload` — upload a document (txt, md, html, pdf) for synthesis. */
export function createUploadHandler(
  ctx: AppContext,
  _deps: ComposeDeps = {},
): AppHandlers["upload"] {
  const handler = createUploadIngestHandler({
    authorize: (request) => authorizeIngestWithCap(ctx, request),
    enqueue: ({ article, mode, user, articleId, episodeId }) =>
      enqueueInboxArticle(ctx, {
        article,
        mode,
        user,
        articleId,
        episodeId,
        route: "/api/upload",
      }),
    onSuccess: async ({ user, episodeId, articleId, article, mode, filename, bytes }) => {
      try {
        await ctx.stores.metadata.appendLog({
          time: new Date().toISOString(),
          severity: "info",
          type: "upload.accepted",
          message: `Uploaded file accepted and queued as episode ${episodeId}: "${article.title}"`,
          process: "app",
          route: "/api/upload",
          userId: user.id,
          correlationId: episodeId,
          episodeId,
          context: {
            status: 202,
            mode,
            episodeId,
            articleId,
            title: article.title,
            filename,
            byteLength: bytes,
          },
        });
      } catch (logErr) {
        const screened = screenErrorForLogging(logErr);
        console.warn(
          `[audio-feed] failed to record upload.accepted log for episode ${episodeId}: ${screened.message}`,
        );
      }
    },
    onFailure: async (
      { user, reason, status, correlationId, error, filename, limit, actual, mode },
    ) => {
      const screenedError = error !== undefined ? screenErrorMessage(error) : undefined;
      try {
        await ctx.stores.metadata.appendLog({
          time: new Date().toISOString(),
          severity: "warn",
          type: "upload.failed",
          message: screenedError && screenedError !== SUPPRESSED_MESSAGE
            ? `File upload failed before episode creation: ${screenedError}`
            : "File upload failed before episode creation",
          process: "app",
          route: "/api/upload",
          userId: user?.id,
          correlationId,
          reason,
          context: {
            status,
            ...(mode ? { mode } : {}),
            ...(screenedError ? { error: screenedError } : {}),
            ...(filename ? { filename } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(actual !== undefined ? { actual } : {}),
          },
        });
      } catch (logErr) {
        const screened = screenErrorForLogging(logErr);
        console.warn(
          `[audio-feed] failed to record upload.failed log: ${screened.message}`,
        );
      }
    },
  });
  return ({ req }) => handler(req);
}
