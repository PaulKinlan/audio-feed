/**
 * Account Morning Briefing API routes (Issue #50):
 *   - `GET  /api/account/briefing`          — pure read (session + sameSiteRead): returns
 *     current briefing preferences and eligible recent unread article counts.
 *   - `POST /api/account/briefing`          — state change (session + strict sameOrigin):
 *     validates and updates `schedule`, `hourUtc`, `mode`, `maxArticles`.
 *   - `POST /api/account/briefing/generate` — billed synthesis trigger (session + strict
 *     sameOrigin + approved user + per-subscriber sliding-window rate limit): generates an
 *     on-demand daily or weekly briefing and triggers synthesis.
 */

import type { AppContext } from "../app.ts";
import { SlidingWindowRateLimiter } from "../auth/rate_limit.ts";
import { sameOrigin, sameSiteRead, sessionUser } from "../auth/sessions.ts";
import { MAX_ACCOUNT_BODY_BYTES, payloadTooLarge, readBoundedBody } from "../http.ts";
import { resolveOrigin } from "../origin.ts";
import type { Handler } from "../router.ts";
import {
  type AudioMode,
  isAudioMode,
  isSynthesisAuthorized,
  type User,
} from "../types.ts";
import {
  countEligibleBriefingArticles,
  generateUserBriefing,
  MAX_BRIEFING_ARTICLES,
  MIN_BRIEFING_ARTICLES,
  parseBriefingPreferencesPatch,
  resolveBriefingPreferences,
} from "../worker/briefing.ts";

/** Per-subscriber sliding-window cap on on-demand briefing generation requests. */
export const BRIEFING_GENERATE_RATE = {
  maxRequests: 6,
  windowMs: 60 * 60 * 1000,
} as const;

/** Dedicated rate-limiter namespace so rows cannot collide with other limiters. */
export const BRIEFING_GENERATE_WINDOW = "briefing_generate";

/** Machine-readable bound name reported in 429 responses. */
export const BRIEFING_GENERATE_BOUND = "briefing_generate_per_user";

export interface BriefingHandlers {
  get: Handler<AppContext>;
  update: Handler<AppContext>;
  generate: Handler<AppContext>;
}

export interface BriefingApiDeps {
  now?: () => Date;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  onWarn?: (message: string) => void;
}

const PRIVATE_NO_STORE = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex",
} as const;

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...PRIVATE_NO_STORE, ...headers } });
}

function baseUrl(ctx: AppContext, req: Request): string {
  return resolveOrigin(ctx.config, req).baseUrl;
}

async function signedInForWrite(ctx: AppContext, req: Request): Promise<User | Response> {
  const user = await sessionUser(ctx.stores.metadata, req);
  if (!user) return reply({ error: "Sign in first." }, 401);
  if (!sameOrigin(req, baseUrl(ctx, req))) {
    return reply({ error: "Cross-origin request refused." }, 403);
  }
  return user;
}

async function parseBoundedJsonObject(
  req: Request,
  opts: { allowEmpty: boolean },
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; response: Response }> {
  const raw = await readBoundedBody(req, MAX_ACCOUNT_BODY_BYTES);
  if (!raw.ok) {
    if (raw.status === 413) {
      const res = payloadTooLarge(
        `Briefing request body exceeds the ${MAX_ACCOUNT_BODY_BYTES}-byte limit.`,
      );
      res.headers.set("cache-control", "private, no-store");
      res.headers.set("x-robots-tag", "noindex");
      return { ok: false, response: res };
    }
    return { ok: false, response: reply({ error: "Could not read request body." }, 400) };
  }

  const trimmed = raw.text.trim();
  if (!trimmed) {
    return opts.allowEmpty
      ? { ok: true, data: {} }
      : { ok: false, response: reply({ error: "JSON request body is required." }, 400) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, response: reply({ error: "Malformed JSON body." }, 400) };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: reply({ error: "JSON body must be an object." }, 400) };
  }

  return { ok: true, data: parsed as Record<string, unknown> };
}

export function createBriefingHandlers(deps: BriefingApiDeps = {}): BriefingHandlers {
  const clock = deps.now ?? (() => new Date());

  return {
    /** `GET /api/account/briefing` — pure read of preferences + eligible recent article count. */
    get: async ({ ctx, req }) => {
      const store = ctx.stores.metadata;
      const user = await sessionUser(store, req);
      if (!user) return reply({ error: "Sign in first." }, 401);
      if (!sameSiteRead(req, baseUrl(ctx, req))) {
        return reply({ error: "Cross-origin request refused." }, 403);
      }

      const briefing = resolveBriefingPreferences(user.briefing);
      const activeWindow: "daily" | "weekly" = briefing.schedule === "weekly" ? "weekly" : "daily";
      const { dailyCount, weeklyCount } = await countEligibleBriefingArticles(
        store,
        user.id,
        clock(),
      );

      return reply({
        briefing,
        window: activeWindow,
        eligibleArticleCount: activeWindow === "weekly" ? weeklyCount : dailyCount,
        dailyArticleCount: dailyCount,
        weeklyArticleCount: weeklyCount,
      });
    },

    /** `POST /api/account/briefing` — update briefing schedule/hour/mode/maxArticles. */
    update: async ({ ctx, req }) => {
      const userOrErr = await signedInForWrite(ctx, req);
      if (userOrErr instanceof Response) return userOrErr;
      const user = userOrErr;

      const body = await parseBoundedJsonObject(req, { allowEmpty: false });
      if (!body.ok) return body.response;

      const current = resolveBriefingPreferences(user.briefing);
      const validated = parseBriefingPreferencesPatch(body.data, current);
      if (!validated.ok) {
        return reply({ error: validated.error }, 400);
      }

      const store = ctx.stores.metadata;
      const latest = (await store.getUser(user.id)) ?? user;
      const nextBriefing = {
        ...validated.value,
        ...(latest.briefing?.lastGeneratedDate
          ? { lastGeneratedDate: latest.briefing.lastGeneratedDate }
          : {}),
      };
      await store.putUser({ ...latest, briefing: nextBriefing });

      return reply({ ok: true, briefing: nextBriefing });
    },

    /** `POST /api/account/briefing/generate` — trigger an on-demand Morning Briefing. */
    generate: async ({ ctx, req }) => {
      const userOrErr = await signedInForWrite(ctx, req);
      if (userOrErr instanceof Response) return userOrErr;
      const user = userOrErr;

      if (!isSynthesisAuthorized(user)) {
        return reply({ error: "Your account is not approved for audio." }, 403);
      }

      const store = ctx.stores.metadata;
      const limit = await new SlidingWindowRateLimiter(
        BRIEFING_GENERATE_RATE,
        store,
        BRIEFING_GENERATE_WINDOW,
      ).check(user.id);
      if (!limit.allowed) {
        return reply(
          {
            error: "Too many briefing generation requests. Please wait before trying again.",
            bound: BRIEFING_GENERATE_BOUND,
            limit: BRIEFING_GENERATE_RATE.maxRequests,
            windowMs: BRIEFING_GENERATE_RATE.windowMs,
          },
          429,
          { "retry-after": String(Math.max(1, Math.ceil(limit.resetMs / 1000))) },
        );
      }

      const body = await parseBoundedJsonObject(req, { allowEmpty: true });
      if (!body.ok) return body.response;
      const input = body.data;

      let schedule: "daily" | "weekly" | undefined;
      if (input.schedule !== undefined) {
        if (input.schedule !== "daily" && input.schedule !== "weekly") {
          return reply({ error: 'Schedule override must be "daily" or "weekly".' }, 400);
        }
        schedule = input.schedule;
      }

      let mode: AudioMode | undefined;
      if (input.mode !== undefined) {
        if (!isAudioMode(input.mode)) {
          return reply({ error: 'Mode override must be "direct" or "deepdive".' }, 400);
        }
        mode = input.mode;
      }

      let maxArticles: number | undefined;
      if (input.maxArticles !== undefined) {
        if (
          typeof input.maxArticles !== "number" ||
          !Number.isInteger(input.maxArticles) ||
          input.maxArticles < MIN_BRIEFING_ARTICLES ||
          input.maxArticles > MAX_BRIEFING_ARTICLES
        ) {
          return reply(
            {
              error:
                `Max articles must be an integer between ${MIN_BRIEFING_ARTICLES} and ${MAX_BRIEFING_ARTICLES}.`,
            },
            400,
          );
        }
        maxArticles = input.maxArticles;
      }

      let force: boolean | undefined;
      if (input.force !== undefined) {
        if (typeof input.force !== "boolean") {
          return reply({ error: "Force flag must be a boolean." }, 400);
        }
        force = input.force;
      }

      const outcome = await generateUserBriefing(ctx, user.id, {
        schedule,
        mode,
        maxArticles,
        force,
        now: clock(),
        fetchFn: deps.fetchFn,
        timeoutMs: deps.timeoutMs,
        model: deps.model,
        onWarn: deps.onWarn,
      });

      const statusCode = outcome.status === "queued" ? 202 : 200;
      return reply(
        {
          status: outcome.status,
          ...(outcome.episodeId ? { episodeId: outcome.episodeId } : {}),
          ...(outcome.articleId ? { articleId: outcome.articleId } : {}),
          articleCount: outcome.articleCount,
          dateKey: outcome.dateKey,
          schedule: outcome.schedule,
        },
        statusCode,
      );
    },
  };
}

const defaultBriefingHandlers = createBriefingHandlers();

export const handleGetBriefing: Handler<AppContext> = defaultBriefingHandlers.get;
export const handleUpdateBriefing: Handler<AppContext> = defaultBriefingHandlers.update;
export const handleGenerateBriefing: Handler<AppContext> = defaultBriefingHandlers.generate;
