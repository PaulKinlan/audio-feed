/**
 * Determinism row for a browser capture (audio-feed-xsvti): run the same declared proof TWICE on one
 * tree and assert the artefact it writes comes out byte-identical. A capture that is an instant of
 * playback cannot pass this; a capture that is a state of the page can.
 *
 * WHY THIS IS A ROW AND NOT A UNIT TEST: the only thing that can vary is real Chrome rendering the
 * real player, so the check has to drive the committed proof against the committed evidence dir. A
 * test in the gate would do the same work while REWRITING tracked artefacts under every parallel
 * suite, so this runs as an explicit row and restores the committed bytes in a `finally`, leaving the
 * tree exactly as it found it.
 *
 * HOW THE CAPTURE IS HELD STILL (mechanism, not luck): the proof pauses #audio at 0s BEFORE the shot
 * and re-reads `paused`/`currentTime` AFTER it, and finishes the finite paint transitions and waits
 * for `getAnimations()` to report none running. Every varying input is therefore a value the proof
 * sets and re-asserts, not a clock it races - if the element had resumed, the proof reds instead of
 * writing a shot that differs from the last one.
 *
 * MUTANT (this row must be able to fail): delete the pause/finish block in
 * scripts/listen-browser-proof.ts so the shot is taken during playback. Two runs then differ - the
 * measured shift was 175 px across the player row (audio-feed-xsvti) - and this row exits 1 naming
 * the two different hashes.
 *
 *   deno run --allow-read --allow-write --allow-run=deno,timeout,git --allow-env \
 *     scripts/capture-determinism-check.ts [--dir audio-feed-py5] [--runs 2]
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { hashEvidenceDir, RECORD_FILE } from "./evidence-run.ts";

const ROOT = dirname(fromFileUrl(new URL("../deno.json", import.meta.url)));

function arg(name: string, fallback: string): string {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 && Deno.args[at + 1] ? Deno.args[at + 1]! : fallback;
}

const dir = `docs/evidence/${arg("dir", "audio-feed-py5")}`;
const runs = Number(arg("runs", "2"));
if (!Number.isInteger(runs) || runs < 2) {
  console.error(
    `[determinism] --runs must be an integer >= 2 (got ${JSON.stringify(arg("runs", "2"))})`,
  );
  Deno.exit(2);
}

async function runProofOnce(): Promise<void> {
  const command = new Deno.Command("deno", {
    args: ["task", "evidence", "--only", dir.split("/").pop()!],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (output.code !== 0) {
    throw new Error(
      `[determinism] the proof run failed (exit ${output.code}):\n` +
        new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr),
    );
  }
}

/** The committed bytes, so the row can put the tree back however it exits. */
async function snapshot(): Promise<Map<string, Uint8Array>> {
  const kept = new Map<string, Uint8Array>();
  for (const name of [...Object.keys(await hashEvidenceDir(join(ROOT, dir))), RECORD_FILE]) {
    try {
      kept.set(name, await Deno.readFile(join(ROOT, dir, name)));
    } catch {
      // absent at start: restoring means removing it, handled by the diff below
    }
  }
  return kept;
}

async function restore(kept: Map<string, Uint8Array>): Promise<void> {
  const now = Object.keys(await hashEvidenceDir(join(ROOT, dir)));
  for (const name of now) {
    if (!kept.has(name)) await Deno.remove(join(ROOT, dir, name));
  }
  for (const [name, bytes] of kept) {
    await Deno.writeFile(join(ROOT, dir, name), bytes);
  }
}

const kept = await snapshot();
try {
  const hashes: Record<string, string>[] = [];
  for (let run = 1; run <= runs; run++) {
    await runProofOnce();
    hashes.push(await hashEvidenceDir(join(ROOT, dir)));
  }
  const names = [...new Set(hashes.flatMap((map) => Object.keys(map)))].sort();
  const differing = names.filter((name) => new Set(hashes.map((map) => map[name])).size !== 1);
  for (const name of names) {
    console.log(
      `[determinism] ${name}: ${hashes.map((map) => map[name] ?? "<absent>").join(" vs ")}`,
    );
  }
  if (differing.length > 0) {
    console.error(
      `[determinism] FAIL ${dir}: ${differing.length} artefact(s) differ across ${runs} runs of the ` +
        `same tree - the capture is an instant, not a state (audio-feed-xsvti)`,
    );
    Deno.exit(1);
  }
  console.log(
    `[determinism] PASS ${dir}: ${names.length} artefact(s) byte-identical across ${runs} runs of ` +
      `the same tree (audio-feed-xsvti)`,
  );
} finally {
  await restore(kept);
}
