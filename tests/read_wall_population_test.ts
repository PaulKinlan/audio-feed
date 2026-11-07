/**
 * audio-feed-vfyte: the read wall's POPULATION, pinned against a hand-written classification.
 *
 * `sameSiteRead` (src/auth/sessions.ts:139) admits a cookie-authenticated request carrying NEITHER
 * `Sec-Fetch-Site` NOR `Origin`. A review rejected fail-closing that case as over-broad: a
 * cross-origin attacker cannot READ the response — the same-origin policy blocks the body — so
 * refusing absent-both on a pure read defends an attack that is not available while 403ing real
 * clients that send neither header (WebKit < 16.4 / iOS 15, in-app WKWebViews). That trade holds
 * ONLY while every route on the wall is a pure read, which is why the one route that did server-side
 * work, `/api/account/discover-feed`, left the wall for POST + `sameOrigin` (23782a1e).
 *
 * So the population is DERIVED here — route registrations from src/app.ts, handler key -> creator
 * from src/compose.ts, and the creators whose body calls a gate that applies `sameSiteRead` — and
 * every route it finds must appear in PURE_READS. A new gated route is red until someone classifies
 * it: a pure read goes in the list, a route with a side effect goes to `sameOrigin` instead.
 *
 * Limit: a creator enters the population only when its OWN body calls `adminGate` or `callerUserFor`.
 * A future helper that reaches `sameSiteRead` one hop further would not be seen, so this pins today's
 * two gates rather than the shape of a new one — check the gates, not just the route table.
 */
import { assertEquals } from "@std/assert";

/**
 * Hand-written, `${METHOD} ${path} ${creator}`. Every one of these returns data and does no server
 * work (no outbound fetch, no write, no billed synthesis) — that is the whole premise of admitting
 * an absent-header request, so a side-effecting route must never be added here.
 */
const PURE_READS = [
  "GET /api/episodes createListEpisodesHandler",
  "GET /api/admin/users createListUsersHandler",
  "GET /api/admin/users/:id/sources createAdminListUserSourcesHandler",
  "GET /api/admin/users/:id/episodes createAdminListUserEpisodesHandler",
  "GET /api/admin/stats createAdminStatsHandler",
  "GET /api/admin/outbox createListOutboxHandler",
];

Deno.test("audio-feed-vfyte: every sameSiteRead-gated route is a classified pure read", async () => {
  const read = (path: string) => Deno.readTextFile(new URL(path, import.meta.url));
  const [app, compose, admin, episodes] = await Promise.all([
    read("../src/app.ts"),
    read("../src/compose.ts"),
    read("../src/compose/admin.ts"),
    read("../src/compose/episodes.ts"),
  ]);

  // Gate helper -> the creators whose body calls it. adminGate applies sameSiteRead to SAFE methods
  // only (its writes use sameOrigin); callerUserFor applies it whenever the caller is a cookie.
  const gatedVia = new Map<string, string>();
  for (const [source, call] of [[admin, "adminGate("], [episodes, "callerUserFor("]] as const) {
    const creators = [...source.matchAll(/^export function (\w+)\(/gm)];
    creators.forEach((match, index) => {
      const body = source.slice(match.index, creators[index + 1]?.index ?? source.length);
      if (body.includes(call)) gatedVia.set(match[1]!, call);
    });
  }
  // Registrations are one `router.<method>(` each; the block runs to the next registration.
  const registrations = [...app.matchAll(/router\.(get|head|post|delete|put|patch)\(/g)].map(
    (match) => {
      const next = app.indexOf("router.", match.index + 1);
      const block = app.slice(match.index, next < 0 ? app.length : next);
      return {
        method: match[1]!.toUpperCase(),
        path: /"(\/[^"]+)"/.exec(block)?.[1] ?? "",
        handler: /handlers\.(\w+)/.exec(block)?.[1] ?? "",
      };
    },
  );
  const creatorOf = new Map(
    [...compose.matchAll(/^\s{4}(\w+): (create\w+)\(/gm)].map((m) => [m[1], m[2]] as const),
  );

  const derived: string[] = [];
  for (const route of registrations) {
    const creator = creatorOf.get(route.handler) ?? "";
    const gate = gatedVia.get(creator);
    if (!gate) continue;
    if (gate === "adminGate(" && route.method !== "GET" && route.method !== "HEAD") continue;
    derived.push(`${route.method} ${route.path} ${creator}`);
  }

  assertEquals(
    derived.sort(),
    [...PURE_READS].sort(),
    "the sameSiteRead-gated population changed: a pure read is pinned in PURE_READS, and a route " +
      "that does server-side work belongs on sameOrigin, never on this wall",
  );

  // The one route that did server-side work, pinned by method: a GET here would put an outbound
  // fetch back behind the read wall, which is exactly what 23782a1e removed.
  const discoverFeed = registrations.filter((r) => r.path === "/api/account/discover-feed").map(
    (r) => r.method,
  );
  assertEquals(discoverFeed, ["POST"], "discover-feed must stay POST behind the sameOrigin wall");
});
