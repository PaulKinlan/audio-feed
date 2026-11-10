/**
 * audio-feed-hoodo — the authored-vs-screened rule, pinned on BOTH source-add paths.
 *
 * Two handlers answer a failed feed subscription for a person: `POST /api/sources`
 * (feed token, `src/compose/feeds.ts`) and `POST /api/account/sources` (session
 * cookie + same-origin, `src/routes/account_api.ts`). Each carries the same rule:
 *
 *   - an `IngestError` message is authored for the user, so it is shown as-is
 *     with the error's OWN status (never a hardcoded 422);
 *   - anything else is a store, provider or transport failure whose text can
 *     carry a store key, a bucket path or a provider message, so it is answered
 *     with fixed text and 502, and only the `screenErrorForLogging` version of
 *     it - a member of the closed phrase list, or SUPPRESSED_MESSAGE - reaches
 *     the log seam.
 *
 * WHY ONE FILE AND NOT ONE ROW PER SUITE: the two sites are not copies of each
 * other's work. They have different callers - a token request is refused 403 by
 * the account handler and a cookie request is refused 403 by the token handler -
 * so neither site can be deleted as "covered by the other". The risk is the RULE
 * drifting in one of them (the 422/502 split and the screen are two halves that
 * look right when separated), so every fixture below is driven through BOTH
 * routes and asserted at each. A site that loses the split, or loses the screen,
 * reds here by name.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { type ComposeDeps, createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { IngestError } from "../src/ingest/url.ts";
import { SUPPRESSED_MESSAGE } from "../src/observability/error_screen.ts";
import { makeUser } from "./fixtures.ts";

const BASE = "https://audio.example.com";
const CONFIG: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const FEED_URL = "https://example.com/feed.xml";
const TOKEN = "token-user-1";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Sample</title>
<link>https://example.com</link><item><title>Post 1</title>
<link>https://example.com/p1</link></item></channel></rss>`;

function app(deps: ComposeDeps = {}) {
  const stores: Stores = memoryStores();
  const ctx = { config: CONFIG, stores };
  const handlers = createHandlers(ctx, {
    feedTransport: () =>
      Promise.resolve(
        new Response(RSS, { headers: { "content-type": "application/rss+xml" } }),
      ),
    fetchArticle: (url) =>
      Promise.resolve({
        url,
        title: "Article",
        author: "A",
        publishedAt: null,
        lead: "Lead",
        body: "Body.",
      }),
    ...deps,
  });
  return { fetch: createApp(ctx, handlers).fetch, stores };
}

/**
 * The two source-add paths, as a caller reaches them. `request` mints the
 * credential for the path it names, so a fixture can be replayed unchanged.
 */
interface SourceAddPath {
  readonly name: string;
  /** The log label this path's own catch writes; it identifies which site answered. */
  readonly logLabel: string;
  readonly request: (stores: Stores) => Promise<Request>;
}

const PATHS: readonly SourceAddPath[] = [
  {
    name: "POST /api/sources (feed token, src/compose/feeds.ts)",
    logLabel: "subscribe failed for user user-1",
    request: () =>
      Promise.resolve(
        new Request(`${BASE}/api/sources`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-feed-token": TOKEN },
          body: JSON.stringify({ feedUrl: FEED_URL }),
        }),
      ),
  },
  {
    name: "POST /api/account/sources (session, src/routes/account_api.ts)",
    logLabel: "source add failed for user user-1",
    request: async (stores) =>
      new Request(`${BASE}/api/account/sources`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${await createSession(stores.metadata, "user-1")}`,
          origin: BASE,
        },
        body: JSON.stringify({ feedUrl: FEED_URL }),
      }),
  },
];

Deno.test("the two source-add paths have separate callers (audio-feed-hoodo)", async () => {
  // The premise of the row below: neither handler's catch can be deleted as
  // "covered by the sibling". Each route authenticates its own way and refuses
  // the other route's credential, so a caller exists that only one site serves.
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser());

  const cookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, "user-1")}`;
  const tokenOnAccountRoute = await fetch(
    new Request(`${BASE}/api/account/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-feed-token": TOKEN, origin: BASE },
      body: JSON.stringify({ feedUrl: FEED_URL }),
    }),
  );
  assertEquals(tokenOnAccountRoute.status, 401);

  const cookieOnTokenRoute = await fetch(
    new Request(`${BASE}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ feedUrl: FEED_URL }),
    }),
  );
  assertEquals(cookieOnTokenRoute.status, 403);
});

Deno.test("an authored feed error keeps its own message and status on both source-add paths (audio-feed-hoodo)", async () => {
  // Status 413, not the 422 the split falls back to and not the 502 the
  // screened branch answers: it can only come from `error.status`.
  const AUTHORED = "Feed exceeds the 2 MiB size limit.";
  for (const path of PATHS) {
    const { fetch, stores } = app({
      feedTransport: () => Promise.reject(new IngestError(413, AUTHORED)),
    });
    await stores.metadata.putUser(makeUser());

    const res = await fetch(await path.request(stores));
    const body = await res.json();
    assertEquals(res.status, 413, path.name);
    assertEquals(body.error, AUTHORED, path.name);
  }
});

Deno.test("a store failure is 502 with fixed text, and only a screened line reaches the log, on both paths (audio-feed-hoodo)", async () => {
  const STORE_MESSAGE =
    'kv put failed for ["source","user-1","stratechery"] at blob://audio-store/private-bucket';
  for (const path of PATHS) {
    const { fetch, stores } = app();
    await stores.metadata.putUser(makeUser());
    stores.metadata.putSource = () => Promise.reject(new Error(STORE_MESSAGE));

    const logged: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const res = await fetch(await path.request(stores));
      const text = await res.text();

      assertEquals(res.status, 502, path.name);
      assertEquals(JSON.parse(text).error, "Could not subscribe to that feed.", path.name);
      assert(
        !text.includes("private-bucket"),
        `${path.name}: store key text must not reach the caller`,
      );

      // The screen is the second half of the rule: answering fixed text while
      // logging the raw throw still ships the store key to stderr.
      const line = logged.find((entry) => entry.includes(path.logLabel));
      assert(
        line,
        `${path.name}: the failure must be logged by its own catch, got ${JSON.stringify(logged)}`,
      );
      assert(
        !line.includes("private-bucket"),
        `${path.name}: the raw store key must not reach the log seam`,
      );
      assertStringIncludes(line, SUPPRESSED_MESSAGE);
    } finally {
      console.warn = originalWarn;
    }
  }
});
