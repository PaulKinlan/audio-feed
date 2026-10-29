// audio-feed-byh4j: HISTORICAL — no suite executes or reads this script, so it is NOT evidence of current behaviour. Wire it into a suite or re-derive it before citing it.
/**
 * The P1 finding's own reproduction (audio-feed-pwu4), widened to every shape it names, driven
 * through the REAL app: openStores + bootstrap, the same path a request takes in production.
 *
 * It exists because the leak was found on that path and not by the unit test that was supposed to
 * cover it, twice: the first test asserted the shapes I had thought of, and the second asserted a
 * sanitiser's output. Neither is the property. The property is that the recorded `route` is a
 * REGISTERED PATTERN or a fixed marker, so no user-controlled byte can reach a record at all — and
 * that is what this asserts, over the full serialised store, for canonical, malformed, short-token,
 * mixed-case, encoded, no-trailing-segment, query-string and unmatched paths.
 *
 * Exits non-zero on any leak.
 */

import { openStores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";
import { UNMATCHED_ROUTE } from "../src/request_route.ts";

const TOKEN = "kR7fQ2mZ8pLx4Vn1Tb6Ys3Wd";
const SHORT = "abc";

const stores = await openStores({ kvPath: ":memory:" });
const app = await bootstrap({
  port: 0,
  stores,
  isDeploy: true,
  synthesizer: null,
  inventory: false,
});

const cases: [path: string, expected: string][] = [
  // canonical: the pattern itself, which is more useful than a path anyway
  [`/feed/${TOKEN}/master.xml`, "/feed/:token/master.xml"],
  [`/listen/${TOKEN}`, "/listen/:token"],
  [`/audio/${TOKEN}/x/y`, "/audio/:key+"],
  ["/account", "/account"],
  ["/", "/"],
  // the finding's case, and other malformed shapes
  [`/feed/${TOKEN}/master.xml/${TOKEN}`, UNMATCHED_ROUTE],
  [`/listen/${TOKEN}/extra`, UNMATCHED_ROUTE],
  // `/audio/:key+` matches any depth, so this is the pattern, not the marker: the route names the
  // shape that was served, and the capability in it is replaced by the pattern's own parameter.
  [`/audio/${TOKEN}/foo/bar`, "/audio/:key+"],
  [`/feed//${TOKEN}//master.xml`, UNMATCHED_ROUTE],
  [`/feed/${TOKEN}`, UNMATCHED_ROUTE],
  // a SHORT token behind a mixed-case prefix: what the fail-closed sanitiser let through
  [`/AUDIO/${SHORT}`, UNMATCHED_ROUTE],
  [`/Listen/${SHORT}/master.xml`, UNMATCHED_ROUTE],
  [`/Feed/${SHORT}/master.xml/${SHORT}`, UNMATCHED_ROUTE],
  [`/${SHORT}`, UNMATCHED_ROUTE],
  // encoded separators, once and twice
  [`/feed/${TOKEN}%2Fmore`, UNMATCHED_ROUTE],
  // URLPattern normalises a percent-encoded segment before matching it, so an encoded token still
  // matches the registered pattern — and the pattern is what gets recorded either way.
  [`/feed/${encodeURIComponent(TOKEN)}/master.xml`, "/feed/:token/master.xml"],
  [`/feed/${TOKEN}%252Fmore`, UNMATCHED_ROUTE],
  // query strings do not change the pathname the table matches
  [`/feed/${TOKEN}/master.xml?token=${TOKEN}`, "/feed/:token/master.xml"],
  [`/account?token=${TOKEN}`, "/account"],
  // unmatched
  ["/no/such/route", UNMATCHED_ROUTE],
  [`/${TOKEN}/anything`, UNMATCHED_ROUTE],
];

let failures = 0;
try {
  for (const [path, expected] of cases) {
    const res = await app.fetch(new Request(`http://localhost${path}`));
    const logs = await stores.metadata.listLogs();
    const record = logs[logs.length - 1];
    const route = record?.route ?? "<none>";
    const serialised = JSON.stringify(logs);

    // The expectation is stated per case, so a lookup that returned the marker for everything
    // (which is what happened to the first version of this fix) FAILS here instead of passing a
    // "nothing leaked" check while making the field useless.
    const routeIsPattern = route === expected;
    const tokenLeaked = serialised.includes(TOKEN) ||
      serialised.includes(encodeURIComponent(TOKEN)) ||
      serialised.includes(encodeURIComponent(TOKEN).toLowerCase());
    // A short lower-case token must not survive either, unless it is part of a registered pattern.
    const shortLeaked = !routeIsPattern && route.includes(SHORT);
    const ok = routeIsPattern && !tokenLeaked && !shortLeaked;
    if (!ok) failures++;

    // "leak" and "wrong pattern" are different outcomes and must not share a label: the first is a
    // security failure, the second is this script's expectation being stale.
    const verdict = tokenLeaked || shortLeaked ? "LEAK" : routeIsPattern ? "safe" : "ROUTE";
    console.log(
      `${verdict.padEnd(5)} ${String(res.status).padEnd(3)} route=${route.padEnd(28)} ${path}`,
    );
  }
} finally {
  await app.shutdown();
}

console.log(
  failures === 0
    ? "\nEvery recorded route is a registered pattern or the unmatched marker, and no stored record contains the capability in any shape."
    : `\n${failures} FAILURE(S)`,
);
Deno.exit(failures === 0 ? 0 : 1);

/**
 * Note on the `route` value: it is a constant from the route table, so the assertion above is a
 * structural guarantee rather than a sample. A path that matches no route records `<unmatched>`,
 * which is enough for an operator to see that something arrived that the app does not serve —
 * without the app having to decide whether any part of it was a secret.
 */
