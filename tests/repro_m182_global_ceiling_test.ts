// audio-feed-l2gn4 — this suite EXECUTES the proof that docs/evidence/audio-feed-m182/README.md
// declares (`- Script: scripts/repro_m182_global_ceiling.ts`). Until it existed the script was
// pinned in KNOWN_UNRUN as "cheap memory-only proof, NOT YET WIRED". The proof is fully offline
// (memory stores, the real synthesis worker, a counting synthesizer standing in for the paid call,
// no Chrome, no network) and runs in ~1.1s, which is what makes running it in the gate honest.
//
// NO `--no-global` ARGUMENT IS PASSED, deliberately: that flag exists to produce the BEFORE record
// (every episode paid, because the option does not exist in a tree without the change) and is
// expected to spend past the ceiling. This row pins the with-ceiling run, which is the after-fix
// demonstration the README tables cite.
//
// THE SHAPE IS COPIED FROM THE wzv9 EXECUTOR IN THIS DIRECTORY, AND IT IS LOAD-BEARING:
// 1. THE NAME: `scripts/repro_m182_global_ceiling.ts` ↔ `tests/repro_m182_global_ceiling_test.ts`
//    is the repo's convention, and the coverage reporter places a changed source file by exactly
//    that convention plus what actually ran.
// 2. THE SPAWN: the proof path sits as a LITERAL in this test's own `new Deno.Command` args, and
//    the command is `Deno.execPath()`, because the selector derives the execute relation from the
//    call's text — a `timeout` wrapper or a path-behind-a-parameter derives NO relation.
// 3. THE BOUND: no `timeout` wrapper is possible (see 2), so a backstop timer SIGKILLs the child at
//    PROOF_BOUND_MS — a hanging proof is a red row, not a hung gate.
// 4. THE ORDER: the child is spawned by a closure INSIDE runAndRestore, so the evidence snapshot is
//    taken BEFORE the proof process exists and can write (audio-feed-3zdrz).
//
// Artefact restore (always, even on red) is runAndRestore's job; this proof rewrites repro.json and
// its own README.md, so the whole directory is the unit of restore. See
// tests/declared_proof_helpers.ts for why that is load-bearing too.

import { runAndRestore } from "./declared_proof_helpers.ts";

Deno.test(
  "declared proof runs green, bounded: scripts/repro_m182_global_ceiling.ts (audio-feed-l2gn4)",
  async () => {
    const dir = "docs/evidence/audio-feed-m182";
    await runAndRestore(dir, () =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-all", "--unstable-kv", "scripts/repro_m182_global_ceiling.ts"],
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "piped",
        stderr: "piped",
      }).spawn());
  },
);
