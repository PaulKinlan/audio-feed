/**
 * Operational counters: enclosure requests, synthesis spend and the budget that reads them.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assert, assertEquals } from "@std/assert";
import { makeUser } from "../../fixtures.ts";

export function registerUsageCases(suite: MetadataHarness) {
  const { test } = suite;

  // -- operational stats (audio-feed-ndc) -----------------------------------
  //
  // These live in the CONFORMANCE suite, not in a memory-only test, because the
  // two adapters implement them by completely different means: memory uses a
  // number and a Map, KV uses atomic `.sum()` on KvU64 and a descending key
  // space with a prune. Two implementations of one contract is exactly the case
  // this file exists for, and a memory-only test would pass while the adapter
  // that actually runs in production diverged.

  test("an empty store reports no downloads", async (store) => {
    // The dashboard renders this before anything has ever been requested, so
    // "no data" has to be a value rather than an absence to reason about.
    assertEquals(await store.getDownloadCounts(), { total: 0, perUser: [] });
  });

  test("recordDownload counts per user and in total", async (store) => {
    await store.recordDownload("user-a");
    await store.recordDownload("user-a");
    await store.recordDownload("user-b");

    const counts = await store.getDownloadCounts();
    assertEquals(counts.total, 3);
    // Descending by count, so the dashboard's "top subscribers" needs no sort.
    assertEquals(counts.perUser, [
      { userId: "user-a", count: 2 },
      { userId: "user-b", count: 1 },
    ]);
  });

  test("an unattributable download counts toward the total only", async (store) => {
    // A legacy flat blob key carries no user (audio-feed-3hb), so the route
    // passes null rather than inventing an owner. Counting it against some user
    // would be worse than not attributing it: the per-user figure is the one an
    // operator would act on.
    await store.recordDownload(null);
    await store.recordDownload("user-a");

    const counts = await store.getDownloadCounts();
    assertEquals(counts.total, 2, "an unattributed request is still a request");
    assertEquals(counts.perUser, [{ userId: "user-a", count: 1 }]);
  });

  test("a user with no downloads does not appear in the breakdown", async (store) => {
    await store.putUser(makeUser({ id: "quiet" }));
    await store.recordDownload("loud");

    const counts = await store.getDownloadCounts();
    assertEquals(counts.perUser.map((d) => d.userId), ["loud"]);
  });

  // -- synthesis stats and budget tracking (audio-feed-9mp) ------------------

  test("an empty store reports no synthesis (audio-feed-9mp)", async (store) => {
    const s = await store.getSynthesisCounts("2026-09-27");
    assertEquals(s.total, 0);
    assertEquals(s.totalBytes, 0);
    assertEquals(s.perUser, []);
    assertEquals(await store.getUserDailySynthesisCount("user-a", "2026-09-27"), 0);
  });

  test("recordSynthesis counts per user, total, and daily window (audio-feed-9mp)", async (store) => {
    const day = "2026-09-27";
    const date = new Date("2026-09-27T12:00:00.000Z");

    await store.recordSynthesis("user-a", 1000, date);
    await store.recordSynthesis("user-a", 2000, date);
    await store.recordSynthesis("user-b", 500, date);

    const s = await store.getSynthesisCounts(day);
    assertEquals(s.total, 3);
    assertEquals(s.totalBytes, 3500);
    assertEquals(s.perUser.length, 2);

    const userA = s.perUser.find((u) => u.userId === "user-a");
    assert(userA);
    assertEquals(userA.count, 2);
    assertEquals(userA.bytes, 3000);
    assertEquals(userA.todayCount, 2);

    const userB = s.perUser.find((u) => u.userId === "user-b");
    assert(userB);
    assertEquals(userB.count, 1);
    assertEquals(userB.bytes, 500);
    assertEquals(userB.todayCount, 1);

    assertEquals(await store.getUserDailySynthesisCount("user-a", day), 2);
    assertEquals(await store.getUserDailySynthesisCount("user-b", day), 1);

    // audio-feed-m182: the fleet-wide day counter is written with the per-user one. The invariant
    // that matters is that it stays the SUM of the parts — a global ceiling counted from a counter
    // that can drift from the per-subscriber counters is a ceiling on the wrong number.
    assertEquals(
      await store.getDailySynthesisCount(day),
      3,
      "global total is the sum of the users",
    );
    assertEquals(await store.getDailySynthesisCount("2026-09-26"), 0, "another day is untouched");
  });

  test("daily synthesis count boundary resets cleanly across UTC midnight (audio-feed-9mp)", async (store) => {
    const beforeMidnight = new Date("2026-09-27T23:59:59.999Z");
    const afterMidnight = new Date("2026-09-28T00:00:00.001Z");

    await store.recordSynthesis("user-c", 1000, beforeMidnight);
    await store.recordSynthesis("user-c", 1000, afterMidnight);

    assertEquals(await store.getUserDailySynthesisCount("user-c", "2026-09-27"), 1);
    assertEquals(await store.getUserDailySynthesisCount("user-c", "2026-09-28"), 1);

    const sDay1 = await store.getSynthesisCounts("2026-09-27");
    assertEquals(sDay1.total, 2);
    assertEquals(sDay1.perUser.find((u) => u.userId === "user-c")?.todayCount, 1);

    const sDay2 = await store.getSynthesisCounts("2026-09-28");
    assertEquals(sDay2.total, 2);
    assertEquals(sDay2.perUser.find((u) => u.userId === "user-c")?.todayCount, 1);
  });
}
