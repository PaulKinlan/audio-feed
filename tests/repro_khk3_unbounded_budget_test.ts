// audio-feed-l2gn4 — this suite EXECUTES the proof that docs/evidence/audio-feed-khk3/README.md
// declares (`- Script: scripts/repro_khk3_unbounded_budget.ts`). Until it existed the script was
// pinned in KNOWN_UNRUN as "cheap memory-only proof (in-process handler calls, no live network), NOT
// YET WIRED". The proof is fully offline (memory stores, in-process handlers, a counting
// synthesizer standing in for the paid call) and runs in ~2.8s with no arguments, which is what
// makes running it in the gate honest.
//
// NO CEILING ARGUMENT IS PASSED, deliberately: the script's header says a ceiling argument turns it
// into a regression gate (exit 1 if more was spent than allowed) and that the no-argument form only
// MEASURES. Both forms exit 0 on a healthy tree, but the measured form is the one the committed
// before/after record in this directory was captured with, so it is the one this row pins - an
// argument here would be a third, undeclared shape of the proof.
//
// THE SHAPE IS COPIED FROM THE wzv9 EXECUTOR IN THIS DIRECTORY, AND IT IS LOAD-BEARING:
// 1. THE NAME: `scripts/repro_khk3_unbounded_budget.ts` ↔ `tests/repro_khk3_unbounded_budget_test.ts`
//    is the repo's convention, and the coverage reporter places a changed source file by exactly that
//    convention plus what actually ran.
// 2. THE SPAWN: the proof path sits as a LITERAL in this test's own `new Deno.Command` args, and the
//    command is `Deno.execPath()`, because the selector derives the execute relation from the call's
//    text — a `timeout` wrapper or a path-behind-a-parameter derives NO relation.
// 3. THE BOUND: no `timeout` wrapper is possible (see 2), so a backstop timer SIGKILLs the child at
//    PROOF_BOUND_MS — a hanging proof is a red row, not a hung gate.
// 4. THE ORDER: the child is spawned by a closure INSIDE runAndRestore, so the evidence snapshot is
//    taken BEFORE the proof process exists and can write (audio-feed-3zdrz).
//
// Artefact restore (always, even on red) is runAndRestore's job; this proof rewrites repro.json,
// manual-path-v2ym.json AND its own README.md, so the whole directory is the unit of restore. See
// tests/declared_proof_helpers.ts for why that is load-bearing too.

import { runAndRestore } from "./declared_proof_helpers.ts";

Deno.test(
  "declared proof runs green, bounded: scripts/repro_khk3_unbounded_budget.ts (audio-feed-l2gn4)",
  async () => {
    const dir = "docs/evidence/audio-feed-khk3";
    await runAndRestore(dir, () =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-all", "--unstable-kv", "scripts/repro_khk3_unbounded_budget.ts"],
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "piped",
        stderr: "piped",
      }).spawn());
  },
);
