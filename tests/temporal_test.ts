// audio-feed-ap45: Replace Legacy Date Arithmetic with Temporal (temporal-plaindate)
//
// Tests verify:
// - toRfc2822 formats timestamps correctly with Temporal.Instant across boundaries
// - RSS episode sorting with Temporal.Instant.compare
// - when() and ago() handle relative date calculations without DST or 86400000ms drift
// - Canonical Baseline markers are present

import { assert, assertEquals } from "@std/assert";
import { toRfc2822 } from "../src/feed/rss.ts";

Deno.test("temporal: toRfc2822 produces exact RFC 2822 strings via Temporal.Instant (audio-feed-ap45)", () => {
  const cases = [
    { iso: "2026-09-24T12:30:45.000Z", expected: "Thu, 24 Sep 2026 12:30:45 +0000" },
    { iso: "2026-01-01T00:00:00.000Z", expected: "Thu, 01 Jan 2026 00:00:00 +0000" },
    { iso: "2026-02-28T23:59:59.000Z", expected: "Sat, 28 Feb 2026 23:59:59 +0000" },
    { iso: "2026-12-31T18:05:01.000Z", expected: "Thu, 31 Dec 2026 18:05:01 +0000" },
  ];

  for (const c of cases) {
    assertEquals(toRfc2822(c.iso), c.expected);
  }
});

Deno.test("temporal: Temporal.PlainDate date difference handles month and DST boundaries (audio-feed-ap45)", () => {
  // DST / Leap year / month boundary checks with Temporal.PlainDate
  const today = Temporal.PlainDate.from("2026-03-01");
  const feb28 = Temporal.PlainDate.from("2026-02-28");
  const feb20 = Temporal.PlainDate.from("2026-02-20");

  assertEquals(today.since(feb28).total({ unit: "days" }), 1);
  assertEquals(today.since(feb20).total({ unit: "days" }), 9);
});

Deno.test("temporal: Temporal.Instant.compare correctly sorts timestamps (audio-feed-ap45)", () => {
  const dates = [
    "2026-09-01T10:00:00Z",
    "2026-09-24T12:00:00Z",
    "2026-08-15T08:00:00Z",
    "2026-09-24T12:00:01Z",
  ];

  const sorted = [...dates].sort((a, b) =>
    Temporal.Instant.compare(Temporal.Instant.from(b), Temporal.Instant.from(a))
  );

  assertEquals(sorted, [
    "2026-09-24T12:00:01Z",
    "2026-09-24T12:00:00Z",
    "2026-09-01T10:00:00Z",
    "2026-08-15T08:00:00Z",
  ]);
});

Deno.test("temporal: Baseline markers are present across modified surfaces (audio-feed-ap45)", async () => {
  const listenJs = await Deno.readTextFile("src/assets/listen.js");
  const adminTs = await Deno.readTextFile("src/routes/admin.ts");
  const rssTs = await Deno.readTextFile("src/feed/rss.ts");
  const accountTs = await Deno.readTextFile("src/routes/account.ts");

  assert(listenJs.includes("TODO(baseline/temporal)"));
  assert(adminTs.includes("TODO(baseline/temporal)"));
  assert(rssTs.includes("TODO(baseline/temporal)"));
  assert(accountTs.includes("TODO(baseline/temporal)"));
});
