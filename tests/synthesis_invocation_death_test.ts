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

function spawnChild(kvPath: string, mode: "hang" | "drain", round: number) {
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
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

/** Read stdout until the child prints the marker, then SIGKILL it mid-put. */
async function killDuringUpload(kvPath: string, round: number) {
  const child = spawnChild(kvPath, "hang", round);
  const decoder = new TextDecoder();
  let out = "";
  const buffer = child.stdout.getReader();
  try {
    const markerDeadline = Date.now() + 20_000;
    while (Date.now() < markerDeadline) {
      const { value, done } = await buffer.read();
      if (done) break;
      out += decoder.decode(value);
      if (out.includes("MARKER:uploading")) break;
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
