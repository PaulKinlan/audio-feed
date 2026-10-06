/**
 * Sign-in and account API (audio-feed-8fc).
 *
 * Every route here is cookie-authenticated or mints the cookie, so every one of
 * them checks Origin first: a POST from another site is refused before anything
 * is read. Admin routes live in compose.ts behind `adminGate`, which accepts an
 * admin session OR the admin token.
 */

import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";
import { resolveOrigin } from "../origin.ts";
import {
  clearSessionCookie,
  createSession,
  endSession,
  issueSetupLink,
  peekSetupLink,
  sameOrigin,
  sessionCookie,
  sessionUser,
} from "../auth/sessions.ts";
import {
  authenticationOptions,
  finishAuthentication,
  finishRegistration,
  PasskeyError,
  registrationOptions,
  relyingParty,
} from "../auth/passkeys.ts";
import {
  approveUser,
  createUser,
  getUserByEmail,
  isValidEmail,
  normaliseEmail,
  requireAdminToken,
  rotateFeedToken,
  updatePreferences,
} from "../auth/users.ts";
import {
  extractClientIp,
  type FailedAuthLimiter,
  getSharedAdminAuthLimiter,
} from "../auth/rate_limit.ts";
import { subscribeToFeed } from "../ingest/feed.ts";
import {
  articleUrl,
  type DiscoveredFeed,
  discoverFeeds as discoverFeedsOnPage,
  type ExtractedArticle,
  IngestError,
} from "../ingest/url.ts";
import { GEMINI_TTS_VOICES } from "../tts/gemini.ts";
import { type AudioMode, isAudioMode, isSynthesisAuthorized, type User } from "../types.ts";

export interface AccountHandlers {
  loginOptions: Handler<AppContext>;
  loginVerify: Handler<AppContext>;
  registerOptions: Handler<AppContext>;
  registerVerify: Handler<AppContext>;
  bootstrap: Handler<AppContext>;
  logout: Handler<AppContext>;
  profile: Handler<AppContext>;
  rotateToken: Handler<AppContext>;
  addSource: Handler<AppContext>;
  discoverFeed: Handler<AppContext>;
  deleteSource: Handler<AppContext>;
  deletePasskey: Handler<AppContext>;
  regenerateEpisode: Handler<AppContext>;
  regenerateOutdated: Handler<AppContext>;
}

export interface AccountDeps {
  feedTransport?: (url: URL, signal: AbortSignal) => Promise<Response>;
  fetchArticle?: (url: string, signal?: AbortSignal) => Promise<ExtractedArticle>;
  /** Test seam for the discovery read; production uses the SSRF-safe helper. */
  discoverFeeds?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{ url: string; title: string; feeds: DiscoveredFeed[] }>;
  /** compose.ts's shared source deletion, scoped to `userId`. */
  deleteUserSource: (req: Request, userId: string, sourceId: string) => Promise<Response>;
  /** compose.ts's shared regenerate, outdated scope; resolves the number queued. */
  regenerateOutdated: (userId: string, scope?: "outdated" | "all" | "failed") => Promise<number>;
  /** Test seam: shared failed admin auth rate limiter (audio-feed-bns). */
  adminAuthLimiter?: FailedAuthLimiter;
}

const NO_STORE = { "cache-control": "no-store" };

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function baseUrl(ctx: AppContext, req: Request): string {
  return resolveOrigin(ctx.config, req).baseUrl;
}

/** The CSRF wall. `null` means the request came from this origin. */
function crossOrigin(ctx: AppContext, req: Request): Response | null {
  return sameOrigin(req, baseUrl(ctx, req))
    ? null
    : reply({ error: "Cross-origin request refused." }, 403);
}

/** The signed-in user for a state change: 401 without a session, 403 from elsewhere. */
async function signedIn(ctx: AppContext, req: Request): Promise<User | Response> {
  const user = await sessionUser(ctx.stores.metadata, req);
  if (!user) return reply({ error: "Sign in first." }, 401);
  return crossOrigin(ctx, req) ?? user;
}

/**
 * The signed-in user for a READ (audio-feed-6hw): 401 without a session, 403
 * from elsewhere. It cannot reuse `signedIn`'s Origin test, because browsers send
 * no Origin on a same-origin GET, so that test would refuse every real
 * discovery. The cross-site evidence that IS present is `Sec-Fetch-Site`, which a
 * page cannot set: `cross-site`/`same-site` is refused, `same-origin` is the
 * browser's own word for it. A request with NEITHER header is a non-browser
 * client (curl, tests) that no page can steer, so the session cookie is the whole
 * wall; an attacker page cannot strip the two headers the browser adds.
 */
async function readSignedIn(ctx: AppContext, req: Request): Promise<User | Response> {
  const user = await sessionUser(ctx.stores.metadata, req);
  if (!user) return reply({ error: "Sign in first." }, 401);
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    return reply({ error: "Cross-origin request refused." }, 403);
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== baseUrl(ctx, req)) {
    return reply({ error: "Cross-origin request refused." }, 403);
  }
  return user;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return {};
  const parsed = await req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function createAccountHandlers(ctx: AppContext, deps: AccountDeps): AccountHandlers {
  const store = ctx.stores.metadata;

  const signInResponse = async (user: User, status = 200) => {
    const secret = await createSession(store, user.id);
    return reply(
      { ok: true, displayName: user.displayName, isAdmin: user.isAdmin },
      status,
      { "set-cookie": sessionCookie(secret) },
    );
  };

  return {
    loginOptions: async ({ req }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      return reply(
        await authenticationOptions(
          store,
          relyingParty(baseUrl(ctx, req), ctx.config.webAuthnRpId),
        ),
      );
    },

    loginVerify: async ({ req }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      try {
        // deno-lint-ignore no-explicit-any
        const response = (await body(req)) as any;
        const user = await finishAuthentication(
          store,
          relyingParty(baseUrl(ctx, req), ctx.config.webAuthnRpId),
          response,
        );
        return await signInResponse(user);
      } catch (error) {
        if (error instanceof PasskeyError) return reply({ error: error.message }, error.status);
        throw error;
      }
    },

    registerOptions: async ({ req }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      const { setupToken } = await body(req);
      const rp = relyingParty(baseUrl(ctx, req), ctx.config.webAuthnRpId);
      let user: User | null;
      let token: string | undefined;
      if (typeof setupToken === "string" && setupToken) {
        const link = await peekSetupLink(store, setupToken);
        user = link ? await store.getUser(link.userId) : null;
        if (!user) {
          return reply({ error: "This setup link has already been used or has expired." }, 400);
        }
        token = setupToken;
      } else {
        // Adding another passkey from a signed-in session.
        user = await sessionUser(store, req);
        if (!user) return reply({ error: "Sign in first, or use a setup link." }, 401);
      }
      return reply({
        options: await registrationOptions(store, rp, user, token),
        user: { displayName: user.displayName, email: user.email },
      });
    },

    registerVerify: async ({ req }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      try {
        // deno-lint-ignore no-explicit-any
        const response = (await body(req)) as any;
        const user = await finishRegistration(
          store,
          relyingParty(baseUrl(ctx, req), ctx.config.webAuthnRpId),
          response,
        );
        // Already signed in as this user (adding a passkey): keep the session.
        const current = await sessionUser(store, req);
        if (current?.id === user.id) return reply({ ok: true }, 201);
        return await signInResponse(user, 201);
      } catch (error) {
        if (error instanceof PasskeyError) return reply({ error: error.message }, error.status);
        throw error;
      }
    },

    bootstrap: async ({ req, remoteAddr }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      const { adminToken, email } = await body(req);
      if (typeof adminToken !== "string" || !adminToken.trim()) {
        return reply({ error: "Admin token is required." }, 400);
      }
      if (typeof email !== "string" || !email.trim()) {
        return reply({ error: "Email is required." }, 400);
      }
      const normalised = normaliseEmail(email.trim());
      if (!isValidEmail(normalised)) {
        return reply({ error: "Valid email is required." }, 400);
      }
      const expected = ctx.config.adminToken;
      if (!expected) {
        return reply({ error: "ADMIN_TOKEN is not configured on this server." }, 503);
      }

      // audio-feed-bns: throttle failed admin auth attempts without locking out valid credentials
      const clientIp = extractClientIp(req, ctx.config.trustProxyHeaders ?? false, remoteAddr);
      const limiter = deps.adminAuthLimiter ?? getSharedAdminAuthLimiter();

      try {
        await requireAdminToken(adminToken.trim(), expected);
        limiter.reset(clientIp);
      } catch {
        // Token is invalid. Check if client IP is currently locked out.
        const lock = limiter.isLockedOut(clientIp);
        if (!lock.allowed) {
          const retryAfterSec = Math.max(1, Math.ceil(lock.resetMs / 1000));
          return reply(
            { error: "Too many failed admin authentication attempts. Please try again later." },
            429,
            { "retry-after": retryAfterSec.toString() },
          );
        }

        const fail = limiter.recordFailure(clientIp);
        const headers: Record<string, string> = {};
        if (!fail.allowed) {
          headers["retry-after"] = Math.max(1, Math.ceil(fail.resetMs / 1000)).toString();
        }
        return reply({ error: "Invalid admin token." }, 401, headers);
      }

      const existingUser = await getUserByEmail(store, normalised);
      if (existingUser) {
        // Paul's ruling (audio-feed-xw7): an account that already exists must NOT
        // be re-bootstrapped — do not silently promote, reinstate, or approve it.
        // Bootstrap is strictly for enrolling the initial admin account. Existing
        // accounts must sign in or be managed via the admin console / setup links.
        return reply(
          {
            error:
              "An account already exists for this email. Bootstrap cannot re-enroll or promote existing accounts.",
          },
          409,
        );
      }

      const created = await createUser(store, {
        email: normalised,
        isAdmin: true,
      });
      const user = await approveUser(store, created.id, "bootstrap");

      const { token: setupToken, expiresAt } = await issueSetupLink(store, user.id, "bootstrap");
      return reply({
        ok: true,
        setupToken,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          isAdmin: user.isAdmin,
        },
        expiresAt,
      });
    },

    logout: async ({ req }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      await endSession(store, req);
      const headers = { "set-cookie": clearSessionCookie() };
      // The header's sign-out is a plain form, so it works with scripting off.
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
        return new Response(null, {
          status: 303,
          headers: { ...NO_STORE, ...headers, location: "/" },
        });
      }
      return reply({ ok: true }, 200, headers);
    },

    profile: async ({ req }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      const { displayName, voice } = await body(req);
      if (displayName !== undefined && typeof displayName !== "string") {
        return reply({ error: "Display name must be text." }, 400);
      }
      if (typeof displayName === "string" && displayName.trim().length > 80) {
        return reply({ error: "Keep the display name under 80 characters." }, 400);
      }
      if (
        voice !== undefined && voice !== "" &&
        !(GEMINI_TTS_VOICES as readonly unknown[]).includes(voice)
      ) {
        return reply({ error: "Unknown voice." }, 400);
      }
      const updated = await updatePreferences(store, user.id, {
        displayName: displayName as string | undefined,
        voice: voice as string | undefined,
      });
      return reply({ displayName: updated.displayName, voice: updated.voice ?? null });
    },

    rotateToken: async ({ req }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      const updated = await rotateFeedToken(store, user.id);
      return reply({ feedToken: updated.feedToken });
    },

    addSource: async ({ req }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      // Subscribing queues synthesis, which is the part that costs money.
      if (user.status !== "approved") {
        return reply({ error: "Your account is waiting for approval." }, 403);
      }
      const input = await body(req);
      let feedUrl: string;
      try {
        feedUrl = articleUrl(String(input.feedUrl ?? "")).href;
      } catch (error) {
        const status = error instanceof IngestError ? error.status : 400;
        return reply({ error: "That does not look like a fetchable feed URL." }, status);
      }
      let modes: AudioMode[] | undefined;
      if (Array.isArray(input.modes)) {
        modes = input.modes.filter((m): m is AudioMode => isAudioMode(m));
        if (modes.length === 0) return reply({ error: "Choose direct, deepdive, or both." }, 400);
      }
      try {
        const { source, poll } = await subscribeToFeed(
          ctx,
          {
            userId: user.id,
            feedUrl,
            title: typeof input.title === "string" && input.title.trim()
              ? input.title.trim()
              : undefined,
            modes,
          },
          { transport: deps.feedTransport, fetchArticle: deps.fetchArticle, maxItems: 5 },
        );
        return reply({ source: { id: source.id, title: source.title }, poll }, 201);
      } catch (error) {
        return reply({ error: String((error as Error)?.message ?? error) }, 422);
      }
    },

    /**
     * Read-only feed discovery for the account page (audio-feed-6hw). It fetches
     * a page the SIGNED-IN person asked for, through the same guards as article
     * fetching (`articleUrl` + `publicLookup` + bounded read), and answers with
     * feed URLs only. Same session and same-origin wall as every sibling here:
     * without it a cross-site GET could make a signed-in browser read a page on
     * the attacker's behalf.
     */
    discoverFeed: async ({ req }) => {
      const user = await readSignedIn(ctx, req);
      if (user instanceof Response) return user;
      const target = new URL(req.url).searchParams.get("url") ?? "";
      try {
        const page = articleUrl(target);
        const found = await (deps.discoverFeeds ?? discoverFeedsOnPage)(page.href);
        // The helper already validates every candidate; this re-validates at the
        // boundary so a future seam cannot widen what a page reads back — the
        // check that matters is `articleUrl` (public http(s), no credentials or
        // odd port), not a scheme prefix.
        const feeds = (found.feeds ?? []).flatMap((feed) => {
          try {
            return [{ ...feed, url: articleUrl(feed.url).href }];
          } catch {
            return [];
          }
        });
        return reply({ url: found.url, title: found.title, feeds });
      } catch (error) {
        const status = error instanceof IngestError ? error.status : 400;
        const message = error instanceof IngestError
          ? error.message
          : "That does not look like a page to read feeds from.";
        return reply({ error: message }, status);
      }
    },

    deleteSource: async ({ req, params }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      return await deps.deleteUserSource(req, user.id, params.sourceId ?? "");
    },

    deletePasskey: async ({ req, params }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      // The last-passkey guard lives in the store, where the count and the
      // delete are one step; checking here first would race a second delete.
      const outcome = await store.deleteCredential(user.id, params.id ?? "");
      if (outcome === "missing") return reply({ error: "Unknown passkey." }, 404);
      if (outcome === "last") {
        return reply({ error: "This is your only passkey. Add another before removing it." }, 409);
      }
      return reply({ ok: true });
    },

    // Regenerating is TTS spend: owner only, approved only (audio-feed-ktn, audio-feed-6y9).
    regenerateEpisode: async ({ req, params }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      if (!isSynthesisAuthorized(user)) {
        return reply({ error: "Your account is not approved for audio." }, 403);
      }
      const episodeId = params.episodeId ?? "";
      const ep = await store.getEpisode(user.id, episodeId);
      if (!ep) {
        return reply({ error: "Unknown episode." }, 404);
      }
      // audio-feed-6y9: retry failed episodes or requeue ready episodes
      const queued = ep.status === "failed"
        ? await store.retryEpisode(user.id, episodeId)
        : await store.requeueEpisode(user.id, episodeId);
      return reply({ ok: true, queued: queued ? 1 : 0 });
    },

    regenerateOutdated: async ({ req }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      if (!isSynthesisAuthorized(user)) {
        return reply({ error: "Your account is not approved for audio." }, 403);
      }
      const b = await req.json().catch(() => ({})) as { scope?: unknown };
      const scope = b.scope === "failed" ? "failed" : b.scope === "all" ? "all" : "outdated";
      return reply({ ok: true, queued: await deps.regenerateOutdated(user.id, scope) });
    },
  };
}
