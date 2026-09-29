/**
 * compose/shared — request identity and the response helpers every area uses.
 *
 * Extracted first, and that order matters (audio-feed-bd0): the admin block calls
 * helpers that used to live above it, so pulling admin out first would have made
 * compose.ts and admin.ts import each other. These five depend on no handler.
 */
import { assertAuthorizedForAudio, getUserByFeedToken, NotAuthorizedError } from "../auth/users.ts";
import type { AppContext } from "../app.ts";
import type { User } from "../types.ts";
import type { FeedPollOptions, PollDependencies } from "../ingest/feed.ts";
import type { DiscoveredFeed, ExtractedArticle } from "../ingest/url.ts";
import type { VoiceSampleClient } from "../tts/voice-samples.ts";
import type { SynthesisWorkerOptions, Synthesizer } from "../worker/synthesis.ts";
import type { RequestAccessDeps } from "./access.ts";
import type { FailedAuthLimiter } from "../auth/rate_limit.ts";

/** Extraction of the capability token a podcast client can actually send. */
const TOKEN_HEADERS = ["x-feed-token", "x-user-token"] as const;

export function presentedToken(request: Request): string | null {
  for (const header of TOKEN_HEADERS) {
    const value = request.headers.get(header)?.trim();
    if (value) return value;
  }
  const auth = request.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return null;
}

/**
 * Resolve a feed token to its user.
 *
 * The user id is NOT accepted here, and that removal is the point.
 *
 * While the canonical `User` had no `feedToken`, this fell back to
 * `getUser(token)` so the id doubled as the feed capability. That was a
 * reasonable bridge and a real hole: user ids are not secret. They appear in
 * `/api/episodes?userId=`, in `/api/admin/users/:id/approve`, and in the 202
 * body this file returns from an ingest. Anyone who learned an id could read
 * that user's entire feed. Driven through the real dispatcher before the fix:
 *
 *   GET /feed/<feedToken>/master.xml -> 200
 *   GET /feed/<user id>/master.xml   -> 200   <- the bypass
 *
 * Now it is a single indexed lookup on the capability itself. That is also why
 * there is no constant-time compare any more: nothing is compared here. The
 * previous shape scanned every user per request, which made feed polling O(n)
 * and leaked user count through response time.
 */
export function loadUserByFeedToken(ctx: AppContext, token: string): Promise<User | null> {
  return getUserByFeedToken(ctx.stores.metadata, token);
}

export const notFound = (message: string) =>
  Response.json({ error: message }, { status: 404, headers: { "cache-control": "no-store" } });
export const forbidden = (message: string) =>
  Response.json({ error: message }, { status: 403, headers: { "cache-control": "no-store" } });

/**
 * Resolve the caller's feed token to an APPROVED user, or return the response to
 * send. Shared by every user-scoped API route so the spend gate cannot be
 * forgotten on a new one.
 */
export async function approvedUserFor(
  ctx: AppContext,
  req: Request,
): Promise<{ user: User } | { denied: Response }> {
  const token = presentedToken(req);
  if (!token) return { denied: forbidden("A feed token is required (x-feed-token).") };
  const user = await loadUserByFeedToken(ctx, token);
  if (!user) return { denied: forbidden("Unknown feed token.") };
  try {
    await assertAuthorizedForAudio(ctx.stores.metadata, user.id);
  } catch (error) {
    if (error instanceof NotAuthorizedError) {
      return { denied: forbidden("An approved user is required.") };
    }
    throw error;
  }
  return { user };
}

export interface ComposeDeps {
  /** Test seam: lets the acceptance check queue an article without real network. */
  fetchArticle?: (url: string, signal?: AbortSignal) => Promise<ExtractedArticle>;
  /** Test seam: fetches a feed document without real network (audio-feed-2e5). */
  feedTransport?: (url: URL, signal: AbortSignal) => Promise<Response>;
  /** Test seam for voice audition samples (audio-feed-msw); production builds the
   *  real Gemini client from config.geminiApiKey. */
  ttsClient?: VoiceSampleClient;
  /** Test seam for feed discovery (audio-feed-6hw); production reads the real
   * SSRF-guarded helper. */
  discoverFeeds?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ url: string; title: string; feeds: DiscoveredFeed[] }>;
  /** Test seam: synthesizer for synthesis queue processing (audio-feed-dsn). */
  synthesizer?: Synthesizer;
  /** Test seam: feed poll options / dependencies (audio-feed-dsn). */
  feedPollOptions?: PollDependencies & FeedPollOptions;
  /** Test seam: synthesis worker options (audio-feed-dsn). */
  synthesisOptions?: SynthesisWorkerOptions;
  /** Test seam: request access options / rate limiter (audio-feed-r97). */
  requestAccess?: RequestAccessDeps;
  /** Test seam: shared failed admin auth rate limiter (audio-feed-bns). */
  adminAuthLimiter?: FailedAuthLimiter;
}

export const badRequest = (message: string) =>
  Response.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
