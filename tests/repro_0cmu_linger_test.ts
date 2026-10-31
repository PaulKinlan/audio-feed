// audio-feed-l2gn4 — this suite EXECUTES the proof that docs/evidence/audio-feed-0cmu/README.md
// declares (`- Script: scripts/repro_0cmu_linger.ts`). Until it existed the script was pinned in
// KNOWN_UNRUN as "cheap memory-only proof, NOT YET WIRED", so a change to it selected no suite and
// the residual (a pinned proof nothing runs, which can rot silently) stayed open. The proof is
// fully offline (memory stores, scripted fetch, `deno eval` grandchildren only) and runs in ~7s,
// which is what makes running it in the gate honest.
//
// THE SHAPE IS COPIED FROM THE wzv9 EXECUTOR IN THIS DIRECTORY, AND IT IS LOAD-BEARING:
// 1. THE NAME: `scripts/repro_0cmu_linger.ts` ↔ `tests/repro_0cmu_linger_test.ts` is the repo's
//    convention, and the coverage reporter places a changed source file by exactly that convention
//    plus what actually ran.
// 2. THE SPAWN: the proof path sits as a LITERAL in this test's own `new Deno.Command` args, and
//    the command is `Deno.execPath()`, because the selector derives the execute relation from the
//    call's text — a `timeout` wrapper or a path-behind-a-parameter derives NO relation.
// 3. THE BOUND: no `timeout` wrapper is possible (see 2), so a backstop timer SIGKILLs the child at
//    PROOF_BOUND_MS — a hanging proof is a red row, not a hung gate. For THIS proof the bound is
//    also the property under test: the proof only passes if the child ends by itself, so nothing
//    here may shorten its own life (no Deno.exit on the happy path).
// 4. THE ORDER: the child is spawned by a closure INSIDE runAndRestore, so the evidence snapshot is
//    taken BEFORE the proof process exists and can write (audio-feed-3zdrz).
//
// Artefact restore (always, even on red) is runAndRestore's job; see
// tests/declared_proof_helpers.ts for why that is load-bearing too.

import { runAndRestore } from "./declared_proof_helpers.ts";

Deno.test(
  "declared proof runs green, bounded: scripts/repro_0cmu_linger.ts (audio-feed-l2gn4)",
  async () => {
    const dir = "docs/evidence/audio-feed-0cmu";
    await runAndRestore(dir, () =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-all", "--unstable-kv", "scripts/repro_0cmu_linger.ts"],
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "piped",
        stderr: "piped",
      }).spawn());
  },
);
