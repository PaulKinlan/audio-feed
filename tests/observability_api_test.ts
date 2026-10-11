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
import { MAX_LIMIT } from "../src/routes/observability.ts";
import type { LogSeverity } from "../src/storage/mod.ts";

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
  assertEquals(
    asError.bySeverity.debug,
    undefined,
    "and does not report the severities it excluded",
  );
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
