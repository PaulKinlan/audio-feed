// audio-feed-l2gn4 — this suite EXECUTES the proof that docs/evidence/audio-feed-u2ve/README.md
// declares (`- Script: scripts/repro_u2ve_rate_limit_ff.ts`). Nothing ran it before: the census's
// exercised-or-pinned row was satisfied by a COMMENT in tests/rate_limit_key_test.ts that names the
// path, so the proof was neither pinned as known-unrun nor actually executed — the residual the
// pin set exists to make visible stayed invisible. The proof is fully offline (memory stores, real
// app handlers in-process, no Chrome, no network, no server socket) and runs in ~1s, which is what
// makes running it in the gate honest.
//
// THE SHAPE IS COPIED FROM THE wzv9/icl4/0cmu EXECUTORS IN THIS DIRECTORY, AND IT IS LOAD-BEARING:
// 1. THE NAME: `scripts/repro_u2ve_rate_limit_ff.ts` ↔ `tests/repro_u2ve_rate_limit_ff_test.ts` is
//    the repo's convention, and the coverage reporter places a changed source file by exactly that
//    convention plus what actually ran.
// 2. THE SPAWN: the proof path sits as a LITERAL in this test's own `new Deno.Command` args, and
//    the command is `Deno.execPath()`, because the selector derives the execute relation from the
//    call's text — a `timeout` wrapper or a path-behind-a-parameter derives NO relation.
// 3. THE BOUND: no `timeout` wrapper is possible (see 2), so a backstop timer SIGKILLs the child at
//    PROOF_BOUND_MS — a hanging proof is a red row, not a hung gate.
// 4. THE ORDER: the child is spawned by a closure INSIDE runAndRestore, so the evidence snapshot is
//    taken BEFORE the proof process exists and can write (audio-feed-3zdrz), and the proof rewrites
//    docs/evidence/audio-feed-u2ve/repro.json on every run.
//
// Artefact restore (always, even on red) is runAndRestore's job; see
// tests/declared_proof_helpers.ts for why that is load-bearing too.

import { runAndRestore } from "./declared_proof_helpers.ts";

Deno.test(
  "declared proof runs green, bounded: scripts/repro_u2ve_rate_limit_ff.ts (audio-feed-l2gn4)",
  async () => {
    const dir = "docs/evidence/audio-feed-u2ve";
    await runAndRestore(dir, () =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-all", "scripts/repro_u2ve_rate_limit_ff.ts"],
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "piped",
        stderr: "piped",
      }).spawn());
  },
);
