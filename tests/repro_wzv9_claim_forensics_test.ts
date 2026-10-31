// audio-feed-u9e7s — this suite EXECUTES the proof that docs/evidence/audio-feed-wzv9/README.md
// declares (`- Script: scripts/repro_wzv9_claim_forensics.ts`). Before it existed, a change to the
// proof script selected NO suite in the fast gate (fleet-check for f64c2d8b: "COVERAGE WARNING: 2
// unmapped changed file(s)"), so a regression in the proof was invisible until the separately-invoked
// evidence tier happened to run. The proof is fully offline (memory stores, real batch entry point,
// no Chrome, no network) and runs in ~0.3s, which is what makes running it in the gate honest.
//
// THE SHAPE OF THIS FILE IS LOAD-BEARING, IN THREE WAYS:
// 1. THE NAME: `scripts/repro_wzv9_claim_forensics.ts` ↔ `tests/repro_wzv9_claim_forensics_test.ts`
//    is the repo's own naming convention, and the fleet coverage reporter places a changed source
//    file by exactly that convention plus what actually ran — an executor suite with an unrelated
//    name would run the proof yet still be reported as no coverage for it.
// 2. THE SPAWN: the proof path sits as a LITERAL in this test's own `new Deno.Command` args, and the
//    command is `Deno.execPath()`, because the selector derives the execute relation from the call's
//    text (scripts/test-selection.ts): it resolves names to literals visible in scope, and its runner
//    model admits only `Deno.execPath()` or a known runner name — a GNU `timeout` wrapper or a
//    path-behind-a-parameter both derive NO relation and the mapping silently vanishes (each verified
//    empirically before this shape was chosen).
// 3. THE BOUND: no `timeout` wrapper is possible (see 2), so the bound moved inside the child handle:
//    a backstop timer SIGKILLs the child at PROOF_BOUND_MS — the same bound mechanism
//    scripts/evidence-run.ts uses for proofs — so a hanging proof turns into a non-zero exit and a
//    red row instead of a hung gate.
//
// Artefact restore (always, even on red) is runAndRestore's job; see
// tests/declared_proof_helpers.ts for why that is load-bearing too.

import { runAndRestore } from "./declared_proof_helpers.ts";

Deno.test(
  "declared proof runs green, bounded: scripts/repro_wzv9_claim_forensics.ts (audio-feed-u9e7s)",
  async () => {
    const dir = "docs/evidence/audio-feed-wzv9";
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--unstable-kv", "scripts/repro_wzv9_claim_forensics.ts"],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await runAndRestore(dir, child);
  },
);
