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
import {
  BACKLOG_ALERT_HOURS,
  BACKLOG_FINGERPRINT,
  buildPrompt,
  type ErrorsPage,
  type LogEvent,
  MAX_EVENTS_PER_RUN,
  MAX_PROMPT_BYTES,
  normaliseRoute,
  oldestRetainedFromProblem,
  OVERSIZED_FINGERPRINT,
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
  const dir = await Deno.makeTempDir({ prefix: "audiofeed-agent-test-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
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
