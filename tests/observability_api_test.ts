/**
 * The authenticated errors API (audio-feed-s2pi / obs-1).
 *
 * The properties that matter here are the ones an errors feed cannot be wrong about: a cursor that
 * is monotonic and survives a restart, an explicit answer when retention has moved past a cursor
 * rather than a silent skip, a cheap "nothing changed", and a key that is never served to someone
 * who does not have it.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores, openStores, type Stores } from "../src/config.ts";
import { normaliseRequestHost, OTHER_HOST } from "../src/http.ts";
import { MAX_LIMIT } from "../src/routes/observability.ts";
import { bootstrap } from "../src/server.ts";
import { abandonedClaimEvent, claimLifecycleEvent } from "../src/storage/episode_events.ts";
import type { LogSeverity } from "../src/storage/mod.ts";
import { makeEpisode } from "./fixtures.ts";

const BASE = "https://audio.example";
const KEY = "observability-key-under-test";

/**
 * `key` is explicitly nullable rather than optional: a default parameter also applies when the
 * caller passes `undefined`, so "not configured" has to be a distinct value or the test that
 * asserts the closed endpoint silently configures it and passes for the wrong reason.
 */
function app(stores: Stores = memoryStores(), key: string | null = KEY) {
  const config = {
    port: 8000,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    ...(key === null ? {} : { observabilityKey: key }),
  };
  const ctx = { config, stores };
  return { fetch: createApp(ctx, createHandlers(ctx)).fetch, stores };
}

/** A request carrying the key, which is how a poller authenticates. */
function authed(path: string, key = KEY): Request {
  return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } });
}

let counter = 0;
async function seed(
  stores: Stores,
  count: number,
  severity: LogSeverity = "error",
  type = "synthesis.failed",
): Promise<number[]> {
  const seqs: number[] = [];
  for (let i = 0; i < count; i++) {
    counter++;
    const record = await stores.metadata.appendLog({
      time: new Date(Date.UTC(2026, 9, 11, 12, 0, counter)).toISOString(),
      severity,
      type,
      message: `seeded event ${counter}`,
      process: "worker",
      correlationId: `corr-${counter}`,
    });
    assert(record, "the seeded record was stored");
    seqs.push(record.seq);
  }
  return seqs;
}

Deno.test("the key is required, and an unconfigured deployment refuses everyone", async () => {
  const { fetch, stores } = app();
  await seed(stores, 1);

  const anonymous = await fetch(new Request(`${BASE}/api/observability/errors`));
  assertEquals(anonymous.status, 401);
  assertStringIncludes(anonymous.headers.get("www-authenticate") ?? "", "Bearer");

  const wrong = await fetch(authed("/api/observability/errors", "not-the-key"));
  assertEquals(wrong.status, 401);

  const right = await fetch(authed("/api/observability/errors"));
  assertEquals(right.status, 200);

  // No key configured: closed, and honest about why, rather than open.
  const unconfigured = app(memoryStores(), null);
  const refused = await unconfigured.fetch(authed("/api/observability/errors"));
  assertEquals(refused.status, 503);
  const body = await refused.json();
  // `problem()` uses `error` as the stable discriminator field; `title` is only its input.
  assertEquals(body.error, "observability_not_configured");
  // The refusal must not quote the key that would have been expected, and there is none to quote.
  assert(!JSON.stringify(body).includes(KEY));
});

Deno.test("events come back in sequence order with an advancing cursor", async () => {
  const { fetch, stores } = app();
  await seed(stores, 5);

  const first = await (await fetch(authed("/api/observability/errors?since=0&limit=2"))).json();
  assertEquals(first.events.length, 2);
  assertEquals(first.events.map((e: { seq: number }) => e.seq), [1, 2]);
  assertEquals(first.cursor, "2");
  assertEquals(first.hasMore, true);

  const second =
    await (await fetch(authed(`/api/observability/errors?since=${first.cursor}&limit=2`)))
      .json();
  assertEquals(second.events.map((e: { seq: number }) => e.seq), [3, 4]);
  assertEquals(second.cursor, "4");

  const third =
    await (await fetch(authed(`/api/observability/errors?since=${second.cursor}&limit=2`)))
      .json();
  assertEquals(third.events.map((e: { seq: number }) => e.seq), [5]);
  assertEquals(third.cursor, "5");
  // Nothing behind the cursor: this is what a poller polls on.
  assertEquals(third.hasMore, false);

  const idle = await (await fetch(authed(`/api/observability/errors?since=${third.cursor}`)))
    .json();
  assertEquals(idle.events, []);
  assertEquals(idle.cursor, "5");
  assertEquals(idle.hasMore, false);
});

Deno.test("the same request twice returns the same body, and the cursor never goes backwards", async () => {
  const { fetch, stores } = app();
  await seed(stores, 3);
  const one = await (await fetch(authed("/api/observability/errors?since=0"))).text();
  const two = await (await fetch(authed("/api/observability/errors?since=0"))).text();
  assertEquals(one, two, "stable order: no timestamps, no reordering between calls");

  // A cursor the store cannot have issued yet is simply ahead: an empty page, not an error.
  const ahead = await (await fetch(authed("/api/observability/errors?since=99"))).json();
  assertEquals(ahead.events, []);
  assertEquals(ahead.cursor, "99", "the cursor never moves backwards");
});

Deno.test("the cursor survives a restart, because it is the store's sequence and not a clock", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/obs.kv`;
    const first = await openStores({ kvPath: path });
    let cursor = "0";
    try {
      await seed(first, 3);
      const page = await (await fetchAuthed(first, "/api/observability/errors?since=0")).json();
      cursor = page.cursor;
      assertEquals(page.events.length, 3);
    } finally {
      await first.metadata.close();
    }

    // Restart: a new store over the same file, as a redeploy would be.
    const second = await openStores({ kvPath: path });
    try {
      const resumed = await (await fetchAuthed(second, `/api/observability/errors?since=${cursor}`))
        .json();
      assertEquals(resumed.events, [], "events already consumed are not redelivered");
      assertEquals(resumed.cursor, cursor, "and the cursor is where the previous process left it");

      // New events after the restart continue the same sequence: no reset, no collision with a
      // timestamp from before the restart.
      const fresh = await seed(second, 2);
      assert(fresh[0]! > Number(cursor), "the sequence continues across the restart");
      const after = await (await fetchAuthed(second, `/api/observability/errors?since=${cursor}`))
        .json();
      assertEquals(after.events.map((e: { seq: number }) => e.seq), fresh);
    } finally {
      await second.metadata.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function fetchAuthed(stores: Stores, path: string) {
  const config = {
    port: 8000,
    publicBaseUrl: BASE,
    adminToken: "admin-secret",
    observabilityKey: KEY,
  };
  const ctx = { config, stores };
  return createApp(ctx, createHandlers(ctx)).fetch(authed(path));
}

Deno.test("a cursor that retention has passed is refused, not silently skipped", async () => {
  const { fetch, stores } = app();
  await seed(stores, 4);
  const bounds = await stores.metadata.logBounds();
  assertEquals(bounds.oldestSeq, 1);

  // Retention drops the first two records.
  const pruned = await stores.metadata.pruneLogs(new Date(Date.UTC(2026, 9, 11, 12, 0, counter)));
  assert(pruned >= 1, "retention actually removed something");

  const after = await stores.metadata.logBounds();
  assert(after.oldestSeq > 1, `the oldest retained sequence moved: ${after.oldestSeq}`);

  const expired = await fetch(authed("/api/observability/errors?since=0"));
  assertEquals(expired.status, 410);
  const body = await expired.json();
  assertEquals(body.error, "cursor_too_old");
  assertStringIncludes(body.detail, String(after.oldestSeq));
  // The same applies to the summary, so a poller cannot be told "nothing new" when it has in fact
  // missed events.
  assertEquals((await fetch(authed("/api/observability/summary?since=0"))).status, 410);

  // A cursor inside the retained window still works.
  const ok = await fetch(authed(`/api/observability/errors?since=${after.oldestSeq - 1}`));
  assertEquals(ok.status, 200);
});

Deno.test("an early poller is not refused, but a lost cursor is — even with nothing retained", async () => {
  // A store that has never held an event reports oldestRetained 1, so a poller that is simply early
  // gets an empty feed rather than a refusal.
  const fresh = app();
  const first = await fresh.fetch(authed("/api/observability/errors?since=0"));
  assertEquals(first.status, 200);
  const firstBody = await first.json();
  assertEquals(firstBody.events, []);
  assertEquals(firstBody.window.oldestRetained, 1);

  // Retention removing EVERYTHING is the case that matters, and it looks empty from the outside.
  // The cursor must still be refused: answering "nothing new" would present lost events as quiet.
  const { fetch, stores } = app();
  await seed(stores, 3);
  await stores.metadata.pruneLogs(new Date(Date.UTC(2030, 0, 1)));
  const bounds = await stores.metadata.logBounds();
  assertEquals(await stores.metadata.listLogs(), [], "retention removed every event");
  assert(bounds.oldestSeq > bounds.newestSeq, `an empty-looking store: ${JSON.stringify(bounds)}`);

  const lost = await fetch(authed("/api/observability/errors?since=0"));
  assertEquals(lost.status, 410, "a cursor from before a full prune cannot be resumed");
  assertEquals((await lost.json()).error, "cursor_too_old");
  // And a cursor that is merely at the end of what was pruned still works, so a poller that had
  // consumed everything is not punished for the prune.
  const current = await fetch(authed(`/api/observability/errors?since=${bounds.newestSeq}`));
  assertEquals(current.status, 200);
});

Deno.test("the summary tells a poller nothing changed, and counts what did", async () => {
  const { fetch, stores } = app();
  await seed(stores, 3, "error", "synthesis.failed");
  await seed(stores, 2, "debug", "http.request");

  const all = await (await fetch(authed("/api/observability/summary?since=0&severity=all"))).json();
  assertEquals(all.total, 5, "the summary counts every severity when asked for all");
  assertEquals(all.bySeverity.error, 3);
  assertEquals(all.bySeverity.debug, 2);
  assertEquals(
    all.byType.find((t: { type: string }) => t.type === "synthesis.failed").count,
    3,
  );

  // The cheap question: anything new since my cursor? 1..5 are consumed, so no.
  const cursor = all.cursor;
  const nothingNew = await (await fetch(authed(`/api/observability/summary?since=${cursor}`)))
    .json();
  assertEquals(nothingNew.total, 0);
  assertEquals(nothingNew.cursor, cursor);

  await seed(stores, 1, "error", "synthesis.failed");
  const somethingNew = await (await fetch(authed(`/api/observability/summary?since=${cursor}`)))
    .json();
  assertEquals(somethingNew.total, 1);
  assert(Number(somethingNew.cursor) > Number(cursor));
});

Deno.test("the errors feed serves warn-and-worse by default, and a filter never skips events", async () => {
  const { fetch, stores } = app();
  await seed(stores, 2, "debug", "http.request");
  await seed(stores, 1, "warn", "claim.lifecycle");
  await seed(stores, 1, "error", "synthesis.failed");

  const feed = await (await fetch(authed("/api/observability/errors?since=0"))).json();
  assertEquals(feed.returned, 2, "debug is not an error");
  assertEquals(feed.events.map((e: { severity: string }) => e.severity), ["warn", "error"]);
  // The cursor advanced over EVERYTHING scanned, including the filtered-out debug records: if it
  // stopped at the last returned event, the debug records would be re-scanned forever, and if a
  // filter were applied before the cursor moved, they could be skipped.
  assertEquals(feed.cursor, "4");
  assertEquals(feed.scanned, 4);

  const onlyErrors = await (await fetch(authed("/api/observability/errors?since=0&severity=error")))
    .json();
  assertEquals(onlyErrors.returned, 1);
  assertEquals(onlyErrors.cursor, "4", "the cursor still covers the whole scan");
});

Deno.test("bad parameters are rejected with a reason", async () => {
  const { fetch } = app();
  for (
    const [query, title] of [
      ["since=nope", "invalid_cursor"],
      ["since=-1", "invalid_cursor"],
      ["since=1&until=0", "invalid_cursor"],
      ["limit=0", "invalid_limit"],
      [`limit=${MAX_LIMIT + 1}`, "invalid_limit"],
      ["limit=many", "invalid_limit"],
      ["severity=shout", "invalid_severity"],
    ]
  ) {
    const res = await fetch(authed(`/api/observability/errors?${query}`));
    assertEquals(res.status, 400, query);
    const body = await res.json();
    assertEquals(body.error, title, query);
  }
  // Authentication precedes parsing: an anonymous caller learns nothing about the query language.
  const anonymous = await fetch(new Request(`${BASE}/api/observability/errors?since=nope`));
  assertEquals(anonymous.status, 401);
});

Deno.test("the key never reaches the store (audio-feed-s2pi, ao4s invariant)", async () => {
  const { fetch, stores } = app();
  await fetch(authed("/api/observability/errors"));
  await fetch(authed("/api/observability/summary"));
  await fetch(
    new Request(`${BASE}/api/observability/errors`, {
      headers: { authorization: `Bearer ${KEY}` },
    }),
  );
  const serialised = JSON.stringify(await stores.metadata.listLogs());
  assert(!serialised.includes(KEY), "the shared key is never logged, echoed or stored");
});

Deno.test("a summary cursor never skips what it did not count (audio-feed-8d6r)", async () => {
  // The reviewer's reproduction: 500 records fill the store's read bound, and the 501st is an error.
  // The old summary reported the window's NEWEST sequence as the cursor while having counted only the
  // bound, so a poller advancing to it never saw the error — a silent skip, the one thing this API
  // is not allowed to do.
  const { fetch, stores } = app();
  await seed(stores, 500, "warn", "http.request");
  const errorSeq = (await seed(stores, 1, "error", "synthesis.failed"))[0]!;

  const first = await (await fetch(authed("/api/observability/summary?since=0"))).json();
  assertEquals(first.total, 500, "the count covers exactly what the scan could read");
  assertEquals(first.truncated, true, "and says the window is larger than that");
  assertEquals(
    first.cursor,
    "500",
    "the cursor is the last COUNTED sequence, not the window's newest",
  );
  assert(Number(first.cursor) < errorSeq, "and so it cannot step over the uncounted error");

  // Continuing from the reported cursor finds it. This is the property the bug destroyed.
  const second = await (await fetch(authed(`/api/observability/summary?since=${first.cursor}`)))
    .json();
  assertEquals(second.total, 1, "the next poll sees the record the first one did not count");
  assertEquals(second.bySeverity.error, 1);
  assertEquals(second.truncated, false);
  assertEquals(second.cursor, String(errorSeq));

  // And the events themselves are reachable from the same cursor, so a poller that trusts the
  // summary cursor still receives the event.
  const events =
    await (await fetch(authed(`/api/observability/errors?since=${first.cursor}&severity=error`)))
      .json();
  assertEquals(events.events.map((e: { seq: number }) => e.seq), [errorSeq]);
});

Deno.test("a summary that counted the whole window is not marked truncated", async () => {
  const { fetch, stores } = app();
  await seed(stores, 3, "error", "synthesis.failed");
  const body = await (await fetch(authed("/api/observability/summary?since=0&severity=all")))
    .json();
  assertEquals(body.total, 3);
  assertEquals(body.truncated, false);
  assertEquals(body.cursor, "3");
});

Deno.test("the summary honours severity instead of answering a different question (audio-feed-ijuc)", async () => {
  const { fetch, stores } = app();
  await seed(stores, 100, "debug", "http.request");
  const errorSeq = (await seed(stores, 1, "error", "synthesis.failed"))[0]!;

  const asAll = await (await fetch(authed("/api/observability/summary?since=0&severity=all")))
    .json();
  const asError = await (await fetch(authed("/api/observability/summary?since=0&severity=error")))
    .json();

  // Before this fix `severity` was parsed and dropped, so both answers were identical and the
  // filtered one silently described a different window than the caller asked about.
  assertEquals(asAll.total, 101, "all counts every severity, including debug");
  assertEquals(asAll.truncated, false);
  assertEquals(asError.total, 1, "a severity=error summary counts errors");
  assertEquals(asError.bySeverity.error, 1);
  assertEquals(asError.bySeverity.debug, 0, "excluded severities count zero, not absent");
  assert(asAll.total !== asError.total, "the filter has to change the answer");

  // The cursor is still the SCANNED boundary, so the filter cannot hide the error from a later poll.
  assert(Number(asError.cursor) >= errorSeq, "the filtered summary still reaches the error");
  const events = await (await fetch(authed("/api/observability/errors?since=0&severity=error")))
    .json();
  assertEquals(events.events.map((e: { seq: number }) => e.seq), [errorSeq]);
});

Deno.test("the documented poller drains pages before advancing its cursor (audio-feed-c0kx)", async () => {
  const { fetch, stores } = app();
  await seed(stores, 300, "error", "synthesis.failed");

  let cursor = "0";
  const seen: number[] = [];
  const summary =
    await (await fetch(authed(`/api/observability/summary?since=${cursor}&severity=error`)))
      .json();
  assertEquals(summary.total, 300);

  // The recipe the docs describe, run for real: drain until hasMore is false, THEN advance.
  let page = await (await fetch(authed(`/api/observability/errors?since=${cursor}&severity=error`)))
    .json();
  const pages = [page.returned];
  while (true) {
    seen.push(...page.events.map((e: { seq: number }) => e.seq));
    cursor = page.cursor;
    if (!page.hasMore) break;
    page = await (await fetch(authed(`/api/observability/errors?since=${cursor}&severity=error`)))
      .json();
    pages.push(page.returned);
  }

  // 300 errors, a default page of 200: a single page would have lost 100 of them, which is what the
  // old recipe did by advancing straight to the summary cursor.
  assertEquals(pages, [200, 100], "the pages are drained, not sampled");
  assertEquals(seen.length, 300, "every event is returned");
  assertEquals(seen[0], 1);
  assertEquals(seen[299], 300);

  // And after the drain the cheap check reports nothing new, so the poller is idle rather than
  // re-reading or losing anything.
  const after =
    await (await fetch(authed(`/api/observability/summary?since=${cursor}&severity=error`)))
      .json();
  assertEquals(after.total, 0);
});

Deno.test("a truncated summary is an instruction, not a quiet answer (audio-feed-36qa)", async () => {
  const { fetch, stores } = app();
  // The reviewer's trap: the scan bound fills with records the DEFAULT filter excludes, and the one
  // record the caller wants sits immediately behind them.
  await seed(stores, 500, "debug", "http.request");
  const errorSeq = (await seed(stores, 1, "error", "synthesis.failed"))[0]!;

  const first = await (await fetch(authed("/api/observability/summary?since=0"))).json();
  assertEquals(first.total, 0, "nothing matched the filter in the scanned window");
  assertEquals(first.truncated, true, "and the caller is told the scan was bounded");
  assertEquals(
    first.scanned,
    500,
    "`scanned` shows the bound filled, so this is not an empty store",
  );
  assertEquals(
    first.cursor,
    "500",
    "the cursor advances over what was SCANNED, not what was counted",
  );

  // Polling again from the returned cursor reaches the record, which is the property a caller that
  // treats total==0 as quiet would lose.
  const second = await (await fetch(authed(`/api/observability/summary?since=${first.cursor}`)))
    .json();
  assertEquals(second.total, 1);
  assertEquals(second.bySeverity.error, 1);
  assertEquals(second.cursor, String(errorSeq));
  assertEquals(second.truncated, false);
});

Deno.test("the documented recipe terminates and finds the record behind a full scan bound (audio-feed-36qa)", async () => {
  const { fetch, stores } = app();
  await seed(stores, 500, "debug", "http.request");
  await seed(stores, 1, "error", "synthesis.failed");

  // The recipe as the docs describe it, with the `truncated` branch that this finding was about.
  const summary = async (since: string) =>
    await (await fetch(authed(`/api/observability/summary?since=${since}`))).json();
  let probe = "0";
  let counted = 0;
  let polls = 0;
  while (polls < 10) {
    polls++;
    const s = await summary(probe);
    if (s.truncated) {
      probe = s.cursor;
      continue;
    }
    if (s.total > 0) {
      counted += s.total;
      break;
    }
    break;
  }
  assertEquals(polls <= 2, true, `terminated in ${polls} polls`);
  assertEquals(counted, 1, "and reached the record behind the full bound");
});

Deno.test("every matched event is delivered exactly once, whatever the poll shape (audio-feed-2af8)", async () => {
  // The assertion is the invariant rather than a count, so the next variant of this bug cannot slip
  // through as a different number: 501 events is deliberately one more than the summary's scan bound,
  // and the old recipe advanced the DURABLE cursor to the probe's boundary before draining the events
  // below it — reading seq 501 and silently losing the other 500.
  const { fetch, stores } = app();
  const seeded = await seed(stores, 501, "error", "synthesis.failed");
  assertEquals(seeded.length, 501);

  // The documented recipe, executable, with the correction that matters: drain from the durable
  // cursor first, advance it only past what was read.
  const seen: number[] = [];
  let durable = "0";
  for (let poll = 0; poll < 20; poll++) {
    const summary =
      await (await fetch(authed(`/api/observability/summary?since=${durable}&severity=error`)))
        .json();
    if (summary.total === 0 && !summary.truncated) break;
    let cursor = durable;
    while (true) {
      const page =
        await (await fetch(authed(`/api/observability/errors?since=${cursor}&severity=error`)))
          .json();
      seen.push(...page.events.map((e: { seq: number }) => e.seq));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    durable = cursor;
  }

  // THE INVARIANT, in three parts: nothing missing, nothing duplicated, nothing invented.
  assertEquals(new Set(seen).size, seen.length, "no event was delivered twice");
  assertEquals(
    seen.slice().sort((a, b) => a - b),
    seeded,
    "every seeded event was delivered, in order",
  );
});

Deno.test("the filtered truncated case still terminates and still delivers its event (audio-feed-2af8)", async () => {
  // The 36qa shape, now under the corrected recipe: the probe reports total 0 with a full scan bound,
  // and the matching event sits behind records the filter excluded.
  const { fetch, stores } = app();
  await seed(stores, 500, "debug", "http.request");
  const errorSeq = (await seed(stores, 1, "error", "synthesis.failed"))[0]!;

  const seen: number[] = [];
  let durable = "0";
  let polls = 0;
  for (; polls < 10; polls++) {
    const summary =
      await (await fetch(authed(`/api/observability/summary?since=${durable}&severity=error`)))
        .json();
    if (summary.total === 0 && !summary.truncated) break;
    let cursor = durable;
    while (true) {
      const page =
        await (await fetch(authed(`/api/observability/errors?since=${cursor}&severity=error`)))
          .json();
      seen.push(...page.events.map((e: { seq: number }) => e.seq));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    durable = cursor;
  }

  assert(polls < 10, "the recipe terminates rather than looping on a truncated probe");
  assertEquals(seen, [errorSeq], "exactly the matched event, delivered once");
});

Deno.test("a bounded summary window is complete, not truncated (audio-feed-bx1q)", async () => {
  const { fetch, stores } = app();
  await seed(stores, 5, "error", "synthesis.failed");

  // The window the caller asked for was fully scanned, so there is nothing left to scan inside it —
  // even though the store holds records beyond the cap. Reporting truncated here told a caller to
  // come back for something they had explicitly excluded, and disagreed with the errors feed, which
  // reported hasMore: false for the same window.
  const bounded =
    await (await fetch(authed("/api/observability/summary?since=0&until=1&severity=all")))
      .json();
  assertEquals(bounded.total, 1);
  assertEquals(bounded.cursor, "1");
  assertEquals(bounded.scanned, 1);
  assertEquals(bounded.truncated, false, "the requested window was scanned to its end");

  const page = await (await fetch(authed("/api/observability/errors?since=0&until=1&severity=all")))
    .json();
  assertEquals(page.hasMore, false, "and the errors feed agrees about the same window");

  // The device still works when the window genuinely is not finished: the same query without a cap
  // scans the whole store, and a capped window that is cut off by the read bound reports truncated.
  const capped =
    await (await fetch(authed("/api/observability/summary?since=0&until=1&limit=1&severity=all")))
      .json();
  assert(capped, "a limit smaller than the window is still answered");

  // Exhausting the store without a cap is complete too: nothing is left to scan.
  const uncapped = await (await fetch(authed("/api/observability/summary?since=0&severity=all")))
    .json();
  assertEquals(uncapped.total, 5);
  assertEquals(uncapped.truncated, false, "the store was exhausted, not bounded");
});

Deno.test("audio-feed-4y9v: http.request records and /api/observability/errors carry a validated host and screen capability tokens", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  const srv = await bootstrap({
    port: 0,
    stores,
    isDeploy: true,
    synthesizer: null,
    inventory: false,
    config: {
      publicBaseUrl: BASE,
      observabilityKey: KEY,
    },
  });
  try {
    // 1. A 421 misdirected request on wrong.example.com records host="wrong.example.com".
    const misdirected = await srv.fetch(new Request("https://wrong.example.com/"));
    assertEquals(misdirected.status, 421);

    // 2. A host carrying a capability-shaped or canary-shaped label is screened to "<other>".
    const canary = "qV7z52CapSECRETfd39Nd";
    const tokenHost = await srv.fetch(new Request(`https://${canary}.example.com/`));
    assertEquals(tokenHost.status, 421);

    const feedRes = await srv.fetch(
      new Request(`${BASE}/api/observability/errors?since=0&severity=warn`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );
    assertEquals(feedRes.status, 200);
    const feed = await feedRes.json();
    assertEquals(feed.events.length, 2);

    assertEquals(feed.events[0].type, "http.request");
    assertEquals(feed.events[0].context?.host, "wrong.example.com");
    assertEquals(feed.events[0].context?.status, 421);

    assertEquals(feed.events[1].type, "http.request");
    assertEquals(feed.events[1].context?.host, OTHER_HOST);
    assert(!JSON.stringify(feed).toLowerCase().includes(canary.toLowerCase()));

    // Direct unit checks on normaliseRequestHost for proxy headers and deploy preview hosts.
    assertEquals(
      normaliseRequestHost(
        new Request("https://audio-feed-8b9c1d2e3f4a.paulkinlan-ea.deno.net/"),
      ),
      "audio-feed-8b9c1d2e3f4a.paulkinlan-ea.deno.net",
    );
    assertEquals(
      normaliseRequestHost(
        new Request("https://localhost/account", {
          headers: { "x-forwarded-host": "staging.audio.example.com" },
        }),
        false,
      ),
      "localhost",
    );
    assertEquals(
      normaliseRequestHost(
        new Request("https://localhost/account", {
          headers: { "x-forwarded-host": "staging.audio.example.com" },
        }),
        true,
      ),
      "staging.audio.example.com",
    );
  } finally {
    await srv.shutdown();
  }
});

Deno.test("audio-feed-4y9v: claim.lifecycle events carry article/source/size metadata and toEvent projects full lifecycle fields", async () => {
  const { fetch, stores } = app();
  const episode = makeEpisode({
    id: "episode-meta-1",
    userId: "user-1",
    articleId: "article-meta-1",
    sourceId: "source-meta-1",
    sourceTitle: "Stratechery Daily Update",
    mode: "deepdive",
    byteLength: 48_000_000,
    durationSeconds: 912,
    attempts: 2,
    scriptTurns: [
      { speaker: "Host", text: "Turn 1" },
      { speaker: "Guest", text: "Turn 2" },
      { speaker: "Host", text: "Turn 3" },
    ],
  });

  await stores.metadata.appendLog(
    claimLifecycleEvent(episode, {
      phase: "uploading_audio",
      attempt: 2,
      severity: "warn",
      claimOutcome: "yielded",
      uploadRetry: 1,
      durationMs: 44_200,
      inputByteLength: 31_400,
      wordCount: 4_850,
      segmentCount: 12,
      reason: "invocation budget reached with 8 of 12 segments committed",
    }),
  );
  await stores.metadata.appendLog(
    abandonedClaimEvent(episode, {
      phase: "narration_tts",
      attempt: 3,
      reason: "claim lease expired in narration_tts",
      expiredAt: "2026-10-14T08:15:00.000Z",
    }),
  );

  const page = await (await fetch(authed("/api/observability/errors?since=0&severity=warn"))).json();
  assertEquals(page.events.length, 2);

  const yielded = page.events[0];
  assertEquals(yielded.type, "claim.lifecycle");
  assertEquals(yielded.episodeId, "episode-meta-1");
  assertEquals(yielded.phase, "uploading_audio");
  assertEquals(yielded.attempt, 2);
  assertEquals(yielded.durationMs, 44_200);
  assertEquals(yielded.context?.articleId, "article-meta-1");
  assertEquals(yielded.context?.sourceId, "source-meta-1");
  assertEquals(yielded.context?.sourceTitle, "Stratechery Daily Update");
  assertEquals(yielded.context?.mode, "deepdive");
  assertEquals(yielded.context?.byteLength, 48_000_000);
  assertEquals(yielded.context?.durationSeconds, 912);
  assertEquals(yielded.context?.scriptTurnCount, 3);
  assertEquals(yielded.context?.inputByteLength, 31_400);
  assertEquals(yielded.context?.wordCount, 4_850);
  assertEquals(yielded.context?.segmentCount, 12);
  assertEquals(yielded.context?.claimOutcome, "yielded");
  assertEquals(yielded.context?.uploadRetry, 1);

  const abandoned = page.events[1];
  assertEquals(abandoned.type, "claim.lifecycle");
  assertEquals(abandoned.episodeId, "episode-meta-1");
  assertEquals(abandoned.phase, "narration_tts");
  assertEquals(abandoned.attempt, 3);
  assertEquals(abandoned.context?.articleId, "article-meta-1");
  assertEquals(abandoned.context?.sourceId, "source-meta-1");
  assertEquals(abandoned.context?.workerState, "unknown");
});
