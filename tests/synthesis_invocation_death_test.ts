/**
 * Repro and regression for audio-feed-aqms: an invocation that dies mid-upload
 * (phase "uploading_audio") leaves the claim WITHOUT a terminal write; the lease
 * then expires, the next tick reclaims, and after three attempts the episode is
 * abandoned with exactly the reason Paul pasted from the UI:
 *
 *   "Failed / abandoned after 3 attempts; reason: claim lease expired without
 *    terminal write in phase 'uploading_audio'"
 *
 * The death is REAL, not simulated: each round spawns a child Deno process that
 * runs runSynthesisBatch against a file-backed KV store with a never-settling
 * blobs.put, and the parent SIGKILLs it while the put is in flight — before the
 * wrapper's own deadline timer, exactly like a platform kill or hard isolate
 * crash. KV state survives each death, so the store-level story (expiry,
 * reclaim, abandonment) is exercised for real across process boundaries.
 *
 * What this test pins:
 *  - after each kill the claim is held in phase "uploading_audio" with NO
 *    terminal write (status stays "synthesizing"),
 *  - the next claim records the lease-expiry cause and accumulates attempts,
 *  - the fourth invocation finds the episode abandoned with the legible reason,
 *    phase preserved.
 *
 * The in-process budget/yield machinery (preflight refusal and in-flight abort
 * while the isolate survives) is covered by the dv4p tests in
 * synthesis_claim_lifecycle_test.ts; this file covers what they cannot — the
 * invocation that never comes back.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { KvMetadataStore } from "../src/storage/kv.ts";
import {
  DEFAULT_MARKER_WAIT_MS,
  DEFAULT_SURVIVE_PUT_START_WAIT_MS,
  ESTIMATED_TURN_MS_ENV,
  MARKER_WAIT_MS_ENV,
  STAGE_DELAY_MS_ENV,
  STAGE_WEDGE_ENV,
  SURVIVE_PUT_START_HEADROOM,
  SURVIVE_PUT_START_WAIT_MS_ENV,
  survivePutStartWaitMs,
} from "./fixtures/invocation_death_window.ts";
import { MEASURED_STARVED_POLL_MS } from "../scripts/proof-cdp.ts";
import {
  boundedRow,
  ROW_HANG_BOUND_MS,
  ROW_HANG_HEADROOM,
  rowHangBoundMs,
  withRowBound,
} from "./fixtures/row_watchdog.ts";

const CHILD = new URL("./fixtures/invocation_death_child.ts", import.meta.url).pathname;

interface ChildOutcome {
  skipped: Array<{ episodeId: string; reason: string }>;
  failed: string[];
  episode?: {
    status: string;
    phase?: string;
    attempts?: number;
    error?: string;
  };
}

function spawnChild(
  kvPath: string,
  mode: "hang" | "survive" | "drain",
  round: number,
  env?: Record<string, string>,
) {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      CHILD,
      kvPath,
      mode,
      String(round),
    ],
    // Additive to this process's env: the marker-window control rides in without
    // disturbing anything else the child inherits.
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

/**
 * What stopped the child, named from the child's OWN exit code.
 *
 * A bare "never reached uploading_audio" is an unknown wearing a timeout's clothes: the pipe
 * closed, and that is all it says. Every code here is written by the fixture itself, so the red
 * can name an owner instead of sending the next reader to re-derive one.
 */
function childStopOwner(code: number | null, signal: string | null): string {
  if (signal) {
    return `the child was KILLED by ${signal} - a crash or an external killer, not a starved stage`;
  }
  switch (code) {
    case 3:
      return "exit code 3 is the child's OWN marker deadline running out (invocation_death_child.ts' 8s poll window): the upload stage was still starved when it gave up";
    case 1:
      return "exit code 1 is the child's SURVIVE-FATAL self-abort (a stage never started)";
    case 2:
      return "exit code 2 is the child's usage error (argv: kvPath, mode, round)";
    case 0:
      return "exit code 0 means the invocation RETURNED without ever starting the upload stage - a mechanism break, not a slow host";
    default:
      return `unrecognised exit code ${code} - read the stderr tail`;
  }
}

/**
 * Wait for a child to EXIT and be drained, under a bound that names the row (audio-feed-g7vfw).
 *
 * `child.output()` resolves when the child exits AND its pipes are drained - and nothing else
 * wakes it. The survive child ends on `await batchPromise`, which settles only when the budget
 * deadline (armed on the CONTROLLED clock) fires and its abort reaches the hanging put. If the
 * deadline is armed after the row's only `advance()`, or the abort never reaches that put, the
 * child waits forever and so does this row: that is the shape of the 50-minute union-gate park,
 * and it is why this await is bounded rather than left to the gate's two-hour wall.
 *
 * On the bound the child is killed (so a bound does not leak the process it gave up on) and the
 * red names BOTH the row and the await that hung.
 */
async function childOutputWithin(
  child: Deno.ChildProcess,
  rowName: string,
  boundMs: number = ROW_HANG_BOUND_MS,
): Promise<Deno.CommandOutput> {
  const output = child.output();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${rowName}: the child did not exit within ${boundMs}ms, so this row's unbounded ` +
            `await was child.output() - it resolves only on the child's EXIT, and the child ends ` +
            `on \`await batchPromise\`, which settles only if the invocation-budget deadline ` +
            `fires on the controlled clock and its abort reaches the hanging put. One of those ` +
            `never happened, so nothing waked either side (audio-feed-g7vfw).`,
        ),
      );
    }, boundMs);
  });
  // The kill above settles this; nobody else awaits it, so a rejection here must not be unhandled.
  output.catch(() => {});
  try {
    return await Promise.race([output, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read stdout until the child prints the marker, then SIGKILL it mid-put.
 *
 * `markerWaitMs` pins the child's give-up window EXPLICITLY (audio-feed-aqms-window):
 * the hang rounds pass DEFAULT_MARKER_WAIT_MS so the child's giving-up is a controlled
 * event pinned by this test rather than an ambient default (and one a stray env var in
 * the gate environment cannot silently move); the red-path case passes "0".
 */ async function killDuringUpload(
  kvPath: string,
  round: number,
  markerWaitMs = String(DEFAULT_MARKER_WAIT_MS),
) {
  const startedAt = Date.now();
  const child = spawnChild(kvPath, "hang", round, { [MARKER_WAIT_MS_ENV]: markerWaitMs });
  const decoder = new TextDecoder();
  let out = "";
  const buffer = child.stdout.getReader();
  try {
    // docs/speed.md census row 5: this used to stop reading at a REAL-CLOCK deadline
    // (20s, or 3x the previous round's observed time-to-marker). That bound could never fire
    // on a live child - the hang child polls for the marker until its window expires
    // (INVOCATION_DEATH_MARKER_WAIT_MS, default 15x the starved floor) and then exits 3 - so the
    // loud-fail path was ALWAYS the child-exit race below, and the deadline only ever
    // contributed a way for a loaded host to abandon a child that was still working. It is
    // deleted rather than raised: the loop now ends on EVENTS (marker bytes, EOF, the child's
    // exit), which is order, not elapsed time. Every read result is consumed, so no marker
    // chunk is lost to the race.
    const exited = child.status.then(() => "exited" as const);
    let childExitedEarly = false;
    for (;;) {
      const race = await Promise.race([buffer.read(), exited]);
      if (race === "exited") {
        childExitedEarly = true;
        break;
      }
      const { value, done } = race;
      if (done) break;
      out += decoder.decode(value);
      if (out.includes("MARKER:uploading")) break;
    }
    if (childExitedEarly) {
      const status = await child.status;
      const err = await child.stderr.text();
      throw new Error(
        `child round ${round} exited before printing MARKER:uploading after ${
          Date.now() - startedAt
        }ms (${
          childStopOwner(status.code, status.signal)
        }; code ${status.code}, signal ${status.signal}; stderr tail: ${
          err.trim().slice(-600) || "(empty)"
        }; stdout: ${out})`,
      );
    }
  } finally {
    await buffer.cancel().catch(() => {});
  }
  if (!out.includes("MARKER:uploading")) {
    // EOF WITHOUT THE MARKER IS A CHILD STAYING SILENT, NOT A SLOW WAIT, AND IT MUST SAY SO.
    // `done` only says the child's stdout pipe closed; the old message here read "never reached
    // uploading_audio", which reports an UNKNOWN (why did it stop? crashed? returned early? ran
    // out of its own poll window?) as if it were a wait that expired - and it threw away the
    // exit code, the signal and the child's stderr, the only three facts that name an owner.
    // That is the shape the union gate produced (round 3, loadavg 5-10): a red that cannot be
    // acted on without a re-run and a guess.
    //
    // The status await below is itself the liveness proof: it resolves only for a DEAD child, so
    // reaching this throw means the child had already exited. A live child holding a closed pipe
    // would leave this row hanging rather than reddening it - so the message states the death it
    // observed instead of implying a timeout it never took.
    const status = await child.status;
    const err = await child.stderr.text();
    throw new Error(
      `child round ${round} stopped after ${
        Date.now() - startedAt
      }ms without reaching uploading_audio (never printed MARKER:uploading): ` +
        `stdout hit EOF and the child is dead (${childStopOwner(status.code, status.signal)}; ` +
        `code ${status.code}, signal ${status.signal}; stderr tail: ${
          err.trim().slice(-600) || "(empty)"
        }; ` +
        `stdout: ${out || "(empty)"})`,
    );
  }
  // The put is in flight and the wrapper's deadline timer is still seconds out.
  child.kill("SIGKILL");
  const status = await child.status;
  assertEquals(status.signal, "SIGKILL", `round ${round} child must have been SIGKILLed`);
}

boundedRow(
  "audio-feed-aqms control: the same put outlasts the invocation budget mid-await when the isolate SURVIVES",
  async () => {
    const kvPath = await Deno.makeTempFile({ prefix: "audio-feed-aqms-survive-", suffix: ".kv" });
    try {
      const child = spawnChild(kvPath, "survive", 1);
      const output = await childOutputWithin(
        child,
        "audio-feed-aqms control: the same put outlasts the invocation budget mid-await when the isolate SURVIVES",
      );
      const out = new TextDecoder().decode(output.stdout);
      const err = new TextDecoder().decode(output.stderr);
      const status = await child.status;
      assertEquals(
        status.success,
        true,
        // audio-feed-ga3jd: the child's SURVIVE-FATAL stderr line names the order break
        // (e.g. the deadline fired before the put started), so the red carries the mechanism.
        `survive child failed: ${out}${err}`,
      );

      const line = out.split("\n").find((l) => l.startsWith("SURVIVE:"));
      assert(line, `survive child printed no SURVIVE line: ${out}`);
      const r = JSON.parse(line.slice("SURVIVE:".length)) as {
        yielded: unknown[];
        failed: string[];
        putStarted: number;
        putSettled: number;
        putAborted: number;
        putStartedBeforeDeadline: boolean;
        episode?: { status: string; phase?: string; attempts?: number };
      };

      // The invocation awaited the put past its own budget-derived deadline: the
      // wrapper cannot yield before maxInvocationDurationMs (4000) minus flushMargin
      // (500) = 3500ms after batch start, and the put had already started by then.
      // audio-feed-ga3jd: the deadline now fires on the child's controlled clock
      // ONLY AFTER the put is observably started (an ORDER fact), so these counter
      // assertions carry the whole property on any host speed; the old
      // `awaitedMs >= 3_000` wall-clock assert measured the very race that starved
      // the put under load and is gone with the injected clock that replaced it.
      assertEquals(r.putStarted, 1, "the put must have been started");
      assertEquals(
        r.putStartedBeforeDeadline,
        true,
        "the put must start BEFORE the deadline fires - the abort lands mid-put by construction, not on an already-dead signal",
      );
      assertEquals(r.putSettled, 0, "the put must never complete: it outlasts the budget");
      assertEquals(r.putAborted, 1, "the budget deadline must ABORT the put by construction");
      assertEquals(r.yielded.length, 1, "surviving invocation converts it to a clean yield");
      assertEquals(r.failed.length, 0);
      assertEquals(r.episode?.status, "pending", "claim released non-terminally");
      assertEquals(r.episode?.phase, "upload_retry", "phase records the upload retry");
      // audio-feed-zpyx0: the other half of the settle-first pin. A HEALTHY run must never take
      // that abort: it claims, starts the put and yields on the budget. The row below drives the
      // abort on purpose; this one asserts its reason is absent when nothing settled early, so
      // widening the abort's condition to "any batch that settles" cannot pass unnoticed.
      assertEquals(
        err.includes("batch settled before the put started"),
        false,
        `the healthy survive control must NOT take the settle-first abort: ${err}`,
      );
    } finally {
      await Deno.remove(kvPath).catch(() => {});
    }
  },
);

boundedRow(
  "audio-feed-wjtpb: survive control passes when child is artificially delayed before the put",
  async () => {
    // With an artificial delay introduced before the put (sleep before the put),
    // the survive control must still pass: the watchdog and derived bound accommodate
    // stage delays, and the abort still lands mid-put once started.
    const kvPath = await Deno.makeTempFile({
      prefix: "audio-feed-wjtpb-delay-",
      suffix: ".kv",
    });
    try {
      const child = spawnChild(kvPath, "survive", 1, {
        [STAGE_DELAY_MS_ENV]: "50",
      });
      const output = await childOutputWithin(
        child,
        "audio-feed-wjtpb: survive control passes when child is artificially delayed before the put",
      );
      const out = new TextDecoder().decode(output.stdout);
      const err = new TextDecoder().decode(output.stderr);
      const status = await child.status;
      assertEquals(
        status.success,
        true,
        `delayed survive child failed: ${out}${err}`,
      );

      const line = out.split("\n").find((l) => l.startsWith("SURVIVE:"));
      assert(line, `delayed survive child printed no SURVIVE line: ${out}`);
      const r = JSON.parse(line.slice("SURVIVE:".length)) as {
        yielded: unknown[];
        failed: string[];
        putStarted: number;
        putSettled: number;
        putAborted: number;
        putStartedBeforeDeadline: boolean;
      };

      assertEquals(r.putStarted, 1, "the delayed put must have started");
      assertEquals(
        r.putStartedBeforeDeadline,
        true,
        "the delayed put must still start before deadline fires",
      );
      assertEquals(r.putAborted, 1, "the put must be aborted cleanly");
      assertEquals(r.yielded.length, 1, "delayed survive converts to clean yield");
    } finally {
      await Deno.remove(kvPath).catch(() => {});
    }
  },
);

boundedRow(
  "audio-feed-zpyx0: a batch that SETTLES before the put aborts at once, by name, and names the job",
  async () => {
    // THE MUTANT THIS PINS (audio-feed-zpyx0): delete the child's settle-first abort - the
    // `if (hangingBlobs.started === 0 && settled !== undefined) { ... Deno.exit(1) }` block in
    // tests/fixtures/invocation_death_child.ts - and nothing in this suite reds: the child falls
    // through and PRINTS A PASS (`SURVIVE:{"putStarted":0,...}`, exit 0) for a starved batch that
    // never uploaded. The other regression that must red: keep the condition but wait out the
    // put-start bound instead of breaking on the settle, and the red arrives seconds later saying
    // "the put never started", which blames starvation instead of the settled batch that caused it.
    // Both are why this row asserts the reason STRING, not just exit 1.
    //
    // The starved condition is SIMULATED, never slept for: ESTIMATED_TURN_MS_ENV raises the child's
    // per-turn estimate above its whole 4000ms budget, so the claim loop's preflight
    // (`remaining < estimate + flushMargin`) breaks WITHOUT claiming and the batch settles in
    // milliseconds - a faithful model of the starved host whose earlier stages ate the budget. The
    // put-start bound is INJECTED (10s, far above what the in-process abort costs) so the bound's
    // text cannot be mistaken for the settle's.
    //
    // NO ELAPSED FIGURE IS ASSERTED (audio-feed-bmqv2, replacing `elapsed < boundMs / 2`). The
    // property is that the abort was TRIGGERED by the settle rather than by the bound, and the
    // assertions below state it as evidence a clock cannot fake: the settled-batch cause PRESENT,
    // the put-start bound's text ABSENT, and the job it abandoned named.
    // `elapsed < boundMs / 2` restated that same property as a guess about host scheduling - and a
    // guess has no failure mode of its own: once the cause is proven, every elapsed figure is
    // consistent with a CORRECT abort, so the ceiling could only ever fire on a correct settle
    // that a starved lane scheduled late. Same shape as audio-feed-gqdug: derive the fact from an
    // observation, not a clock.
    const rowName =
      "audio-feed-zpyx0: a batch that SETTLES before the put aborts at once, by name, and names the job";
    const boundMs = 10_000;
    const kvPath = await Deno.makeTempFile({ prefix: "audio-feed-zpyx0-", suffix: ".kv" });
    try {
      const child = spawnChild(kvPath, "survive", 7, {
        [ESTIMATED_TURN_MS_ENV]: "60000",
        [SURVIVE_PUT_START_WAIT_MS_ENV]: String(boundMs),
      });
      const output = await childOutputWithin(child, rowName);
      const out = new TextDecoder().decode(output.stdout);
      const err = new TextDecoder().decode(output.stderr);
      const status = await child.status;

      assertEquals(
        status.code,
        1,
        `a settled batch must abort the child with exit 1, not return: ${out}${err}`,
      );
      // THE REASON, distinguishable from the bound's: same SURVIVE-FATAL prefix, different cause.
      assertStringIncludes(err, "SURVIVE-FATAL: batch settled before the put started");
      assertEquals(
        err.includes("the put never started within"),
        false,
        `the abort must be the SETTLE-FIRST one, not the put-start bound firing later: ${err}`,
      );
      // WHICH JOB was abandoned: the episode and its owner, not just the batch's outcome.
      assertStringIncludes(err, 'episode "episode-1" of user "user-1"');
      assertEquals(
        out.includes("SURVIVE:"),
        false,
        "an aborted child must not print a SURVIVE result line - that is the silent pass the abort replaces",
      );
    } finally {
      await Deno.remove(kvPath).catch(() => {});
    }
  },
);

boundedRow(
  "audio-feed-wjtpb: survive control fails within bound when child is genuinely wedged",
  async () => {
    // When the child genuinely wedges before starting the put, the put never starts.
    // The watchdog/bound must expire and exit 1 with SURVIVE-FATAL, naming the bound in force.
    //
    // The BOUND IS ASSERTED THROUGH ITS OWN REPORT, NOT THROUGH THE CLOCK (audio-feed-bmqv2,
    // replacing `elapsed < 10_000` for a 100ms bound). `SURVIVE-FATAL: the put never started
    // within 100ms` is emitted by exactly one site in the child - the watchdog that compares the
    // clock against this row's injected bound - so the string says the bound fired AND which bound
    // it was; 10s was a second, unrelated guess about the host (1.25x this repo's own measured
    // 8s starved-poll floor, so a starved lane could red a correct abort). Pinning the value keeps
    // the reduction honest: a child that reported a different bound, or a different cause, reds.
    const kvPath = await Deno.makeTempFile({
      prefix: "audio-feed-wjtpb-wedge-",
      suffix: ".kv",
    });
    try {
      const boundMs = 100;
      const child = spawnChild(kvPath, "survive", 1, {
        [STAGE_WEDGE_ENV]: "1",
        [SURVIVE_PUT_START_WAIT_MS_ENV]: String(boundMs),
      });
      const output = await childOutputWithin(
        child,
        "audio-feed-wjtpb: survive control fails within bound when child is genuinely wedged",
      );
      const err = new TextDecoder().decode(output.stderr);
      const status = await child.status;

      assertEquals(status.code, 1, `wedged child must exit 1 (stderr: ${err})`);
      assertStringIncludes(err, `SURVIVE-FATAL: the put never started within ${boundMs}ms`);
    } finally {
      await Deno.remove(kvPath).catch(() => {});
    }
  },
);

boundedRow(
  "audio-feed-wjtpb: survive put-start wait is derived from MEASURED_STARVED_POLL_MS",
  () => {
    assert(
      DEFAULT_SURVIVE_PUT_START_WAIT_MS > 20_000,
      "the survive put-start ceiling must exceed the old fixed 20000ms that failed under gate load",
    );
    // A VALUE assertion cannot answer "is this derived?" - a literal equal to the product
    // satisfies it (audio-feed-p3hmf: 15 * 8_000 stayed green through mutants). So ask the
    // RULE instead: a synthetic floor a literal could not have anticipated.
    assertEquals(
      survivePutStartWaitMs(16_000),
      240_000,
      "the ceiling must track the floor, not today's value",
    );
    assertEquals(
      survivePutStartWaitMs(1),
      SURVIVE_PUT_START_HEADROOM,
      "headroom factor must scale the floor",
    );
    assertEquals(
      survivePutStartWaitMs(MEASURED_STARVED_POLL_MS),
      DEFAULT_SURVIVE_PUT_START_WAIT_MS,
    );
    assertEquals(
      DEFAULT_SURVIVE_PUT_START_WAIT_MS,
      15 * MEASURED_STARVED_POLL_MS,
      "15x the measured floor, on the nose",
    );

    // Pin the definition line in fixtures/invocation_death_window.ts with comments stripped (p3hmf shape).
    const rawSource = Deno.readTextFileSync(
      new URL("fixtures/invocation_death_window.ts", import.meta.url),
    );
    const stripped = codeOnly(rawSource);
    const definition = stripped
      .split("\n")
      .find((line) => line.startsWith("export const DEFAULT_SURVIVE_PUT_START_WAIT_MS ="));
    assertEquals(
      definition,
      "export const DEFAULT_SURVIVE_PUT_START_WAIT_MS = survivePutStartWaitMs(MEASURED_STARVED_POLL_MS);",
      "DEFAULT_SURVIVE_PUT_START_WAIT_MS must be the RULE applied to the measured floor, not a literal",
    );
  },
);

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*[/]/g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

boundedRow(
  "audio-feed-aqms: invocation killed mid-upload leaves claim non-terminal, then abandonment after 3 leases",
  async () => {
    const kvPath = await Deno.makeTempFile({ prefix: "audio-feed-aqms-", suffix: ".kv" });
    try {
      // Three invocations, each dying inside the terminal put.
      for (let round = 1; round <= 3; round++) {
        await killDuringUpload(kvPath, round);

        // The child is dead, so the KV file is ours again: assert the mid-incident
        // state — the claim is held in uploading_audio with NO terminal write.
        const store = await KvMetadataStore.open(kvPath);
        try {
          const episode = await store.getEpisode("user-1", "episode-1");
          assertEquals(episode?.status, "synthesizing", "no terminal write after death");
          assertEquals(episode?.phase, "uploading_audio");
          assertEquals(episode?.claimedBy, `invocation-death-${round}`);
          assertEquals(episode?.attempts, round, "each lease expiry burns one attempt");
        } finally {
          await store.close();
        }

        // Let the 1500ms lease expire before the next invocation reclaims.
        await new Promise((r) => setTimeout(r, 1_800));
      }

      // Fourth invocation: out of claims — the store abandons the episode.
      const drain = spawnChild(kvPath, "drain", 4);
      const drainOut = new TextDecoder().decode(await drain.output().then((o) => o.stdout));
      const drainStatus = await drain.status;
      assertEquals(drainStatus.success, true, `drain child failed: ${drainOut}`);

      const resultLine = drainOut.split("\n").find((l) => l.startsWith("RESULT:"));
      assert(resultLine, `drain child printed no RESULT line: ${drainOut}`);
      const outcome = JSON.parse(resultLine.slice("RESULT:".length)) as ChildOutcome;

      assertEquals(outcome.skipped.length, 1, "episode is skipped by the batch: no claim granted");
      assertStringIncludes(outcome.skipped[0]?.reason ?? "", "claimed elsewhere or exhausted");
      assertEquals(outcome.episode?.status, "failed");
      assertEquals(
        outcome.episode?.phase,
        "uploading_audio",
        "phase preserved through abandonment",
      );
      assertEquals(outcome.episode?.attempts, 3);
      assertStringIncludes(
        outcome.episode?.error ?? "",
        'abandoned after 3 attempts; reason: claim lease expired without terminal write in phase "uploading_audio"',
      );
    } finally {
      await Deno.remove(kvPath).catch(() => {});
    }
  },
);

boundedRow(
  "audio-feed-aqms red path: a zero marker window stops the child WITHOUT the marker and the parent reports it",
  async () => {
    // audio-feed-aqms-window: the fixture's give-up must stay a CONTROLLED EVENT, not
    // a race with host load. INVOCATION_DEATH_MARKER_WAIT_MS=0 makes the child's deadline
    // already-expired at the first loop check, so it skips the marker poll entirely and
    // stops without the marker deterministically - the exact shape a loaded host used to
    // produce by accident with the old zero-headroom 8s window. This case pins both halves
    // of the premise: the child stops WITHOUT the marker (exit 3), and the parent REPORTS
    // the marker-less stop by name instead of swallowing it.
    const kvPath = await Deno.makeTempFile({ prefix: "audio-feed-aqms-red-", suffix: ".kv" });
    try {
      const child = spawnChild(kvPath, "hang", 9, { [MARKER_WAIT_MS_ENV]: "0" });
      const output = await child.output();
      const status = await child.status;
      const out = new TextDecoder().decode(output.stdout);
      const err = new TextDecoder().decode(output.stderr);
      assertEquals(status.code, 3, `the child must give up with exit 3 (stderr: ${err})`);
      assertStringIncludes(err, "child: never reached uploading_audio before timeout");
      assertEquals(
        out.includes("MARKER:uploading"),
        false,
        "the child must stop WITHOUT the marker",
      );

      // Same controlled event, observed from the parent: killDuringUpload must throw
      // rather than pass. On main it can throw either the child-exited message or the
      // EOF message (whichever wins the event race); both name the marker-less stop.
      const reportKvPath = await Deno.makeTempFile({
        prefix: "audio-feed-aqms-red-report-",
        suffix: ".kv",
      });
      try {
        let reported: unknown = null;
        try {
          await killDuringUpload(reportKvPath, 10, "0");
        } catch (e) {
          reported = e;
        }
        assert(reported !== null, "the parent must throw on a marker-less child stop, not pass");
        assert(reported instanceof Error);
        // audio-feed-aqms-window P1: this asserted the exact wording "never reached
        // uploading_audio", but killDuringUpload has TWO throw sites for a marker-less stop
        // - the child-exit branch above (line ~113, "child round N exited before
        // uploading_audio (signal ...)") and the EOF branch below it (~line 120, "child
        // round N never reached uploading_audio ..."). With the zero window the child exits
        // almost immediately, so the child-exit branch wins the read/exit race often enough
        // that the wording assert was itself a coin flip - a fresh intermittent failure
        // inside the test added to remove one. Pin what BOTH messages say: the round, and
        // the marker-less stop at the upload stage. It still fails if the parent stops
        // throwing, and it still fails on an unrelated error (no round, no phase name).
        assertStringIncludes(reported.message, `child round 10`);
        assertStringIncludes(reported.message, "uploading_audio");
      } finally {
        await Deno.remove(reportKvPath).catch(() => {});
      }
    } finally {
      await Deno.remove(kvPath).catch(() => {});
    }
  },
);

boundedRow(
  "audio-feed-g7vfw: a row that PARKS reds by name within the bound instead of holding the suite",
  async () => {
    // THE MUTANT IS THIS BODY: it awaits a promise nothing ever settles - the exact shape of
    // the union gate's 50-minute park (a promise whose only waker is a callback that never
    // runs). The bound is injected so the proof costs 50ms rather than the derived 120s; the
    // derived default is pinned by the row below, so an injected bound here cannot hide a
    // weakened default.
    //
    // NO ELAPSED FIGURE IS ASSERTED (audio-feed-bmqv2, replacing `elapsed < 5_000` for a 50ms
    // bound): `rowHangMessage` is constructed in exactly ONE place in tests/fixtures/row_watchdog.ts
    // - inside the rejecting setTimeout - so receiving it at all proves the bound, and not the
    // body, settled the race; the three string assertions above it pin the row name and the
    // injected bound. The elapsed ceiling added a second, weaker statement of the same property
    // as a guess about the host, and 5s against a 50ms bound is inside this repo's own measured
    // starved-poll window (8s).
    const rowName = "audio-feed-g7vfw parked-mutant";
    const boundMs = 50;
    let red: unknown;
    try {
      await withRowBound(rowName, () => new Promise<never>(() => {}), boundMs);
    } catch (err) {
      red = err;
    }
    assert(red instanceof Error, "a parked row MUST red; returning would be the silent pass");
    assertStringIncludes(red.message, `row "${rowName}"`);
    assertStringIncludes(red.message, `bound of ${boundMs}ms`);
    assertStringIncludes(red.message, "audio-feed-g7vfw");
  },
);

boundedRow("audio-feed-g7vfw: the row hang bound is DERIVED from the starved floor", () => {
  // A VALUE assertion cannot answer "is this derived?" - a literal equal to the product
  // satisfies it (the same trap audio-feed-p3hmf found in the survive put-start bound). Ask
  // the RULE instead: a synthetic floor a literal could not have anticipated.
  assertEquals(rowHangBoundMs(16_000), 240_000, "the bound must track the floor");
  assertEquals(ROW_HANG_BOUND_MS, rowHangBoundMs(MEASURED_STARVED_POLL_MS));
  assertEquals(ROW_HANG_HEADROOM, 15, "the stated multiple is the repo's standard 15x");
  assert(
    ROW_HANG_BOUND_MS > 60_000,
    "the row bound must sit well above any row's real cost while still being minutes",
  );
});
