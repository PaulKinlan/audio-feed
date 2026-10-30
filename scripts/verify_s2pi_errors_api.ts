// audio-feed-byh4j: HISTORICAL — no suite executes or reads this script, so it is NOT evidence of current behaviour. Wire it into a suite or re-derive it before citing it.
/**
 * End-to-end verification of the observability API (audio-feed-s2pi / obs-1).
 *
 * Drives the REAL server (`bootstrap`), not a hand-built context, so this covers the parts a unit
 * test with an injected config cannot: that the routes are registered, and that the shared key
 * reaches the handler through the environment the way a deployment provides it. The key value is
 * never printed.
 *
 * Exits non-zero on any failed check.
 */

import { openStores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";

const BASE = "http://localhost";
const KEY = "verify-s2pi-key-not-a-real-secret";

// The deployment path: the key arrives in the environment and is read by loadConfig.
Deno.env.set("AUDIOFEED_OBSERVABILITY_KEY", KEY);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const stores = await openStores({ kvPath: ":memory:" });
const server = await bootstrap({
  port: 0,
  stores,
  isDeploy: true,
  synthesizer: null,
  inventory: false,
});
const authed = (path: string, key = KEY) =>
  server.fetch(new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } }));

try {
  // Seed through the store, as producers do.
  const seqs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const record = await stores.metadata.appendLog({
      time: new Date(Date.UTC(2026, 9, 11, 12, 0, i)).toISOString(),
      severity: i === 4 ? "warn" : "error",
      type: i === 4 ? "claim.lifecycle" : "synthesis.failed",
      message: `verify event ${i}`,
      process: "worker",
      correlationId: `corr-${i}`,
    });
    if (record) seqs.push(record.seq);
  }
  console.log(`seeded sequences ${seqs.join(", ")}\n`);

  // --- auth, through the real config path
  const anonymous = await server.fetch(new Request(`${BASE}/api/observability/errors`));
  check("anonymous request is refused", anonymous.status === 401, `status ${anonymous.status}`);
  check(
    "and told how to authenticate",
    (anonymous.headers.get("www-authenticate") ?? "").includes("Bearer"),
  );
  const wrong = await authed("/api/observability/errors", "wrong-key");
  check("a wrong key is refused", wrong.status === 401, `status ${wrong.status}`);

  // --- the cursor walk
  // The server records its own requests, so the walk sees more than the seeded events; the property
  // under test is that every seeded sequence appears exactly once, in order, with no duplicates.
  let cursor = "0";
  const seen: number[] = [];
  let pages = 0;
  let monotonic = true;
  for (;;) {
    const res = await authed(`/api/observability/errors?since=${cursor}&limit=2`);
    check(`page ${pages + 1} is served`, res.status === 200, `status ${res.status}`);
    const body = await res.json();
    for (const event of body.events) seen.push(event.seq);
    if (Number(body.cursor) < Number(cursor)) monotonic = false;
    cursor = body.cursor;
    pages++;
    console.log(
      `  page ${pages}: seqs [${body.events.map((e: { seq: number }) => e.seq).join(", ")}] ` +
        `cursor=${body.cursor} scanned=${body.scanned} returned=${body.returned} hasMore=${body.hasMore}`,
    );
    if (!body.hasMore) break;
    if (pages > 10) break;
  }
  const seededSeen = seen.filter((seq) => seqs.includes(seq));
  check(
    "the cursor walk saw every seeded event exactly once, in order",
    seededSeen.join(",") === seqs.join(",") && new Set(seen).size === seen.length,
  );
  check("and never moved backwards", monotonic);

  const idle = await (await authed(`/api/observability/errors?since=${cursor}`)).json();
  check(
    "a poll at the cursor returns nothing and keeps the cursor",
    idle.events.length === 0 && idle.cursor === cursor,
  );

  // --- summary: the cheap nothing-changed question
  const nothing = await (await authed(`/api/observability/summary?since=${cursor}`)).json();
  check("summary says nothing changed", nothing.total === 0, JSON.stringify(nothing.bySeverity));
  const everything = await (await authed("/api/observability/summary?since=0&severity=all")).json();
  const seededSeverities = everything.byType
    .filter((t: { type: string }) => t.type === "synthesis.failed" || t.type === "claim.lifecycle")
    .reduce((sum: number, t: { count: number }) => sum + t.count, 0);
  check(
    "summary counts what did change",
    seededSeverities === 5 && everything.bySeverity.error >= 4 && everything.bySeverity.warn >= 1,
    `seeded ${seededSeverities} in ${JSON.stringify(everything.byType)}`,
  );
  console.log(`  byType: ${JSON.stringify(everything.byType)}`);

  await stores.metadata.appendLog({
    time: new Date().toISOString(),
    severity: "error",
    type: "synthesis.failed",
    message: "after the summary",
    process: "worker",
  });
  const something = await (await authed(`/api/observability/summary?since=${cursor}`)).json();
  check("and reports something new afterwards", something.total === 1);
  check("with a cursor that moved", Number(something.cursor) > Number(cursor));

  // --- retention expiry is explicit
  await stores.metadata.pruneLogs(new Date());
  const after = await stores.metadata.logBounds();
  const expired = await authed("/api/observability/errors?since=0");
  const expiredBody = await expired.json();
  check(
    "a cursor retention has passed is refused, not skipped",
    expired.status === 410 && expiredBody.error === "cursor_too_old",
    `status ${expired.status} oldestRetained=${after.oldestSeq}`,
  );
  console.log(`  detail: ${expiredBody.detail}`);
  check(
    "and the summary refuses it identically",
    (await authed("/api/observability/summary?since=0")).status === 410,
  );

  // --- the key never reaches the store
  const serialised = JSON.stringify(await stores.metadata.listLogs());
  check("the shared key is never stored", !serialised.includes(KEY));
} finally {
  // shutdown() closes the store; closing it again is a BadResource.
  await server.shutdown();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED`);
Deno.exit(failures === 0 ? 0 : 1);
