/**
 * Tests for the observability agent poll (audio-feed-yl6b).
 *
 * These exist to pin the SAFETY properties, not the happy path: an hourly job that spends money and
 * files tracker items has to be provably unable to spend when it should not, or "it seemed to work"
 * is no assurance at all. Every network or spend boundary is therefore injected, and the stubs
 * THROW when they are called in a test that asserts they are not - so the assertion is that the call
 * did not happen, not merely that nothing visibly failed.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
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
    ...over,
  };
}

function summary(over: Partial<SummaryBody> = {}): SummaryBody {
  return {
    since: 0,
    newest: 10,
    total: 1,
    bySeverity: {},
    byType: {},
    window: { oldestRetained: 1, newest: 10 },
    ...over,
  };
}

function page(events: LogEvent[], over: Partial<ErrorsPage> = {}): ErrorsPage {
  return {
    events,
    cursor: events.at(-1)?.seq ?? 0,
    hasMore: false,
    window: { oldestRetained: 1, newest: events.at(-1)?.seq ?? 0 },
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
  return Object.assign(base, over, { calls, beadArgs });
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
      fetchSummary: () => Promise.resolve({ ok: true as const, body: summary({ newest: 0 }) }),
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
      fetchSummary: () => Promise.resolve({ ok: true as const, body: summary({ newest: 0 }) }),
    });
    await runOnce(config(dir), d);
    const state = JSON.parse(await Deno.readTextFile(`${dir}/state.json`)) as PollState;
    assertEquals(state.artifact?.reason, "idle");
    const digest = await Deno.readTextFile(`${dir}/digest.md`);
    assertMatch(digest, /state: idle \(idle\)/);
    assertMatch(digest, /BEHIND: no/);
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
      fetchSummary: () => Promise.resolve({ ok: true as const, body: summary({ newest: 300 }) }),
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
      fetchSummary: () => Promise.resolve({ ok: true as const, body: summary({ newest: 300 }) }),
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
    return Response.json(summary({ newest: 0 }));
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
