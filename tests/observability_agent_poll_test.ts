/**
 * Tests for the observability agent poll (audio-feed-yl6b).
 *
 * These exist to pin the SAFETY properties, not the happy path: an hourly job that spends money and
 * files tracker items has to be provably unable to spend when it should not, or "it seemed to work"
 * is no assurance at all. Every network or spend boundary is therefore injected, and the stubs
 * THROW when they are called in a test that asserts they are not - so the assertion is that the call
 * did not happen, not merely that nothing visibly failed.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { createTempChromeProfile } from "../scripts/proof-helper.ts";
import {
  BACKLOG_ALERT_HOURS,
  BACKLOG_FINGERPRINT,
  buildPrompt,
  type ErrorsPage,
  fileBead as realFileBead,
  type LogEvent,
  MAX_EVENTS_PER_RUN,
  MAX_PROMPT_BYTES,
  normaliseRoute,
  oldestRetainedFromProblem,
  openFingerprints as realOpenFingerprints,
  OVERSIZED_FINGERPRINT,
  ownsLock as realOwnsLock,
  parseSuggestions,
  type PollConfig,
  type PollState,
  type RankedSuggestion,
  resolveConfig,
  type RunDeps,
  runOnce,
  severityBand,
  type SummaryBody,
  utcDay,
} from "../scripts/observability-agent-poll.ts";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    seq: 1,
    time: "2026-10-11T12:00:00.000Z",
    severity: "error",
    type: "synthesis.claim",
    message: "claim write failed",
    route: "/api/items/91823",
    ...over,
  };
}

function config(dir: string, over: Partial<PollConfig> = {}): PollConfig {
  return {
    enabled: true,
    key: "test-key",
    baseUrl: "http://127.0.0.1:1",
    model: "test-model",
    geminiKey: "test-gemini-key",
    stateDir: dir,
    bdBin: "bd-that-must-not-run",
    dryRun: false,
    json: false,
    maxPromptBytes: MAX_PROMPT_BYTES,
    ...over,
  };
}

function summary(over: Partial<SummaryBody> = {}): SummaryBody {
  // Mirrors the REAL response (src/routes/observability.ts): decimal-string cursors, byType as a list,
  // and the idle signal expressed as total + truncated. The first version of this stub invented a
  // top-level `newest`, which is how a broken idle gate passed the tests.
  return {
    cursor: "10",
    since: "0",
    total: 1,
    bySeverity: {},
    byType: [],
    truncated: false,
    scanned: 1,
    window: { oldestRetained: 1, newest: 10 },
    ...over,
  };
}

function page(events: LogEvent[], over: Partial<ErrorsPage> = {}): ErrorsPage {
  const last = events.at(-1)?.seq ?? 0;
  return {
    events,
    cursor: String(last),
    hasMore: false,
    scanned: events.length,
    returned: events.length,
    window: { oldestRetained: 1, newest: last },
    ...over,
  };
}

/** A stub that records calls; `forbidden` ones throw, so "was not called" is a real assertion. */
function deps(
  over: Partial<RunDeps> = {},
): RunDeps & { calls: Record<string, number>; beadArgs: RankedSuggestion[] } {
  const calls: Record<string, number> = {};
  const beadArgs: RankedSuggestion[] = [];
  const bump = (n: string) => {
    calls[n] = (calls[n] ?? 0) + 1;
  };
  const forbidden = (n: string) => () => {
    bump(n);
    throw new Error(`${n} must not have been called in this test`);
  };
  const base = {
    now: () => new Date("2026-10-11T12:00:00.000Z"),
    fetchSummary: forbidden("fetchSummary"),
    fetchErrors: forbidden("fetchErrors"),
    openFingerprints: forbidden("openFingerprints"),
    fileBead: forbidden("fileBead"),
    callModel: forbidden("callModel"),
    // NOT a spend boundary, so the REAL one is the honest default: it reads the lock this run actually
    // holds in the temp dir and says yes. Tests that exercise the guard override it with a `false`.
    ownsLock: realOwnsLock,
  } as unknown as RunDeps;
  // OVERRIDES MUST BE COUNTED TOO. The first version of this helper only counted the forbidden stubs, so
  // an assertion like `calls.fetchErrors === 1` read `undefined` and failed for the wrong reason - and,
  // worse, it made a bite check vacuous, because the test failed whether or not the code was broken.
  const wrapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(over)) {
    if (typeof v === "function") {
      const fn = v as (...a: unknown[]) => unknown;
      wrapped[k] = (...args: unknown[]) => {
        bump(k);
        return fn(...args);
      };
    } else {
      wrapped[k] = v;
    }
  }
  return Object.assign(base, wrapped, { calls, beadArgs });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-agent-test-");
  try {
    return await fn(profileDir);
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------------------------
// (1) OFF unless enabled
// ---------------------------------------------------------------------------------------------

Deno.test("a disabled poll makes NO network call and NO model call (audio-feed-yl6b)", async () => {
  // Every boundary throws if touched, so this asserts the property directly: nothing was requested.
  await withTempDir(async (dir) => {
    const d = deps();
    const { artifact } = await runOnce(config(dir, { enabled: false }), d);
    assertEquals(artifact.reason, "disabled");
    assertEquals(artifact.state, "skipped");
    assertEquals(d.calls, {}, "a disabled poll must not call any boundary at all");
    assertEquals(artifact.modelCalls, 0);
  });
});

Deno.test("enablement requires BOTH the flag and a key (audio-feed-yl6b)", () => {
  const savedFlag = Deno.env.get("AUDIOFEED_OBSERVABILITY_AGENT_ENABLED");
  const savedKey = Deno.env.get("AUDIOFEED_OBSERVABILITY_KEY");
  try {
    Deno.env.set("AUDIOFEED_OBSERVABILITY_AGENT_ENABLED", "1");
    Deno.env.set("AUDIOFEED_OBSERVABILITY_KEY", "");
    assertEquals(resolveConfig([]).enabled, false, "a flag without a key must not enable spending");
    Deno.env.set("AUDIOFEED_OBSERVABILITY_KEY", "k");
    assertEquals(resolveConfig([]).enabled, true);
    Deno.env.set("AUDIOFEED_OBSERVABILITY_AGENT_ENABLED", "0");
    assertEquals(resolveConfig([]).enabled, false, "a key alone must not enable spending");
  } finally {
    for (
      const [k, v] of [["AUDIOFEED_OBSERVABILITY_AGENT_ENABLED", savedFlag], [
        "AUDIOFEED_OBSERVABILITY_KEY",
        savedKey,
      ]] as const
    ) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});

Deno.test("a concurrent run is refused, does no work, and writes NOTHING (audio-feed-yl6b)", async () => {
  // The daily ceiling is a construction only if two runs cannot both read the same counter and both
  // spend. This pins the exclusion, and pins that the loser of the race leaves the winner's state alone -
  // clobbering the cursor or the counters would be worse than making the extra call.
  await withTempDir(async (dir) => {
    const { acquireLock, LOCK_FILE } = await import("../scripts/observability-agent-poll.ts");
    const held = await acquireLock(dir, new Date("2026-10-11T12:00:00.000Z"));
    assertEquals(held, true, "the first run must get the lock");
    const d = deps();
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.reason, "locked");
    assertEquals(d.calls, {}, "a locked run must not reach any boundary");
    await assertRejects(() => Deno.stat(`${dir}/state.json`), Deno.errors.NotFound);
    await assertRejects(() => Deno.stat(`${dir}/digest.md`), Deno.errors.NotFound);
    assert((await Deno.stat(`${dir}/${LOCK_FILE}`)).isFile, "and it must not steal the lock");
  });
});

Deno.test("the lock is released at the end of a run, so the next one proceeds (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 0, truncated: false, scanned: 0 }),
        }),
    });
    await runOnce(config(dir), d);
    const second = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 0, truncated: false, scanned: 0 }),
        }),
    });
    const { artifact } = await runOnce(config(dir), second);
    assertEquals(
      artifact.reason,
      "idle",
      "the second run must not be refused by a lock left behind",
    );
  });
});

Deno.test("a stale lock from a killed run is reclaimed rather than wedging the poll (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const { acquireLock, LOCK_FILE, STALE_LOCK_MS } = await import(
      "../scripts/observability-agent-poll.ts"
    );
    // The lock's age is judged by the FILESYSTEM clock, deliberately: a run killed hard leaves a real
    // mtime, and an injected clock let the first version of this test pass while the real code would
    // have wedged. So age the FILE, not the clock.
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    await Deno.writeTextFile(`${dir}/${LOCK_FILE}`, "stale");
    await Deno.utime(`${dir}/${LOCK_FILE}`, old, old);
    assertEquals(
      await acquireLock(dir, new Date()),
      true,
      "a lock older than the stale window must be reclaimable, or one hard kill wedges the poll",
    );
    // A fresh lock must still exclude, or the exclusion is not an exclusion.
    await Deno.writeTextFile(`${dir}/${LOCK_FILE}`, "fresh");
    assertEquals(await acquireLock(dir, new Date()), false, "but a fresh lock must still exclude");
  });
});

// ---------------------------------------------------------------------------------------------
// (2) Caps are consulted BEFORE any spend
// ---------------------------------------------------------------------------------------------

Deno.test("the daily call ceiling stops the run before it fetches or calls a model (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/state.json`,
      JSON.stringify({
        cursor: 0,
        day: utcDay(new Date("2026-10-11T12:00:00.000Z")),
        callsToday: 24,
        inputTokensToday: 0,
        outputTokensToday: 0,
        lastRun: null,
        artifact: null,
      }),
    );
    const d = deps();
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.reason, "cap-daily-calls");
    assertEquals(d.calls, {}, "a capped run must not reach any boundary, not even the summary");
    assertEquals(artifact.modelCalls, 0);
  });
});

Deno.test("a daily token ceiling also stops the run before any fetch (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/state.json`,
      JSON.stringify({
        cursor: 0,
        day: utcDay(new Date("2026-10-11T12:00:00.000Z")),
        callsToday: 1,
        inputTokensToday: 400_000,
        outputTokensToday: 0,
        lastRun: null,
        artifact: null,
      }),
    );
    const d = deps();
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.reason, "cap-daily-input-tokens");
    assertEquals(d.calls, {});
  });
});

// ---------------------------------------------------------------------------------------------
// (3) Idle hours cost nothing
// ---------------------------------------------------------------------------------------------

Deno.test("when the summary shows no movement the run makes NO model call (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 0, truncated: false, scanned: 0 }),
        }),
    });
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.state, "idle");
    assertEquals(artifact.reason, "idle");
    assertEquals(artifact.modelCalls, 0);
    assertEquals(d.calls.fetchErrors, undefined, "an idle hour must not even fetch events");
  });
});

Deno.test("every run writes an artifact, including the ones that did nothing (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 0, truncated: false, scanned: 0 }),
        }),
    });
    await runOnce(config(dir), d);
    const state = JSON.parse(await Deno.readTextFile(`${dir}/state.json`)) as PollState;
    assertEquals(state.artifact?.reason, "idle");
    const digest = await Deno.readTextFile(`${dir}/digest.md`);
    assertMatch(digest, /state: idle \(idle\)/);
    assertMatch(digest, /BEHIND: no/);
  });
});

Deno.test("a summary with total 0 but truncated true is NOT idle: it must fetch (audio-feed-yl6b)", async () => {
  // The API documents that a bound full of FILTERED-OUT records reports total 0 WITH truncated true, and
  // that a caller which stops there never reaches the records behind them. So idleness needs BOTH terms,
  // and this test pins the second: a gate that looked at total alone would skip a page of real errors.
  await withTempDir(async (dir) => {
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 0, truncated: true, scanned: 500 }),
        }),
      fetchErrors: () => Promise.resolve({ ok: true as const, body: page([event()]) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      callModel: () =>
        Promise.resolve({ ok: true, text: "[]", inputTokens: 5, outputTokens: 2, error: null }),
      fileBead: () => Promise.resolve("audio-feed-fake1"),
    });
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(d.calls.fetchErrors, 1, "a truncated summary must not be read as nothing new");
    assert(artifact.reason !== "idle", `this run is not idle; got ${artifact.reason}`);
  });
});

// ---------------------------------------------------------------------------------------------
// (4) Dedupe happens BEFORE any spend
// ---------------------------------------------------------------------------------------------

Deno.test("events whose fingerprint is already open cause NO model call (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const e = event();
    // The open-bead set contains exactly this event's fingerprint, computed the same way.
    const { fingerprint } = await import("../scripts/observability-agent-poll.ts");
    const print = await fingerprint(e);
    const d = deps({
      fetchSummary: () => Promise.resolve({ ok: true as const, body: summary() }),
      fetchErrors: () => Promise.resolve({ ok: true as const, body: page([e]) }),
      openFingerprints: () => Promise.resolve(new Set([print])),
    });
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.reason, "fingerprints-already-open");
    assertEquals(artifact.modelCalls, 0, "the whole point of dedupe is not paying to re-rank it");
    assertEquals(artifact.fingerprintsSkipped, [print]);
    assertEquals(d.calls.callModel, undefined);
  });
});

Deno.test("the fingerprint IGNORES volatile fields and follows only type, severity and route (audio-feed-yl6b)", async () => {
  const { fingerprint } = await import("../scripts/observability-agent-poll.ts");
  const base = event();
  // Same root cause, different instance: message, seq, time and correlation id must not matter, or the
  // fingerprint changes every hour and dedupe never fires.
  const volatile = await Promise.all([
    fingerprint({ ...base, seq: 999, message: "totally different text", correlationId: "abc" }),
    fingerprint({ ...base, time: "2027-01-01T00:00:00.000Z", message: "another text", seq: 1 }),
    fingerprint({ ...base, route: "/api/items/55?x=1" }),
  ]);
  assertEquals(
    volatile[0],
    await fingerprint(base),
    "seq/message/correlationId must not change it",
  );
  assertEquals(volatile[1], await fingerprint(base), "time must not change it");
  assertEquals(
    volatile[2],
    await fingerprint(base),
    "a different id in the path must not change it",
  );
  // And the three fields that SHOULD matter do.
  assert(await fingerprint({ ...base, type: "csp.violation" }) !== await fingerprint(base));
  assert(await fingerprint({ ...base, severity: "warn" }) !== await fingerprint(base));
  assert(await fingerprint({ ...base, route: "/api/other" }) !== await fingerprint(base));
});

Deno.test("route normalisation collapses volatile segments only (audio-feed-yl6b)", () => {
  assertEquals(normaliseRoute("/api/items/91823"), "/api/items/:id");
  assertEquals(normaliseRoute("/api/items/55?x=1"), "/api/items/:id");
  // `feed` is a literal path segment: only the volatile ID collapses, so the expectation is
  // /api/feed/:id. The first version of this test asserted /api/:id and the CODE was right.
  assertEquals(normaliseRoute("/api/feed/abc123def456ghi789jkl"), "/api/feed/:id");
  assertEquals(normaliseRoute("/api/summary"), "/api/summary");
  assertEquals(normaliseRoute(undefined), "unknown");
  assertEquals(severityBand("error"), "high");
  assertEquals(severityBand("warn"), "medium");
});

// ---------------------------------------------------------------------------------------------
// (5) Bounded input, and a cursor that never passes unfiled work
// ---------------------------------------------------------------------------------------------

Deno.test("the prompt is bounded by BYTES as well as rows (audio-feed-yl6b)", () => {
  const many = Array.from(
    { length: 500 },
    (_, i) => event({ seq: i + 1, message: "x".repeat(500) }),
  );
  const built = buildPrompt(many);
  assert(
    built.bytes <= MAX_PROMPT_BYTES,
    `prompt must stay under the byte cap, was ${built.bytes}`,
  );
  assert(built.eventsSent <= MAX_EVENTS_PER_RUN);
  assertEquals(built.truncated, true);
  assertEquals(
    built.backlog,
    500 - built.eventsSent,
    "the backlog must be reported, not swallowed",
  );
});

Deno.test("a truncated run advances the cursor only past what it SENT (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const many = Array.from({ length: 300 }, (_, i) => event({ seq: i + 1 }));
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 300, window: { oldestRetained: 1, newest: 300 } }),
        }),
      fetchErrors: () =>
        Promise.resolve({ ok: true as const, body: page(many, { hasMore: true }) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      callModel: () =>
        Promise.resolve({ ok: true, text: "[]", inputTokens: 100, outputTokens: 10, error: null }),
      fileBead: () => Promise.resolve("audio-feed-fake1"),
    });
    const { artifact, state } = await runOnce(config(dir), d);
    assertEquals(artifact.truncated, true);
    assert(
      artifact.cursorAfter <= artifact.eventsSeen,
      `cursor ${artifact.cursorAfter} must not pass the ${artifact.eventsSeen} events seen`,
    );
    assert(artifact.backlog > 0, "a capped run must report how much it left behind");
    assert(
      state.cursor === artifact.cursorAfter,
      "the persisted cursor must equal the artifact, or a restart loses coverage",
    );
    assertEquals(artifact.pagesRemaining >= 1, true, "pages remaining must be stated, not implied");
  });
});

Deno.test("the newest unsent event age is recorded, and a stale backlog files ONE stable bead (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    // 300 events, the tail of them hours old: the run cannot drain it, so the poll reports itself behind.
    const many = Array.from(
      { length: 300 },
      (_, i) =>
        event({
          seq: i + 1,
          time: new Date(Date.parse("2026-10-11T12:00:00.000Z") - 8 * 3_600_000).toISOString(),
        }),
    );
    const filed: RankedSuggestion[] = [];
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 300, window: { oldestRetained: 1, newest: 300 } }),
        }),
      fetchErrors: () =>
        Promise.resolve({ ok: true as const, body: page(many, { hasMore: true }) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      callModel: () =>
        Promise.resolve({ ok: true, text: "[]", inputTokens: 10, outputTokens: 5, error: null }),
      fileBead: (_bin, suggestion) => {
        filed.push(suggestion);
        return Promise.resolve(`audio-feed-fake${filed.length}`);
      },
    });
    const { artifact } = await runOnce(config(dir), d);
    assert(
      artifact.newestUnsentAgeHours !== null &&
        artifact.newestUnsentAgeHours >= BACKLOG_ALERT_HOURS,
      `expected a stale backlog, got ${artifact.newestUnsentAgeHours}`,
    );
    const backlogBead = filed.find((s) => s.fingerprints.includes(BACKLOG_FINGERPRINT));
    assert(backlogBead !== undefined, "a structurally behind poll must surface itself as a bead");
    // The stable fingerprint is what stops it re-filing every hour: the dedupe check skips it next run.
    assertEquals(backlogBead.fingerprints, [BACKLOG_FINGERPRINT]);
  });
});

// ---------------------------------------------------------------------------------------------
// (6) Failures: no retry, no cursor movement, spend still recorded
// ---------------------------------------------------------------------------------------------

Deno.test("a model failure is not retried, the cursor holds, and the call is still counted (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    let modelCalls = 0;
    const d = deps({
      fetchSummary: () => Promise.resolve({ ok: true as const, body: summary() }),
      fetchErrors: () => Promise.resolve({ ok: true as const, body: page([event()]) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      callModel: () => {
        modelCalls++;
        return Promise.resolve({
          ok: false,
          text: "",
          inputTokens: 0,
          outputTokens: 0,
          error: "http 503",
        });
      },
    });
    const { artifact, state } = await runOnce(config(dir), d);
    assertEquals(
      modelCalls,
      1,
      "exactly one attempt: a retry inside a run is how a cap becomes decorative",
    );
    assertEquals(artifact.state, "failed");
    assertEquals(artifact.reason, "model-failed");
    assertEquals(
      artifact.cursorAfter,
      artifact.cursorBefore,
      "the window must be retried next hour",
    );
    assertEquals(state.callsToday, 1, "the spend is recorded even though the call failed");
  });
});

// ---------------------------------------------------------------------------------------------
// (7) Retention: 410 resumes from the named sequence and REPORTS the gap
// ---------------------------------------------------------------------------------------------

Deno.test("a 410 cursor_too_old resumes from the named sequence and records the gap (audio-feed-yl6b)", async () => {
  assertEquals(
    oldestRetainedFromProblem({
      detail:
        "Events after sequence 7 are no longer retained. Oldest retained: 40. Resume from that sequence.",
    }),
    40,
  );
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/state.json`,
      JSON.stringify({
        cursor: 7,
        day: utcDay(new Date("2026-10-11T12:00:00.000Z")),
        callsToday: 0,
        inputTokensToday: 0,
        outputTokensToday: 0,
        lastRun: null,
        artifact: null,
      }),
    );
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: false as const,
          status: 410,
          body: {
            detail:
              "Events after sequence 7 are no longer retained. Oldest retained: 40. Resume from that sequence.",
          },
        }),
      // After resuming, the poll continues and finds nothing rankable: that keeps this test about the gap.
      fetchErrors: () => Promise.resolve({ ok: true as const, body: page([]) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
    });
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.gapReported, { from: 7, resumedAt: 40 });
    const digest = await Deno.readTextFile(`${dir}/digest.md`);
    assertMatch(digest, /GAP: cursor 7 was no longer retained; resumed at 40/);
  });
});

Deno.test("a 410 with no named sequence is a failure, not a silent restart (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({ ok: false as const, status: 410, body: { detail: "gone" } }),
    });
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.state, "failed");
    assertEquals(artifact.reason, "api-failed");
    assertEquals(artifact.gapReported, null);
  });
});

// ---------------------------------------------------------------------------------------------
// (8) The API key travels in a header, never in the URL
// ---------------------------------------------------------------------------------------------

Deno.test("the observability key is sent as an Authorization header and never in the URL (audio-feed-yl6b)", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    seen.push({ url: req.url, auth: req.headers.get("authorization") });
    return Response.json(summary({ total: 0, truncated: false, scanned: 0 }));
  });
  try {
    const { fetchSummary } = await import("../scripts/observability-agent-poll.ts");
    const port = (server.addr as Deno.NetAddr).port;
    const res = await fetchSummary(
      config("unused", { baseUrl: `http://127.0.0.1:${port}`, key: "s3cret-value" }),
      5,
    );
    assertEquals(res.ok, true);
    assertEquals(seen.length, 1);
    const first = seen[0];
    assert(first !== undefined, "the server must have seen exactly one request");
    assertEquals(first.auth, "Bearer s3cret-value");
    assert(
      !first.url.includes("s3cret-value"),
      `the key must not appear in the URL, which is what gets logged: ${first.url}`,
    );
    assertMatch(first.url, /since=5/);
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------------------------
// (9) The bd integration, exercised through a real executable rather than a stub
// ---------------------------------------------------------------------------------------------

Deno.test("beads are filed through the bd CLI and open fingerprints are read back (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    // A fake bd on disk: this exercises the Deno.Command path and the --bd-bin convention, which is the
    // part a stub would hide.
    const bin = `${dir}/fake-bd`;
    await Deno.writeTextFile(
      bin,
      `#!/bin/sh
if [ "$1" = "list" ]; then
  echo '[{"id":"audio-feed-open1","title":"existing","description":"fingerprint:deadbeefdeadbeef","status":"open"}]'
  exit 0
fi
if [ "$1" = "create" ]; then
  echo '{"id":"audio-feed-new1"}'
  exit 0
fi
echo "unexpected" >&2
exit 1
`,
    );
    await Deno.chmod(bin, 0o755);
    const { openFingerprints, fileBead } = await import("../scripts/observability-agent-poll.ts");
    const open = await openFingerprints(bin);
    assert(
      open.has("deadbeefdeadbeef"),
      `expected the open fingerprint to be parsed, got ${[...open]}`,
    );
    const id = await fileBead(
      bin,
      {
        title: "ranked fix",
        impact: "i",
        fix: "f",
        events: 2,
        fingerprints: ["aaaa1111bbbb2222"],
      },
      { startedAt: "2026-10-11T12:00:00.000Z", cursorBefore: 0, cursorAfter: 2 },
      false,
    );
    assertEquals(id, "audio-feed-new1");
  });
});

Deno.test("a dry run files nothing even through a working bd (audio-feed-yl6b)", async () => {
  await withTempDir(async (dir) => {
    const bin = `${dir}/fake-bd`;
    await Deno.writeTextFile(bin, `#!/bin/sh\necho '{"id":"should-not-happen"}'\n`);
    await Deno.chmod(bin, 0o755);
    const { fileBead } = await import("../scripts/observability-agent-poll.ts");
    const id = await fileBead(
      bin,
      {
        title: "t",
        impact: "i",
        fix: "f",
        events: 1,
        fingerprints: ["aaaa1111bbbb2222"],
      },
      { startedAt: "2026-10-11T12:00:00.000Z", cursorBefore: 0, cursorAfter: 1 },
      true,
    );
    assertEquals(id, null);
  });
});

// ---------------------------------------------------------------------------------------------
// (10) The model's reply is parsed defensively
// ---------------------------------------------------------------------------------------------

Deno.test("a malformed or empty model reply files nothing rather than a garbage bead (audio-feed-yl6b)", () => {
  assertEquals(parseSuggestions("not json at all"), []);
  assertEquals(parseSuggestions(""), []);
  assertEquals(parseSuggestions("```json\n[{}\n```"), []);
  assertEquals(parseSuggestions('[{"title":""}]'), []);
  const ok = parseSuggestions(
    '```json\n[{"title":"Fix the claim CAS","impact":"lost writes","fix":"retry the CAS","events":3,"fingerprints":["ab"]}]\n```',
  );
  assertEquals(ok.length, 1);
  const only = ok[0];
  assert(only !== undefined, "the suggestion must have parsed");
  assertEquals(only.title, "Fix the claim CAS");
  assertEquals(only.fingerprints, ["ab"]);
});

// ---------------------------------------------------------------------------------------------
// Review findings from rev-yl6b (zxhv, w0b5, 9l6v) - each pinned by a test that bites
// ---------------------------------------------------------------------------------------------

Deno.test("a persistent backlog keeps ONE bead: the SECOND run consults the open set (audio-feed-zxhv)", async () => {
  // The first version of the backlog test never ran twice, so it passed while the poll filed an
  // identical bead EVERY hour: the stable fingerprint it was built on was never checked against the
  // open set. This is the test whose absence made that a false green.
  await withTempDir(async (dir) => {
    const old = new Date(Date.parse("2026-10-11T12:00:00.000Z") - 8 * 3_600_000).toISOString();
    const many = Array.from({ length: 300 }, (_, i) => event({ seq: i + 1, time: old }));
    const backend = (open: Set<string>, filed: RankedSuggestion[]) =>
      deps({
        fetchSummary: () =>
          Promise.resolve({
            ok: true as const,
            body: summary({ total: 300, window: { oldestRetained: 1, newest: 300 } }),
          }),
        fetchErrors: () =>
          Promise.resolve({ ok: true as const, body: page(many, { hasMore: true }) }),
        openFingerprints: () => Promise.resolve(open),
        callModel: () =>
          Promise.resolve({ ok: true, text: "[]", inputTokens: 10, outputTokens: 5, error: null }),
        fileBead: (_bin, suggestion) => {
          filed.push(suggestion);
          return Promise.resolve(`audio-feed-fake${filed.length}`);
        },
      });
    const first: RankedSuggestion[] = [];
    await runOnce(config(dir), backend(new Set<string>(), first));
    assertEquals(
      first.filter((s) => s.fingerprints.includes(BACKLOG_FINGERPRINT)).length,
      1,
      "the first run reports the backlog once",
    );
    const second: RankedSuggestion[] = [];
    await runOnce(config(dir), backend(new Set([BACKLOG_FINGERPRINT]), second));
    assertEquals(
      second.filter((s) => s.fingerprints.includes(BACKLOG_FINGERPRINT)).length,
      0,
      "a second run on a still-behind poll must NOT file another backlog bead",
    );
  });
});

Deno.test("one event always fits the prompt, so the oversized branch is a safety net (audio-feed-w0b5)", () => {
  // The reviewer's wedge needs a single event larger than MAX_PROMPT_BYTES. The rendering slices `message`
  // to 300 characters and every other LogEvent field is short, so that cannot happen today: this test
  // records WHY, so a future change to the slicing bound - or a new field on LogEvent - is caught here
  // rather than turning into a silent wedge in production. The cursor-advance branch stays as the net.
  const giant = event({
    seq: 1,
    message: "x".repeat(200_000),
    route: "/api/" + "y".repeat(20_000),
    correlationId: "z".repeat(50_000),
  });
  const built = buildPrompt([giant]);
  assertEquals(built.eventsSent, 1, "a single event must always fit the prompt on its own");
  assert(built.bytes <= MAX_PROMPT_BYTES, `rendered ${built.bytes} bytes exceeds the cap`);
});

Deno.test("a dropped event is recorded with its fingerprint and reported ONCE (audio-feed-w0b5)", async () => {
  // The drop path is unreachable at the default cap, because one rendered event always fits (pinned by
  // the test above), so it is made reachable here by injecting a tiny cap. TWO RUNS, because the first
  // version of the backlog test taught the lesson that a single-run test cannot observe a dedupe: the
  // second run must file no second bead, which is why the identity is a stable constant and not the
  // record's own fingerprint.
  await withTempDir(async (dir) => {
    const filed: RankedSuggestion[] = [];
    const backend = (open: Set<string>) =>
      deps({
        fetchSummary: () =>
          Promise.resolve({
            ok: true as const,
            body: summary({ total: 1, window: { oldestRetained: 1, newest: 7 } }),
          }),
        fetchErrors: () =>
          Promise.resolve({
            ok: true as const,
            body: page([event({ seq: 7, message: "x".repeat(5_000) })]),
          }),
        openFingerprints: () => Promise.resolve(open),
        fileBead: (_bin, suggestion) => {
          filed.push(suggestion);
          return Promise.resolve(`audio-feed-fake${filed.length}`);
        },
      });
    const cfg = { ...config(dir), maxPromptBytes: 200 };

    const { artifact, state } = await runOnce(cfg, backend(new Set<string>()));
    assertEquals(artifact.reason, "oversized");
    assertEquals(
      artifact.skippedOversized?.seq,
      7,
      "the dropped record must be identifiable by seq",
    );
    assertEquals(
      typeof artifact.skippedOversized?.fingerprint,
      "string",
      "and by its own fingerprint, so an operator can find what was lost",
    );
    assertEquals(
      state.cursor,
      7,
      "the cursor MUST advance past it, or every run refetches it and the poll wedges forever",
    );
    assertEquals(artifact.modelCalls, 0, "a dropped event must not cost a call");
    assert(
      artifact.note !== null && artifact.note.includes("NOT analysed"),
      "the drop must be recorded in the artifact, not silent",
    );
    const drops = () => filed.filter((s) => s.fingerprints.includes(OVERSIZED_FINGERPRINT)).length;
    assertEquals(drops(), 1, "a drop must surface, so a loss of coverage is not a quiet success");

    // Second run: still dropping, with the stable fingerprint now open. It must NOT report again.
    await runOnce(cfg, backend(new Set([OVERSIZED_FINGERPRINT])));
    assertEquals(
      drops(),
      1,
      "a persistently unsendable record must keep ONE bead, not file one every hour",
    );
  });
});

Deno.test("both stable fingerprints obey the shape the parser accepts (audio-feed-zxhv)", async () => {
  // The invariant behind the finding: a stable constant is only a dedupe if the PARSER can read it back,
  // and openFingerprints accepts exactly 16 hex. Both constants were non-hex, so both dedupes were dead
  // code that looked alive - which is precisely why this needs its own guard rather than one big test.
  const { FINGERPRINT_MARKER } = await import("../scripts/observability-agent-poll.ts");
  const shape = /^[0-9a-f]{16}$/;
  for (
    const [name, value] of [
      ["BACKLOG_FINGERPRINT", BACKLOG_FINGERPRINT],
      ["OVERSIZED_FINGERPRINT", OVERSIZED_FINGERPRINT],
    ] as const
  ) {
    assert(shape.test(value), `${name} is not 16 hex, so nothing can read it back: ${value}`);
    const parsed = new Set<string>();
    const sample =
      `Fingerprints: ${FINGERPRINT_MARKER}${value}, ${FINGERPRINT_MARKER}aaaa1111bbbb2222`;
    for (const m of sample.matchAll(new RegExp(`${FINGERPRINT_MARKER}([0-9a-f]{16})`, "g"))) {
      const hex = m[1];
      if (hex !== undefined) parsed.add(hex);
    }
    assert(parsed.has(value), `${name} does not round-trip through the parser's marker`);
  }
});

Deno.test("the backlog dedupe ROUND-TRIPS through real bd output (audio-feed-zxhv)", async () => {
  // THE BUG THIS PINS: the first fix checked alreadyOpen.has(BACKLOG_FINGERPRINT), but the constant was
  // "backlog0structural" while openFingerprints accepts only 16 hex, so that check could never be true and
  // a poll behind for a week still filed a bead an hour. The earlier test passed because it HANDED
  // alreadyOpen a Set already containing the constant: it stubbed the exact boundary that was broken.
  //
  // So this goes through the real fileBead and the real openFingerprints over a fake bd that STORES the
  // description it was given and REPLAYS it on list, which is the only way to see a broken round trip.
  await withTempDir(async (dir) => {
    const store = `${dir}/beads`;
    const bin = `${dir}/fake-bd`;
    await Deno.writeTextFile(
      bin,
      `#!/bin/sh
store="${store}"
mkdir -p "$store"
if [ "$1" = "list" ]; then
  printf '['
  first=1
  for f in "$store"/*.txt; do
    [ -e "$f" ] || continue
    [ "$first" -eq 0 ] && printf ','
    first=0
    desc=$(sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' "$f")
    printf '{"id":"%s","title":"t","description":"%s","status":"open"}' "$(basename "$f" .txt)" "$desc"
  done
  printf ']\\n'
  exit 0
fi
if [ "$1" = "create" ]; then
  desc=""
  prev=""
  for a in "$@"; do
    [ "$prev" = "--description" ] && desc="$a"
    prev="$a"
  done
  id="audio-feed-fake$(ls "$store" | wc -l)"
  printf '%s' "$desc" > "$store/$id.txt"
  printf '{"id":"%s"}\\n' "$id"
  exit 0
fi
echo unexpected >&2
exit 1
`,
    );
    await Deno.chmod(bin, 0o755);

    const old = new Date(Date.parse("2026-10-11T12:00:00.000Z") - 8 * 3_600_000).toISOString();
    const many = Array.from({ length: 300 }, (_, i) => event({ seq: i + 1, time: old }));
    // The event TYPE differs per run on purpose. With one type, run two's events are all already open
    // (run one filed a catch-all bead carrying their fingerprints), so the dedupe skips every event and
    // the run returns through the drop branch WITHOUT ever reaching the backlog logic - which is how the
    // first version of this test passed against a constant that could not be read back at all.
    const backend = (type: string) =>
      deps({
        fetchSummary: () =>
          Promise.resolve({
            ok: true as const,
            body: summary({ total: 300, window: { oldestRetained: 1, newest: 300 } }),
          }),
        fetchErrors: () =>
          Promise.resolve({
            ok: true as const,
            body: page(many.map((e) => ({ ...e, type })), { hasMore: true }),
          }),
        openFingerprints: () => realOpenFingerprints(bin),
        fileBead: (b, suggestion, run, dryRun) => realFileBead(b, suggestion, run, dryRun),
        callModel: () =>
          Promise.resolve({ ok: true, text: "[]", inputTokens: 10, outputTokens: 5, error: null }),
      });
    const cfg = { ...config(dir), bdBin: bin };
    await runOnce(cfg, backend("synthesis.claim"));
    await runOnce(cfg, backend("synthesis.publish"));

    let backlogBeads = 0;
    for await (const entry of Deno.readDir(store)) {
      const text = await Deno.readTextFile(`${store}/${entry.name}`);
      if (text.includes(`fingerprint:${BACKLOG_FINGERPRINT}`)) backlogBeads++;
    }
    assertEquals(
      backlogBeads,
      1,
      `two runs of a still-behind poll must leave ONE backlog bead; found ${backlogBeads}. ` +
        `Zero means the constant is not 16 hex and openFingerprints cannot read it back.`,
    );
  });
});

Deno.test("a disabled run does not release a lock it does not own (audio-feed-jmkm)", async () => {
  // finish() released unconditionally, so a DISABLED invocation deleted a live run's lock and let a
  // second run in - the exact race the lock exists to prevent.
  await withTempDir(async (dir) => {
    const { acquireLock, LOCK_FILE } = await import("../scripts/observability-agent-poll.ts");
    assertEquals(await acquireLock(dir, new Date()), true, "another run holds the lock");
    const d = deps();
    const { artifact } = await runOnce({ ...config(dir), enabled: false, key: null }, d);
    assertEquals(artifact.reason, "disabled");
    const still = await Deno.stat(`${dir}/${LOCK_FILE}`).then(() => true).catch(() => false);
    assert(still, "a disabled run must NOT delete another run's lock");
  });
});

Deno.test("the call is reserved durably BEFORE the model is invoked (audio-feed-nvog)", async () => {
  // An in-memory increment is not a bound: kill the process inside the call and the spend happened while
  // the durable counter still read zero, so a 24/day ceiling is exceeded across timer runs.
  await withTempDir(async (dir) => {
    let durableAtSpend: PollState | null = null;
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 1, window: { oldestRetained: 1, newest: 1 } }),
        }),
      fetchErrors: () => Promise.resolve({ ok: true as const, body: page([event({ seq: 1 })]) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      callModel: async () => {
        // Read the DURABLE state at the moment of spend: the process could die right here.
        durableAtSpend = JSON.parse(await Deno.readTextFile(`${dir}/state.json`)) as PollState;
        return { ok: true, text: "[]", inputTokens: 10, outputTokens: 5, error: null };
      },
      fileBead: () => Promise.resolve("audio-feed-fake1"),
    });
    await runOnce(config(dir), d);
    assert(durableAtSpend !== null, "the model must have been called");
    const atSpend = durableAtSpend as PollState;
    assert(
      atSpend.callsToday >= 1,
      `the call must be persisted BEFORE it is made; durable state said ${atSpend.callsToday}`,
    );
    assert(
      atSpend.inputTokensToday > 0 && atSpend.outputTokensToday > 0,
      "and the worst-case tokens must be reserved, not only counted afterwards",
    );
  });
});

Deno.test("a failed bd create HOLDS the cursor instead of advancing past the event (audio-feed-hoow)", async () => {
  // fileBead returns null when bd exits non-zero or returns unreadable output. Advancing anyway lost
  // those events for good while the artifact claimed they were filed.
  await withTempDir(async (dir) => {
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 1, window: { oldestRetained: 1, newest: 1 } }),
        }),
      fetchErrors: () => Promise.resolve({ ok: true as const, body: page([event({ seq: 1 })]) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      callModel: () =>
        Promise.resolve({ ok: true, text: "[]", inputTokens: 10, outputTokens: 5, error: null }),
      fileBead: () => Promise.resolve(null), // bd refused it
    });
    const { artifact, state } = await runOnce(config(dir), d);
    assertEquals(artifact.reason, "bead-failed");
    assertEquals(state.cursor, 0, "the cursor MUST hold, or the event is never seen again");
    assertEquals(artifact.cursorAfter, 0, "and the artifact must not claim it advanced");
    assertEquals(
      artifact.fingerprintsFiled.length,
      0,
      "nothing may be reported as filed when bd refused it",
    );
    assertEquals(artifact.state, "failed", "and the run must not report success");
  });
});

Deno.test("two concurrent reclaims of one stale lock: exactly ONE wins, every round (audio-feed-131z)", async () => {
  // The defect: the reclaim path wrote the lock file (a plain overwrite) instead of using the exclusive
  // create the normal path uses, so two invocations both stat'd the same stale mtime, both overwrote, and
  // BOTH believed they held the lock - the reviewer measured 199/200 rounds. Each then loaded state before
  // the other's reservation was durable, so both reserved and both called the model, which is how Paul's
  // 24/day ceiling gets exceeded by the mechanism meant to enforce it.
  //
  // This asserts the PROPERTY, not a lucky run: over many rounds, the number of winners is exactly one,
  // every time. A single round cannot distinguish "fixed" from "raced and got away with it".
  await withTempDir(async (dir) => {
    const { acquireLock, releaseLock, LOCK_FILE, STALE_LOCK_MS } = await import(
      "../scripts/observability-agent-poll.ts"
    );
    const rounds = 40;
    const winners: number[] = [];
    for (let i = 0; i < rounds; i++) {
      // A stale lock as a killed run leaves it, aged on the FILESYSTEM clock because that is what the
      // reclaim judges.
      const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
      await Deno.writeTextFile(`${dir}/${LOCK_FILE}`, `stale from a killed run, round ${i}`);
      await Deno.utime(`${dir}/${LOCK_FILE}`, old, old);

      const now = new Date();
      const results = await Promise.all([acquireLock(dir, now), acquireLock(dir, now)]);
      winners.push(results.filter(Boolean).length);
      await releaseLock(dir); // unconditional cleanup between rounds, no token
    }
    assertEquals(
      winners.filter((w) => w !== 1).length,
      0,
      `every round must have exactly one winner; got ${JSON.stringify(winners)}`,
    );
  });
});

Deno.test("release refuses to delete a lock whose token is not this run's (audio-feed-131z)", async () => {
  // If a stale reclaim moved our lock aside and another run took over, releasing by name would delete a
  // LIVE lock and let a third run in. Ownership is the token, so it is checkable rather than assumed.
  await withTempDir(async (dir) => {
    const { acquireLock, releaseLock, LOCK_FILE, lockToken } = await import(
      "../scripts/observability-agent-poll.ts"
    );
    const mine = lockToken(new Date());
    assertEquals(await acquireLock(dir, new Date(), mine), true);
    await releaseLock(dir, "some-other-run's-token");
    const survived = await Deno.stat(`${dir}/${LOCK_FILE}`).then(() => true).catch(() => false);
    assert(survived, "a release with the wrong token must leave the lock alone");
    await releaseLock(dir, mine);
    const gone = await Deno.stat(`${dir}/${LOCK_FILE}`).then(() => true).catch(() => false);
    assert(!gone, "a release with the right token must remove it");
  });
});

Deno.test("the backlog is newest minus the cursor advanced to, with no second term (audio-feed-95jc)", async () => {
  // The defect: backlog = beyondPage + remainingInPage, but (window.newest - advanceTo) ALREADY contains
  // the events left unsent in the page, so the in-page remainder was counted twice - the digest and the
  // backlog bead overstated how far behind the poll was (measured 1100 against a true 800). Asserted as a
  // PROPERTY against the cursor the run actually advanced to, so a reintroduced extra term fails it.
  await withTempDir(async (dir) => {
    const old = new Date(Date.parse("2026-10-11T12:00:00.000Z") - 8 * 3_600_000).toISOString();
    const many = Array.from({ length: 300 }, (_, i) => event({ seq: i + 1, time: old }));
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 300, window: { oldestRetained: 1, newest: 300 } }),
        }),
      fetchErrors: () =>
        Promise.resolve({ ok: true as const, body: page(many, { hasMore: true }) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      callModel: () =>
        Promise.resolve({ ok: true, text: "[]", inputTokens: 10, outputTokens: 5, error: null }),
      fileBead: (_b, s) => Promise.resolve(`audio-feed-fake-${s.title.length}`),
    });
    const { artifact } = await runOnce(config(dir), d);

    // The run is genuinely capped, so there IS an in-page remainder - without that the extra term could
    // never have been visible and this test would pass against the broken version.
    assertEquals(artifact.truncated, true);
    assert(
      artifact.eventsSent < 300,
      `the prompt must have been capped for this to be a real test; sent ${artifact.eventsSent}`,
    );
    assertEquals(
      artifact.backlog,
      300 - artifact.cursorAfter,
      `backlog must be newest - cursorAfter; got ${artifact.backlog} for cursorAfter ` +
        `${artifact.cursorAfter}, which double-counts if it equals ` +
        `${300 - artifact.cursorAfter + (300 - artifact.eventsSent)}`,
    );
    assertEquals(
      artifact.pagesRemaining,
      Math.max(1, Math.ceil(artifact.backlog / MAX_EVENTS_PER_RUN)),
    );
  });
});

Deno.test("restoring a displaced lock never replaces a live one (audio-feed-131z)", async () => {
  // Finding 2: the restore wrote unconditionally, so a run putting its own lock back could delete a lock a
  // third run had acquired in the meantime. The property is that the restore either puts the file back and
  // says so, or loses the race and leaves the live lock untouched - never replaces it. Deterministic,
  // because the hazard is in this one step rather than in the timing.
  await withTempDir(async (dir) => {
    const { restoreIfFree, LOCK_FILE } = await import("../scripts/observability-agent-poll.ts");
    const path = `${dir}/${LOCK_FILE}`;
    const clobbered: number[] = [];
    for (let i = 0; i < 40; i++) {
      const displaced = `${dir}/displaced-${i}`;
      await Deno.writeTextFile(displaced, `holder B, round ${i}`);
      await Deno.writeTextFile(path, `holder C LIVE, round ${i}`);
      const restored = await restoreIfFree(displaced, path);
      const after = await Deno.readTextFile(path).catch(() => "<ABSENT>");
      if (restored || !after.startsWith("holder C LIVE")) clobbered.push(i);
    }
    assertEquals(
      clobbered,
      [],
      `the live lock was replaced (or reported as restored) in rounds ${clobbered.join(",")}`,
    );
  });
});

Deno.test("a release racing an acquire never leaves the winner holding nothing (audio-feed-131z)", async () => {
  // Finding 1: release checked the token and THEN removed, two separate moments. A run whose lease had
  // been reclaimed could pass the check, another run could take the lock, and the remove would then delete
  // the NEW holder's lock - leaving it running with the path free for a third. Forty rounds of real
  // concurrency, because the failure is a window rather than a step.
  await withTempDir(async (dir) => {
    const { acquireLock, releaseLock, lockToken, LOCK_FILE, STALE_LOCK_MS } = await import(
      "../scripts/observability-agent-poll.ts"
    );
    const path = `${dir}/${LOCK_FILE}`;
    const broken: string[] = [];
    for (let i = 0; i < 40; i++) {
      const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
      const aToken = lockToken(new Date());
      await Deno.writeTextFile(path, aToken);
      await Deno.utime(path, old, old);
      const now = new Date();
      const bToken = lockToken(now);
      const [, bAcquired] = await Promise.all([
        releaseLock(dir, aToken),
        acquireLock(dir, now, bToken),
      ]);
      if (!bAcquired) continue; // B stood down: nothing to protect this round
      const after = await Deno.readTextFile(path).catch(() => "<ABSENT>");
      if (after !== bToken) broken.push(`${i}:${after === "<ABSENT>" ? "ABSENT" : "wrong-token"}`);
      await releaseLock(dir, bToken);
    }
    assertEquals(
      broken,
      [],
      `B acquired the lock but the path did not hold B's token in rounds ${broken.join(",")}`,
    );
  });
});

Deno.test("a run that lost its lease stands down without spending (audio-feed-131z)", async () => {
  // The guard on the spend itself: every lock transition is atomic now, but a run reclaimed as stale can
  // still be alive and about to call the model. One ownership read before the call turns that into an
  // idle hour instead of a second call against a ceiling another run is also counting.
  await withTempDir(async (dir) => {
    const old = new Date(Date.parse("2026-10-11T12:00:00.000Z") - 8 * 3_600_000).toISOString();
    const d = deps({
      fetchSummary: () =>
        Promise.resolve({
          ok: true as const,
          body: summary({ total: 2, window: { oldestRetained: 1, newest: 2 } }),
        }),
      fetchErrors: () =>
        Promise.resolve({ ok: true as const, body: page([event({ seq: 1, time: old })]) }),
      openFingerprints: () => Promise.resolve(new Set<string>()),
      // The lease was reclaimed under us.
      ownsLock: () => Promise.resolve(false),
    });
    const { artifact } = await runOnce(config(dir), d);
    assertEquals(artifact.reason, "lock-lost");
    assertEquals(artifact.modelCalls, 0);
    assertEquals(d.calls.callModel ?? 0, 0, "the model must not be called once the lease is gone");
    assertEquals(artifact.cursorAfter, artifact.cursorBefore, "the cursor must not move");
    assertEquals(d.calls.fileBead ?? 0, 0, "and no bead may be filed on someone else's turn");
  });
});

Deno.test("the daily cap is read under the lock, not from a snapshot taken outside it (audio-feed-131z)", async () => {
  // The ordering defect: runOnce loaded the cursor and counters and THEN acquired the lock, so the cap was
  // checked against a snapshot taken outside the exclusion. A prior holder could finish its 24th call after
  // our load and before our acquire, and this run would then make a 25th PAID call and write the counter
  // back to 24 - exceeding the ceiling AND advancing the counter to a value lower than the truth, which is
  // worse than either alone because the regression hides the overspend from every later cap check.
  //
  // The interleaving is INJECTED rather than timed: the completion is written from the now() hook, which
  // runs before any state is read. It writes on every call AFTER the first, because the first now() is the
  // run's own timestamp - a hook that only fired there would finish before the state was read and would
  // pass against the broken order too, which is exactly the kind of vacuous test this branch has been bitten
  // by. Do not "simplify" it to the first call.
  await withTempDir(async (dir) => {
    const { loadState, saveState } = await import("../scripts/observability-agent-poll.ts");
    const at = new Date("2026-10-11T12:00:00.000Z");
    // 23 calls on disk: the 24th is allowed, the 25th is not.
    await saveState(dir, {
      day: utcDay(at),
      callsToday: 23,
      inputTokensToday: 0,
      outputTokensToday: 0,
      cursor: 0,
      lastRun: null,
      artifact: null,
    });
    let calls = 0;
    const d = deps({
      now: () => {
        calls += 1;
        if (calls > 1) {
          // The prior holder's 24th call lands here: after a run following the broken order has already
          // read 23, but before a run following the correct order reads anything at all.
          Deno.writeTextFileSync(
            `${dir}/state.json`,
            JSON.stringify({
              day: utcDay(at),
              callsToday: 24,
              inputTokensToday: 0,
              outputTokensToday: 0,
              cursor: 0,
              lastRun: null,
              artifact: null,
            }),
          );
        }
        return at;
      },
    });
    const { artifact } = await runOnce(config(dir), d);

    assertEquals(artifact.reason, "cap-daily-calls");
    assertEquals(
      artifact.modelCalls,
      0,
      "the ceiling was already reached, so no model call may be made",
    );
    assertEquals(d.calls.callModel ?? 0, 0, "and the stubbed model must not have been reached");
    assertEquals(
      (await loadState(dir)).callsToday,
      24,
      "the counter on disk must still say what the prior holder wrote",
    );
  });
});

Deno.test("the runner propagates a cap refusal instead of reporting success (audio-feed-9l6v)", async () => {
  // Ending the runner with `exit 0` made a capped run look like a success to whatever scheduled it,
  // which is the opposite of fail-closed. The stamp is touched BEFORE the run, so a non-zero status
  // cannot cause a retry storm.
  await withTempDir(async (dir) => {
    const bin = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${bin}/deno`, "#!/bin/sh\necho 'refused: capped' >&2\nexit 2\n");
      await Deno.chmod(`${bin}/deno`, 0o755);
      const cmd = new Deno.Command("sh", {
        args: [
          "-c",
          `PATH="${bin}:$PATH" AUDIOFEED_AGENT_STATE_DIR="${dir}" sh scripts/observability-agent-run.sh --interval-seconds 0`,
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      assertEquals(out.code, 2, "the runner must not turn a cap refusal into exit 0");
      assert(
        new TextDecoder().decode(out.stderr).includes("spend cap"),
        "and it must say why, so an operator sees it",
      );
    } finally {
      await Deno.remove(bin, { recursive: true });
    }
  });
});
