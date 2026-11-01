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
import { DEFAULT_MARKER_WAIT_MS, MARKER_WAIT_MS_ENV } from "./fixtures/invocation_death_window.ts";

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
        `child round ${round} exited before uploading_audio (signal ${status.signal}, code ${status.code}; stderr: ${err}; stdout: ${out})`,
      );
    }
  } finally {
    await buffer.cancel().catch(() => {});
  }
  if (!out.includes("MARKER:uploading")) {
    await child.status;
    throw new Error(`child round ${round} never reached uploading_audio (stdout: ${out})`);
  }
  // The put is in flight and the wrapper's deadline timer is still seconds out.
  child.kill("SIGKILL");
  const status = await child.status;
  assertEquals(status.signal, "SIGKILL", `round ${round} child must have been SIGKILLed`);
}

Deno.test("audio-feed-aqms control: the same put outlasts the invocation budget mid-await when the isolate SURVIVES", async () => {
  const kvPath = await Deno.makeTempFile({ prefix: "audio-feed-aqms-survive-", suffix: ".kv" });
  try {
    const child = spawnChild(kvPath, "survive", 1);
    const output = await child.output();
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
  } finally {
    await Deno.remove(kvPath).catch(() => {});
  }
});

Deno.test("audio-feed-aqms: invocation killed mid-upload leaves claim non-terminal, then abandonment after 3 leases", async () => {
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
    assertEquals(outcome.episode?.phase, "uploading_audio", "phase preserved through abandonment");
    assertEquals(outcome.episode?.attempts, 3);
    assertStringIncludes(
      outcome.episode?.error ?? "",
      'abandoned after 3 attempts; reason: claim lease expired without terminal write in phase "uploading_audio"',
    );
  } finally {
    await Deno.remove(kvPath).catch(() => {});
  }
});

Deno.test(
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
        assertStringIncludes(reported.message, "never reached uploading_audio");
      } finally {
        await Deno.remove(reportKvPath).catch(() => {});
      }
    } finally {
      await Deno.remove(kvPath).catch(() => {});
    }
  },
);
