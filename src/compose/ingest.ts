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
      // Seed the inbox source on first use so the per-source feed route has a
      // source to resolve rather than 404ing on an empty inbox.
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
      return { articleId, episodeId };
    },
  });
  // The ingest seam is a Router handler; the lane factory is a Request handler.
  return ({ req }) => handler(req);
}
