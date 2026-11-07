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
import { MAX_ACCOUNT_BODY_BYTES, payloadTooLarge, readCappedJson } from "../http.ts";
export { MAX_ACCOUNT_BODY_BYTES, payloadTooLarge };
import {
  clearSessionCookie,
  createSession,
  endSession,
  issueSetupLink,
  peekSetupLink,
  sameOrigin,
  sameSiteRead,
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
  createAdminAuthLimiter,
  extractClientIp,
  type FailedAuthLimiter,
  SlidingWindowRateLimiter,
} from "../auth/rate_limit.ts";
import { subscribeToFeed } from "../ingest/feed.ts";
import { screenErrorForLogging } from "../observability/error_screen.ts";
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
 * The signed-in user for a READ (audio-feed-6hw): 401 without a session, 403 from
 * elsewhere. The wall itself is `sameSiteRead` (browsers send no Origin on a
 * same-origin GET, so the state-change `sameOrigin` test would refuse every real
 * read; `Sec-Fetch-Site` is the cross-site evidence that IS present).
 */
async function readSignedIn(ctx: AppContext, req: Request): Promise<User | Response> {
  const user = await sessionUser(ctx.stores.metadata, req);
  if (!user) return reply({ error: "Sign in first." }, 401);
  if (!sameSiteRead(req, baseUrl(ctx, req))) {
    return reply({ error: "Cross-origin request refused." }, 403);
  }
  return user;
}

/**
 * Per-address limit on the anonymous challenge write (audio-feed-plmhk).
 *
 * `loginOptions` is public by design — it is how a stranger starts signing in — and every
 * request it serves writes a KV challenge row (`authenticationOptions` -> `putChallenge`,
 * TTL 5 minutes, `CHALLENGE_TTL_MS`). The Origin wall refuses browser CSRF, not a direct
 * caller, who can send any Origin it likes, so nothing bounded how often one client could
 * spend those writes.
 *
 * The pattern is the one the `/listen` capability GETs use (audio-feed-l11jx): one
 * `SlidingWindowRateLimiter`, keyed on the client address, windowed in the shared store so the
 * bound holds across isolates, and checked BEFORE the handler mints a challenge. A refused
 * request therefore costs one rate-window write and no challenge row.
 *
 * The numbers:
 *
 * - 60 per 5 minutes = 12 a minute per address. A sign-in attempt needs exactly ONE challenge,
 *   and a person who closes the biometric prompt and retries needs two or three, so 20 people
 *   behind one address (a household, an office NAT) each trying three times still fits inside
 *   one window. It is the same quota as `LISTEN_PAGE_RATE`, deliberately: a sign-in attempt is a
 *   page-level action, not a poll.
 * - The window equals the challenge TTL (5 minutes), so one address can never hold more live
 *   challenge rows than the quota allows: the bound is 60 rows per address, written at most
 *   12 times a minute, instead of unbounded writes at line rate.
 * - Keyed on the ADDRESS and nothing else: an anonymous caller has no identity yet, so a
 *   per-token key would either not exist or be attacker-chosen. `extractClientIp` already maps
 *   clients with no usable address to `UNADDRESSED_CLIENT_KEY`, which the limiter gives its own
 *   deployment-sized bucket (audio-feed-0t8el) rather than one shared per-client quota.
 */
export const LOGIN_OPTIONS_RATE = { maxRequests: 60, windowMs: 5 * 60 * 1000 } as const;

/** The window's namespace, so it cannot swap rows with another limiter (audio-feed-2zvc). */
const LOGIN_OPTIONS_WINDOW = "login_options";

/**
 * The largest JSON body an account or ceremony route will read (audio-feed-81v7j).
 *
 * `loginVerify` and `registerOptions` are public and parse a body before any credential check,
 * so the cap is the only thing standing between a stranger and an arbitrary allocation. 16 KiB
 * is roughly ten times a real WebAuthn assertion (a clientDataJSON plus authenticator data and
 * signature is around a kilobyte) and comfortably holds a registration attestation carrying an
 * x5c certificate chain, so no genuine ceremony is anywhere near it, while an oversized body is
 * refused before it is buffered. The pattern is cwv.ts's (audio-feed-6q9g): a declared
 * `content-length` is a cheap fast path, and the read is bounded by construction.
 */
/**
 * Parse a JSON body, bounded by `MAX_ACCOUNT_BODY_BYTES` before anything is accumulated.
 *
 * Every caller here sends a small object — a setup link, a display name, a WebAuthn response — and
 * two of them (`loginVerify`, `registerOptions`) are public and parse before any credential check,
 * so the cap is applied at this one read rather than per route (audio-feed-81v7j). The refusal is
 * thrown as `HttpError`, which the router already turns into a response, so each call site keeps
 * its existing shape: a normal body is parsed exactly as before and an oversized one never is.
 */
const body = readCappedJson;

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
    loginOptions: async ({ req, remoteAddr }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      // BEFORE the challenge write (audio-feed-plmhk): see LOGIN_OPTIONS_RATE. The refusal is
      // prose rather than `problem()`'s machine title because the sign-in page's `post()` shows
      // `error` to the person verbatim (`PASSKEY_CLIENT`, src/routes/shell.ts) — every other
      // refusal in this file reads the same way — and it carries the `retry-after` header the
      // listen and cwv refusals use, so a client is told when the window opens again.
      const limit = await new SlidingWindowRateLimiter(
        LOGIN_OPTIONS_RATE,
        store,
        LOGIN_OPTIONS_WINDOW,
      ).check(extractClientIp(req, Boolean(ctx.config.trustProxyHeaders), remoteAddr));
      if (!limit.allowed) {
        return reply(
          {
            error: "Too many sign-in attempts from this network. Wait a few minutes and try again.",
          },
          429,
          { "retry-after": String(Math.max(1, Math.ceil(limit.resetMs / 1000))) },
        );
      }
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
      // Shared through the store, so this path and adminGate count against ONE
      // bound even on different isolates (audio-feed-2zvc).
      const limiter = deps.adminAuthLimiter ?? createAdminAuthLimiter(ctx.stores.metadata);

      try {
        await requireAdminToken(adminToken.trim(), expected);
        await limiter.reset(clientIp);
      } catch {
        // Token is invalid. Check if client IP is currently locked out.
        const lock = await limiter.isLockedOut(clientIp);
        if (!lock.allowed) {
          const retryAfterSec = Math.max(1, Math.ceil(lock.resetMs / 1000));
          return reply(
            { error: "Too many failed admin authentication attempts. Please try again later." },
            429,
            { "retry-after": retryAfterSec.toString() },
          );
        }

        const fail = await limiter.recordFailure(clientIp);
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
        // audio-feed-rt6q6: this response is read by the account holder, so its message must
        // be one this codebase wrote. An IngestError detail is authored for the user ("That
        // URL is not an RSS or Atom feed.") and is shown as-is — the same rule the sibling
        // discoverFeed handler below applies, and the same split bcf40e39 landed for the
        // /api/sources subscriber path. Anything else is a store, provider or transport
        // failure whose text can carry a store key, a bucket path or a provider message, so
        // it is screened into the log seam (the same screen src/server.ts applies to an
        // unhandled error) and answered with a fixed detail instead of the throw.
        if (error instanceof IngestError) {
          return reply({ error: error.message }, error.status ?? 422);
        }
        const screened = screenErrorForLogging(error);
        console.warn(
          `[audio-feed] source add failed for user ${user.id}: ${screened.message}`,
        );
        return reply({ error: "Could not subscribe to that feed." }, 502);
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
      // audio-feed-6y9: retry failed episodes or requeue ready episodes (audio-feed-1ib3: retry stale synthesizing claims)
      const queued = (ep.status === "failed" || ep.status === "synthesizing")
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
      // This route called `req.json()` directly before the cap existed, so it parses whatever the
      // content-type says: a header-less {"scope":"all"} still means "all" (audio-feed-3t01u).
      const b = (await readCappedJson(req, MAX_ACCOUNT_BODY_BYTES, {
        requireJsonContentType: false,
      })) as { scope?: unknown };
      const scope = b.scope === "failed" ? "failed" : b.scope === "all" ? "all" : "outdated";
      return reply({ ok: true, queued: await deps.regenerateOutdated(user.id, scope) });
    },
  };
}
