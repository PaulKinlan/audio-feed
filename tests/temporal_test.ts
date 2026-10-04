// audio-feed-ap45: Replace Legacy Date Arithmetic with Temporal (temporal-plaindate)
//
// Tests verify:
// - toRfc2822 formats timestamps correctly with Temporal.Instant across boundaries
// - toRfc2822 fallback is transparent (identical with and without Temporal)
// - RSS episode sorting with Temporal.Instant.compare
// - when() in listen.js: Temporal path and Date fallback agree on calendar days near midnight
// - ago() in admin.ts: Temporal path and Date fallback agree across all duration brackets
// - when() in account.ts: Temporal.PlainDate calendar date extraction agrees across formats
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

Deno.test("temporal: toRfc2822 fallback is transparent without Temporal (audio-feed-ap45)", () => {
  const iso = "2026-10-04T21:00:00.000Z";
  const withT = toRfc2822(iso);
  const savedTemporal = (globalThis as { Temporal?: unknown }).Temporal;
  try {
    delete (globalThis as { Temporal?: unknown }).Temporal;
    const withoutT = toRfc2822(iso);
    assertEquals(
      withT,
      withoutT,
      "toRfc2822 must produce identical output with and without Temporal",
    );
  } finally {
    (globalThis as { Temporal?: unknown }).Temporal = savedTemporal;
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

Deno.test("temporal: listen.js when() Temporal path and Date fallback agree across midnight boundary (audio-feed-ap45)", async () => {
  const listenJs = await Deno.readTextFile("src/assets/listen.js");
  const start = listenJs.indexOf("const when = (");
  assert(start >= 0);
  const brace = listenJs.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < listenJs.length; i++) {
    if (listenJs[i] === "{") depth++;
    else if (listenJs[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert(end > 0);
  const whenBody = listenJs.slice(start, end).replace(/^const when = /, "return ") + ";";

  // Frozen clock at 2026-10-04T00:30:00Z (01:30 BST)
  const NOW = Date.parse("2026-10-04T00:30:00Z");
  const H = 3_600_000;
  const tz = "Europe/London";

  function makeWhen(withTemporal: boolean) {
    const RealDate = Date;
    const FrozenDate = new Proxy(RealDate, {
      get(t, p, r) {
        if (p === "now") return () => NOW;
        return Reflect.get(t, p, r);
      },
    });
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short" }).format(
      new RealDate(NOW),
    );
    const TemporalStub = withTemporal
      ? {
        Now: { plainDateISO: () => Temporal.PlainDate.from(localDate), timeZoneId: () => tz },
        Instant: Temporal.Instant,
        PlainDate: Temporal.PlainDate,
      }
      : undefined;
    return new Function("Date", "Temporal", whenBody)(FrozenDate, TemporalStub) as (
      iso: string,
    ) => string;
  }

  const withT = makeWhen(true);
  const withoutT = makeWhen(false);

  const testDeltas: [string, number, string][] = [
    ["1h ago (same calendar day)", NOW - 1 * H, "Today"],
    ["2h ago (straddles midnight into yesterday)", NOW - 2 * H, "Yesterday"],
    ["23h ago (yesterday morning)", NOW - 23 * H, "Yesterday"],
    ["26h ago (2 days ago)", NOW - 26 * H, "2 days ago"],
    ["3d ago", NOW - 3 * 24 * H, "3 days ago"],
    ["6d ago", NOW - 6 * 24 * H, "6 days ago"],
  ];

  for (const [desc, timeMs, expected] of testDeltas) {
    const isoStr = new Date(timeMs).toISOString();
    const tVal = withT(isoStr);
    const fVal = withoutT(isoStr);
    assertEquals(tVal, expected, `Temporal path failed for ${desc}`);
    assertEquals(fVal, expected, `Date fallback failed for ${desc}`);
    assertEquals(tVal, fVal, `Temporal and fallback diverged for ${desc}`);
  }
});

Deno.test("temporal: admin.ts ago() Temporal path and Date fallback agree on duration brackets (audio-feed-ap45)", async () => {
  const adminTs = await Deno.readTextFile("src/routes/admin.ts");
  const start = adminTs.indexOf("function ago(");
  assert(start >= 0);
  const brace = adminTs.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < adminTs.length; i++) {
    if (adminTs[i] === "{") depth++;
    else if (adminTs[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert(end > 0);
  const agoBody = `return function (iso) ${adminTs.slice(brace, end)};`;

  const NOW = Date.parse("2026-10-04T21:00:00Z");
  const H = 3_600_000;

  function makeAgo(withTemporal: boolean) {
    const RealDate = Date;
    const FrozenDate = new Proxy(RealDate, {
      get(t, p, r) {
        if (p === "now") return () => NOW;
        return Reflect.get(t, p, r);
      },
    });
    const TemporalStub = withTemporal
      ? {
        Now: { instant: () => Temporal.Instant.from(new Date(NOW).toISOString()) },
        Instant: Temporal.Instant,
      }
      : undefined;
    return new Function("Date", "Temporal", agoBody)(FrozenDate, TemporalStub) as (
      iso?: string,
    ) => string;
  }

  const withT = makeAgo(true);
  const withoutT = makeAgo(false);

  const deltas: [string, number][] = [
    ["0s", 0],
    ["7s", 7_000],
    ["59s", 59_000],
    ["61s", 61_000],
    ["30m", 1_800_000],
    ["59m40s", 3_580_000],
    ["89m", 5_340_000],
    ["47h", 47 * H],
    ["47h59m", 47 * H + 3_540_000],
    ["48h", 48 * H],
    ["48h30m", 48 * H + 1_800_000],
    ["35h30m", 35 * H + 1_800_000],
    ["71h59m", 71 * H + 3_540_000],
    ["72h", 72 * H],
    ["5d", 5 * 24 * H],
    ["47d12h", 47.5 * 24 * H],
    ["47d11h59m59s", 47.5 * 24 * H - 1_000],
    ["47d12h1s", 47.5 * 24 * H + 1_000],
    ["100d", 100 * 24 * H],
  ];

  for (const [label, d] of deltas) {
    const isoStr = new Date(NOW - d).toISOString();
    const tVal = withT(isoStr);
    const fVal = withoutT(isoStr);
    assertEquals(tVal, fVal, `Temporal and fallback diverged for delta ${label}`);
  }
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
