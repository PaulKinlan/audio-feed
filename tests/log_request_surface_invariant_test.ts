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

const BASE = "https://audio.example";
/** Long, mixed case, and containing a must-not-appear marker: nothing in the app resembles it. */
const CANARY = "qV7z52CapSECRETfd39Nd";

interface Surface {
  name: string;
  /** Build a request carrying the canary on this surface, for a matched and an unmatched path. */
  build(path: string): Request;
}

const SURFACES: Surface[] = [
  {
    name: "method",
    build: (path) => new Request(`${BASE}${path}`, { method: CANARY }),
  },
  {
    name: "method (lower-case spelling of a real one)",
    build: (path) => new Request(`${BASE}${path}`, { method: "get" }),
  },
  {
    name: "path segment (positional capability: /listen/<canary>)",
    build: () => new Request(`${BASE}/listen/${CANARY}`),
  },
  {
    name: "path segment (unmatched tail)",
    build: () => new Request(`${BASE}/feed/${CANARY}/master.xml/${CANARY}`),
  },
  {
    name: "path segment (mixed-case prefix)",
    build: () => new Request(`${BASE}/AUDIO/${CANARY}`),
  },
  {
    name: "query string",
    build: (path) => new Request(`${BASE}${path}?token=${CANARY}&next=${CANARY}`),
  },
  {
    name: "header: user-agent",
    build: (path) => new Request(`${BASE}${path}`, { headers: { "user-agent": CANARY } }),
  },
  {
    name: "header: x-correlation-id (never adopted from a caller)",
    build: (path) => new Request(`${BASE}${path}`, { headers: { "x-correlation-id": CANARY } }),
  },
  {
    name: "header: referer",
    build: (path) => new Request(`${BASE}${path}`, { headers: { referer: `${BASE}/${CANARY}` } }),
  },
  {
    name: "header: cookie",
    build: (path) =>
      new Request(`${BASE}${path}`, { headers: { cookie: `audio-feed-token=${CANARY}` } }),
  },
  {
    name: "header: x-forwarded-for",
    build: (path) => new Request(`${BASE}${path}`, { headers: { "x-forwarded-for": CANARY } }),
  },
  {
    name: "header: content-type",
    build: (path) =>
      new Request(`${BASE}${path}`, { headers: { "content-type": `text/${CANARY}` } }),
  },
  {
    name: "body",
    build: (path) =>
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `${CANARY}@example.com`, token: CANARY, note: CANARY }),
      }),
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
  fetch: (r: Request) => Promise<Response>;
  stores: Stores;
  close: () => Promise<void>;
}> {
  const stores = await openStores({ kvPath: ":memory:" });
  const server = await bootstrap({
    port: 0,
    stores,
    isDeploy: true,
    synthesizer: null,
    inventory: false,
  });
  return { fetch: async (r) => await server.fetch(r), stores, close: () => server.shutdown() };
}

for (const surface of SURFACES) {
  for (const path of PATHS) {
    Deno.test(`no canary reaches the store from ${surface.name} (${path})`, async () => {
      const { fetch, stores, close } = await app();
      try {
        const res = await fetch(surface.build(path));
        // Nothing may hang: a request is answered, not left open.
        assert(res.status >= 200 && res.status < 600, `answered with ${res.status}`);
        // Handlers may append without the request waiting; give those appends a bounded moment.
        await new Promise((resolve) => setTimeout(resolve, 25));
        const records = await stores.metadata.listLogs();
        // ANTI-VACUITY: the request must actually have been recorded, or the absence of the canary
        // below means nothing. This is the assertion that caught this very test driving an app with
        // no logging wrapper at all.
        assert(
          records.some((r) => r.type === "http.request"),
          `the request itself must be recorded (got ${records.length} record(s))`,
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
    await first.fetch(new Request(`${BASE}/account`, { method: CANARY }));
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
    await second.fetch(new Request(`${BASE}/account`, { method: "POST" }));
    postedContext = (await second.stores.metadata.listLogs())
      .find((r) => r.type === "http.request")?.context;
  } finally {
    await second.close();
  }
  assertEquals(postedContext?.method, "POST");
});
