/**
 * The invariant that would have caught every leak in this family at once (audio-feed-ao4s).
 *
 * Four times now, a client-chosen string reached the store through a field nobody had thought of as
 * request-derived: the path tail after a matched prefix (pwu4), a short token behind a mixed-case
 * prefix (pwu4 again), an oversized field bypassing a byte ceiling (a0gi), and the HTTP method
 * (ao4s). Each fix was correct and each was followed by another surface. The reason is structural:
 * shape-by-shape tests check the shapes the author imagined, and the arriving shape is chosen by the
 * attacker.
 *
 * So this test does not assert shapes at all. It fuzzes a canary through EVERY attacker-controlled
 * surface INDEPENDENTLY and asserts the canary appears NOWHERE in the full serialised store. Adding a
 * surface is one entry in `SURFACES`, which is the point: the guard grows with the app instead of
 * with the incident.
 *
 * Assume every one of these is attacker-controlled: method, path segment, query string, header value
 * (each header named separately, because a new header read by a handler is a new surface) and body.
 */

import { assert, assertEquals } from "@std/assert";
import { openStores, type Stores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";
import { SUPPRESSED_MESSAGE } from "../src/observability/error_screen.ts";

const BASE = "https://audio.example";
/** Long, mixed case, and containing a must-not-appear marker: nothing in the app resembles it. */
const CANARY = "qV7z52CapSECRETfd39Nd";

interface Surface {
  name: string;
  /** Build a request carrying the canary on this surface, for a matched and an unmatched path. */
  build(path: string): Request;
  /**
   * The HTTP status the application's router or handler must yield. Asserting this proves the request
   * reached the expected path instead of being short-circuited by a host-gate refusal.
   */
  expectedStatus: (path: string) => number;
  /**
   * True when the surface reaches the UNHANDLED-ERROR record. The router catches a handler throw and answers
   * 500, so this surface is answered rather than throwing out of the server - asserting a throw would assert
   * the wrong thing about this app (audio-feed-sw1r).
   */
  expectUnhandledError?: boolean;
  /**
   * Socket-level input, which arrives BESIDE the request rather than inside it and is therefore its
   * own surface: the client address a runtime hands the handler. Not inside `Request`, so a fuzz
   * over requests alone would never reach it.
   */
  info?: { remoteAddr?: { hostname?: string } };
}

// audio-feed-sw1r: the throwing surface below needs AUDIO_FEED_TEST_THROW=1, and the file needs a configured
// host: `isDeploy: true` with no PUBLIC_BASE_URL makes every request answer 500 `server_misconfigured` before
// any route runs (audio-feed-3k2d), so without it every surface here asserted the canary's absence from a
// REFUSAL record that contains no request text - and the anti-vacuity check passed, because a refusal IS a
// record. Both are set around the bootstrap call INSIDE app(), never at module scope: a module-scope
// `Deno.env.set` leaks into every other test file that shares this worker, and it did - server_bootstrap_test's
// ALLOWED_HOSTS tests failed in a full-suite gate because PUBLIC_BASE_URL was set for them too, so boot took
// the PUBLIC_BASE_URL path and never logged the ALLOWED_HOSTS line they assert.

const SURFACES: Surface[] = [
  {
    // A query string echoed into an unhandled error's message. Every other surface here is answered by a
    // handler; this one is thrown OUT of one, which is the only path that reaches the record the screen in
    // src/observability/error_screen.ts guards (audio-feed-sw1r).
    name: "query string inside an UNHANDLED error's message (/__test/throw)",
    build: () => new Request(`${BASE}/__test/throw?m=${CANARY}`),
    expectUnhandledError: true,
    expectedStatus: () => 500,
  },
  {
    // A custom Error.name containing attacker-chosen text (audio-feed-z1gs).
    name: "custom Error.name on an UNHANDLED error (/__test/throw?name=...)",
    build: () => new Request(`${BASE}/__test/throw?m=harmless&name=${CANARY}`),
    expectUnhandledError: true,
    expectedStatus: () => 500,
  },
  {
    name: "method",
    build: (path) => new Request(`${BASE}${path}`, { method: CANARY }),
    expectedStatus: (path) => path === "/account" ? 405 : 404,
  },
  {
    name: "method (lower-case spelling of a real one)",
    build: (path) => new Request(`${BASE}${path}`, { method: "get" }),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "path segment (positional capability: /listen/<canary>)",
    build: () => new Request(`${BASE}/listen/${CANARY}`),
    expectedStatus: () => 404,
  },
  {
    name: "path segment (unmatched tail)",
    build: () => new Request(`${BASE}/feed/${CANARY}/master.xml/${CANARY}`),
    expectedStatus: () => 404,
  },
  {
    name: "path segment (mixed-case prefix)",
    build: () => new Request(`${BASE}/AUDIO/${CANARY}`),
    expectedStatus: () => 404,
  },
  {
    name: "query string",
    build: (path) => new Request(`${BASE}${path}?token=${CANARY}&next=${CANARY}`),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "header: user-agent",
    build: (path) => new Request(`${BASE}${path}`, { headers: { "user-agent": CANARY } }),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "header: x-correlation-id (never adopted from a caller)",
    build: (path) => new Request(`${BASE}${path}`, { headers: { "x-correlation-id": CANARY } }),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "header: referer",
    build: (path) => new Request(`${BASE}${path}`, { headers: { referer: `${BASE}/${CANARY}` } }),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "header: cookie",
    build: (path) =>
      new Request(`${BASE}${path}`, { headers: { cookie: `audio-feed-token=${CANARY}` } }),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "header: x-forwarded-for",
    build: (path) => new Request(`${BASE}${path}`, { headers: { "x-forwarded-for": CANARY } }),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "header: content-type",
    build: (path) =>
      new Request(`${BASE}${path}`, { headers: { "content-type": `text/${CANARY}` } }),
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "client address (socket-level, arrives beside the request)",
    build: (path) => new Request(`${BASE}${path}`),
    info: { remoteAddr: { hostname: CANARY } },
    expectedStatus: (path) => path === "/account" ? 303 : 404,
  },
  {
    name: "body",
    build: (path) =>
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `${CANARY}@example.com`, token: CANARY, note: CANARY }),
      }),
    expectedStatus: (path) => path === "/account" ? 405 : 404,
  },
];

/** A path the router serves, so handlers run, and one it does not, so the 404 path runs. */
const PATHS = ["/account", "/no/such/route"];

/**
 * The REAL server, not `createApp`.
 *
 * `createApp` does not log at all — the request wrapper lives in `bootstrap` — so a surface test
 * driving `createApp` asserts absence over a store nobody writes to and passes without testing
 * anything. That is why each case below also asserts that records WERE produced: a leak test that
 * cannot fail is worse than no test, because it is counted as coverage.
 */
async function app(): Promise<{
  fetch: (
    r: Request,
    info?: { remoteAddr?: { hostname?: string } },
  ) => Promise<Response>;
  stores: Stores;
  close: () => Promise<void>;
}> {
  const stores = await openStores({ kvPath: ":memory:" });
  // Set for the DURATION OF BOOTSTRAP (the route table and the config are both built there) and restored
  // immediately, so no other file in this worker can observe them (audio-feed-sw1r).
  const restore = (name: string, prior: string | undefined) => {
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  };
  const priorThrow = Deno.env.get("AUDIO_FEED_TEST_THROW");
  const priorBase = Deno.env.get("PUBLIC_BASE_URL");
  Deno.env.set("AUDIO_FEED_TEST_THROW", "1");
  Deno.env.set("PUBLIC_BASE_URL", BASE);
  let server: Awaited<ReturnType<typeof bootstrap>>;
  try {
    server = await bootstrap({
      port: 0,
      stores,
      isDeploy: true,
      synthesizer: null,
      inventory: false,
    });
  } finally {
    restore("AUDIO_FEED_TEST_THROW", priorThrow);
    restore("PUBLIC_BASE_URL", priorBase);
  }
  return {
    fetch: async (r, info) => await server.fetch(r, info),
    stores,
    close: () => server.shutdown(),
  };
}

for (const surface of SURFACES) {
  for (const path of PATHS) {
    Deno.test(`no canary reaches the store from ${surface.name} (${path})`, async () => {
      const { fetch, stores, close } = await app();
      try {
        const res = await fetch(surface.build(path), surface.info);
        // Nothing may hang: a request is answered, not left open.
        assert(res.status >= 200 && res.status < 600, `answered with ${res.status}`);
        if (surface.expectUnhandledError) {
          // The throw is caught by the ROUTER and answered 500, so about this surface the response says only
          // that the failure was answered - the record assertions below carry the weight.
          assertEquals(res.status, 500);
        }
        // Handlers may append without the request waiting; give those appends a bounded moment.
        await new Promise((resolve) => setTimeout(resolve, 25));
        const records = await stores.metadata.listLogs();
        // ANTI-VACUITY: the request must actually have been recorded, or the absence of the canary
        // below means nothing. This is the assertion that caught this very test driving an app with
        // no logging wrapper at all.
        const reqRecord = records.find((r) => r.type === "http.request");
        assert(
          reqRecord,
          `the request itself must be recorded (got ${records.length} record(s))`,
        );

        // ANTI-VACUITY (PATH): ensure we didn't just hit the host-gate refusal (which yields 500
        // before any handler runs) or some other pre-handler abort. By asserting the exact status
        // the target handler produces, we prove the request reached the expected handler, not just
        // a side effect that a gate produced (audio-feed-cv6z).
        assertEquals(
          res.status,
          surface.expectedStatus(path),
          `Expected the handler to run and yield ${
            surface.expectedStatus(path)
          }, but got ${res.status}. Did the host-gate refusal short-circuit the path?`,
        );
        const serialised = JSON.stringify(records);
        assert(
          !serialised.includes(CANARY),
          `the canary reached ${records.length} record(s) from ${surface.name}: ` +
            serialised.slice(
              Math.max(0, serialised.indexOf(CANARY) - 120),
              serialised.indexOf(CANARY) + 60,
            ),
        );
        // Encoded, because a surface could be stored after decoding.
        assert(
          !serialised.includes(encodeURIComponent(CANARY)),
          `the encoded canary reached the store from ${surface.name}`,
        );
        if (surface.expectUnhandledError) {
          // ANTI-VACUITY FOR THE FIELD ITSELF (audio-feed-sw1r): the canary's absence above is worth nothing
          // if the unhandled-error record was never written. This asserts the record EXISTS and that the
          // message field it carries is the screen's own output - so removing the screen fails THIS test
          // rather than quietly widening what is stored.
          const unhandled = records.find((r) => JSON.stringify(r).includes("unhandled "));
          assert(
            unhandled,
            `the unhandled-error record must be written for this surface (got ${
              records.map((r) => r.type).join(", ") || "no records"
            })`,
          );
          const recorded = JSON.parse(JSON.stringify(unhandled)) as {
            context?: { error?: string; errorMessage?: string };
          };
          assertEquals(
            recorded.context?.errorMessage,
            SUPPRESSED_MESSAGE,
            "the stored message must be the SCREENED value, not the thrown text",
          );
          assertEquals(
            recorded.context?.error,
            "Error",
            "the stored error class must be screened to a closed set, not an arbitrary Error.name (audio-feed-z1gs)",
          );
        }
      } finally {
        await close();
      }
    });
  }
}

Deno.test("a method this app cannot serve is recorded as a constant, not echoed (audio-feed-ao4s)", async () => {
  // The finding's own case, asserted on the field rather than only on the canary's absence, so the
  // record stays meaningful instead of merely safe.
  const first = await app();
  try {
    const res = await first.fetch(new Request(`${BASE}/account`, { method: CANARY }));
    assertEquals(
      res.status,
      405,
      "Expected path to be handled and yield 405, but got " + res.status +
        " (did host-gate refusal run?)",
    );
    const record = (await first.stores.metadata.listLogs()).find((r) => r.type === "http.request");
    assert(record, "the request was recorded");
    assertEquals(record.context?.method, "<other>");
    assert(
      record.message.startsWith("<other> "),
      `the message names the normalised method: ${record.message}`,
    );
  } finally {
    await first.close();
  }
  // A method the app DOES serve keeps its literal, so the field is still useful.
  const second = await app();
  let postedContext: Record<string, unknown> | undefined;
  try {
    const res2 = await second.fetch(new Request(`${BASE}/account`, { method: "POST" }));
    assertEquals(
      res2.status,
      405,
      "Expected path to be handled and yield 405, but got " + res2.status +
        " (did host-gate refusal run?)",
    );
    postedContext = (await second.stores.metadata.listLogs())
      .find((r) => r.type === "http.request")?.context;
  } finally {
    await second.close();
  }
  assertEquals(postedContext?.method, "POST");
});
