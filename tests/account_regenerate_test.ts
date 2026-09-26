/**
 * Self-service Regenerate on /account (audio-feed-ktn).
 *
 * 8oz built regenerate for admins. These pin the user-scoped routes: session
 * auth, owner only, behind the approval gate (regenerating is TTS spend), and
 * the Origin check every cookie-authenticated write gets.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { computePromptVersion, PROMPT_VERSION } from "../src/tts/prompt_version.ts";
import { buildNarrationSystemPrompt } from "../src/tts/gemini.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { Episode, User } from "../src/types.ts";

const BASE = "https://audio.example.com";
const EVIL = "https://evil.example";

async function setup(status: User["status"] = "approved") {
  const stores: Stores = memoryStores();
  const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
  const me = makeUser({ id: "user-1", email: "me@example.com", status });
  const other = makeUser({ id: "user-2", email: "other@example.com" });
  await stores.metadata.putUser(me);
  await stores.metadata.putUser(other);
  await stores.metadata.putSource(makeSource({ id: "src-a", userId: me.id, title: "Src A" }));
  const episode = (id: string, extra: Partial<Episode> = {}) =>
    stores.metadata.putEpisode(
      makeEpisode({
        id,
        userId: me.id,
        sourceId: "src-a",
        audioKey: `audio/user-1/direct/${id}.wav`,
        contentType: "audio/wav",
        promptVersion: "old-prompts",
        ...extra,
      }),
    );
  await episode("ep-old-1", { createdAt: "2026-09-10T08:10:00.000Z" });
  await episode("ep-old-2", { createdAt: "2026-09-10T08:11:00.000Z" });
  await episode("ep-current", {
    createdAt: "2026-09-10T08:12:00.000Z",
    promptVersion: PROMPT_VERSION,
  });
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const cookie = async (userId: string) =>
    `${SESSION_COOKIE}=${await createSession(stores.metadata, userId)}`;
  const post = (path: string, opts: { cookie?: string; origin?: string | null } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
    return fetch(new Request(`${BASE}${path}`, { method: "POST", headers, body: "{}" }));
  };
  const regenerating = async (id: string) =>
    !!(await stores.metadata.getEpisode(me.id, id))?.regenerating;
  return { fetch, stores, me, other, cookie, post, regenerating };
}

Deno.test("account regenerate: the owner regenerates one of their episodes (audio-feed-ktn)", async () => {
  const t = await setup();
  const res = await t.post("/api/account/episodes/ep-old-1/regenerate", {
    cookie: await t.cookie(t.me.id),
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).queued, 1);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assert(await t.regenerating("ep-old-1"));
  assert(!(await t.regenerating("ep-old-2")), "only the one asked for");
});

Deno.test("account regenerate: the owner regenerates their outdated episodes only (audio-feed-ktn)", async () => {
  const t = await setup();
  const res = await t.post("/api/account/regenerate", { cookie: await t.cookie(t.me.id) });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).queued, 2);
  assert(await t.regenerating("ep-old-1"));
  assert(await t.regenerating("ep-old-2"));
  assert(!(await t.regenerating("ep-current")), "current prompts are not re-spent");
});

Deno.test("account regenerate: another user cannot regenerate your episode (audio-feed-ktn)", async () => {
  const t = await setup();
  const cookie = await t.cookie(t.other.id);
  const one = await t.post("/api/account/episodes/ep-old-1/regenerate", { cookie });
  assertEquals(one.status, 404);
  const all = await t.post("/api/account/regenerate", { cookie });
  assertEquals(all.status, 200);
  assertEquals((await all.json()).queued, 0, "their own feed, which has nothing");
  assert(!(await t.regenerating("ep-old-1")));
  assert(!(await t.regenerating("ep-old-2")));
});

Deno.test("account regenerate: an unapproved user is refused, nothing queued (audio-feed-ktn)", async () => {
  for (const status of ["pending", "suspended", "rejected"] as const) {
    const t = await setup(status);
    const cookie = await t.cookie(t.me.id);
    assertEquals(
      (await t.post("/api/account/episodes/ep-old-1/regenerate", { cookie })).status,
      403,
      status,
    );
    assertEquals((await t.post("/api/account/regenerate", { cookie })).status, 403, status);
    assert(!(await t.regenerating("ep-old-1")), status);
  }
});

Deno.test("account regenerate: a missing or foreign Origin, or no session, is refused (audio-feed-ktn)", async () => {
  const t = await setup();
  const cookie = await t.cookie(t.me.id);
  for (const path of ["/api/account/episodes/ep-old-1/regenerate", "/api/account/regenerate"]) {
    for (const origin of [null, EVIL]) {
      assertEquals((await t.post(path, { cookie, origin })).status, 403, `${path} ${origin}`);
    }
    assertEquals((await t.post(path)).status, 401, `${path} signed out`);
  }
  assert(!(await t.regenerating("ep-old-1")));
});

Deno.test("GET /account offers Regenerate per episode and for the outdated count, approved users only (audio-feed-ktn)", async () => {
  const t = await setup();
  const res = await t.fetch(
    new Request(`${BASE}/account`, { headers: { cookie: await t.cookie(t.me.id) } }),
  );
  const html = await res.text();
  assertStringIncludes(html, 'data-regenerate-episode="ep-old-1"');
  assertStringIncludes(html, 'data-regenerate-episode="ep-current"');
  assertStringIncludes(html, 'id="regenOutdated"');
  assertStringIncludes(html, 'data-count="2"');
  assertStringIncludes(html, "Regenerate outdated (2)");

  // A pending user cannot spend on synthesis, so is offered nothing to press.
  const pending = await setup("pending");
  const pendingHtml = await (await pending.fetch(
    new Request(`${BASE}/account`, { headers: { cookie: await pending.cookie(pending.me.id) } }),
  )).text();
  assertEquals(pendingHtml.includes("data-regenerate-episode="), false);
  assertEquals(pendingHtml.includes('id="regenOutdated"'), false);
});

Deno.test("promptVersion moves when code-block handling or the system prompt changes (audio-feed-ktn)", async () => {
  assertNotEquals(
    await computePromptVersion({ formatCodeForTts: (text: string) => Promise.resolve(text) }),
    PROMPT_VERSION,
    "the code-block formatter is part of the prompt",
  );
  assertNotEquals(
    await computePromptVersion({
      buildNarrationSystemPrompt: (mode) => `Be brief. ${buildNarrationSystemPrompt(mode)}`,
    }),
    PROMPT_VERSION,
    "the narration system prompt is part of the prompt",
  );
});
