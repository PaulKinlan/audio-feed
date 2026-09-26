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
import { rotateFeedToken, updatePreferences } from "../auth/users.ts";
import { subscribeToFeed } from "../ingest/feed.ts";
import { articleUrl, type ExtractedArticle, IngestError } from "../ingest/url.ts";
import { GEMINI_TTS_VOICES } from "../tts/gemini.ts";
import { type AudioMode, isAudioMode, isSynthesisAuthorized, type User } from "../types.ts";

export interface AccountHandlers {
  loginOptions: Handler<AppContext>;
  loginVerify: Handler<AppContext>;
  registerOptions: Handler<AppContext>;
  registerVerify: Handler<AppContext>;
  logout: Handler<AppContext>;
  profile: Handler<AppContext>;
  rotateToken: Handler<AppContext>;
  addSource: Handler<AppContext>;
  deleteSource: Handler<AppContext>;
  deletePasskey: Handler<AppContext>;
  regenerateEpisode: Handler<AppContext>;
  regenerateOutdated: Handler<AppContext>;
}

export interface AccountDeps {
  feedTransport?: (url: URL, signal: AbortSignal) => Promise<Response>;
  fetchArticle?: (url: string, signal?: AbortSignal) => Promise<ExtractedArticle>;
  /** compose.ts's shared source deletion, scoped to `userId`. */
  deleteUserSource: (req: Request, userId: string, sourceId: string) => Promise<Response>;
  /** compose.ts's shared regenerate, outdated scope; resolves the number queued. */
  regenerateOutdated: (userId: string) => Promise<number>;
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
      return reply(await authenticationOptions(store, relyingParty(baseUrl(ctx, req))));
    },

    loginVerify: async ({ req }) => {
      const refused = crossOrigin(ctx, req);
      if (refused) return refused;
      try {
        // deno-lint-ignore no-explicit-any
        const response = (await body(req)) as any;
        const user = await finishAuthentication(store, relyingParty(baseUrl(ctx, req)), response);
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
      const rp = relyingParty(baseUrl(ctx, req));
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
        const user = await finishRegistration(store, relyingParty(baseUrl(ctx, req)), response);
        // Already signed in as this user (adding a passkey): keep the session.
        const current = await sessionUser(store, req);
        if (current?.id === user.id) return reply({ ok: true }, 201);
        return await signInResponse(user, 201);
      } catch (error) {
        if (error instanceof PasskeyError) return reply({ error: error.message }, error.status);
        throw error;
      }
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

    // Regenerating is TTS spend: owner only, approved only (audio-feed-ktn).
    regenerateEpisode: async ({ req, params }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      if (!isSynthesisAuthorized(user)) {
        return reply({ error: "Your account is not approved for audio." }, 403);
      }
      const episodeId = params.episodeId ?? "";
      if (!(await store.getEpisode(user.id, episodeId))) {
        return reply({ error: "Unknown episode." }, 404);
      }
      // Idempotent: one already queued (or never published) queues nothing.
      const queued = await store.requeueEpisode(user.id, episodeId);
      return reply({ ok: true, queued: queued ? 1 : 0 });
    },

    regenerateOutdated: async ({ req }) => {
      const user = await signedIn(ctx, req);
      if (user instanceof Response) return user;
      if (!isSynthesisAuthorized(user)) {
        return reply({ error: "Your account is not approved for audio." }, 403);
      }
      return reply({ ok: true, queued: await deps.regenerateOutdated(user.id) });
    },
  };
}
