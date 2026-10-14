/**
 * compose/ingest — the ingest route, and the bounded episode scan it shares.
 *
 * The scan helpers live here because the ingest drain and the admin/account counters
 * are the same question ("how many episodes match this query") asked from three
 * places; they page rather than materialise the catalogue. Moved out of compose.ts
 * by audio-feed-bd0 with no behaviour change.
 */
import { createUrlIngestHandler } from "../ingest/url.ts";
import { INBOX_SOURCE_ID } from "../types.ts";
import { sameOrigin, sessionUser } from "../auth/sessions.ts";
import type { EpisodeQuery, MetadataStore } from "../storage/mod.ts";
import type { Episode } from "../types.ts";
import { resolveOrigin } from "../origin.ts";
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
/** `POST /api/ingest` — queue an arbitrary article for synthesis. */
export function createIngestHandler(
  ctx: AppContext,
  deps: ComposeDeps = {},
): AppHandlers["ingest"] {
  const handler = createUrlIngestHandler({
    fetchArticle: deps.fetchArticle,
    // Identity is the feed token, the same capability the feed routes use.
    authorize: async (request) => {
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
        return signedIn.status === "approved"
          ? signedIn
          : forbidden("An approved user is required.");
      }
      // The explicit-token path is the gate every user-scoped API route owns
      // (`approvedUserFor`); sharing it stops the spend check drifting between
      // routes with its own copy of the try/catch.
      const resolved = await approvedUserFor(ctx, request);
      return "denied" in resolved ? resolved.denied : resolved.user;
    },
    enqueue: async ({ article, mode, user }) => {
      // 202 means QUEUED, not synthesized: no worker exists yet, so this records
      // a pending job rather than pretending an episode is ready.
      const articleId = newArticleId();
      const episodeId = newEpisodeId();
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
            route: "/api/ingest",
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
          const screenedLogErr = screenErrorForLogging(logErr);
          console.warn(
            `[audio-feed] failed to record source_seed_failed log for episode ${episodeId}: ${screenedLogErr.message}`,
          );
        }
      }
      return { articleId, episodeId };
    },
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
