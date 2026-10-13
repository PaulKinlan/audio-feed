/**
 * The synthesis progress predicate, tested directly (audio-feed-uet6).
 *
 * This predicate decides whether a yielded invocation made durable progress. Getting it subtly wrong
 * is expensive: zero progress advances the attempt count and, at `maxAttempts`, fails the episode, so a
 * mis-stated progress test turns a recoverable yield into a terminal failure.
 *
 * The defect was the second disjunct reading `finalScriptTurns > 0 && initialScriptTurns === 0` - a
 * ONE-SHOT LATCH, true only on the 0 -> N transition - while its sibling compared entry to current. Both
 * must compare entry to current. The rows below are the cases that distinction decides: the resume case
 * the latch could never satisfy, and the zero-progress case the latch existed to detect, which must keep
 * returning false or the livelock guard (audio-feed-fsr3, audio-feed-o88z) stops working.
 *
 * WHY THIS IS A TABLE AND NOT AN END-TO-END ROW. Whether the resume case is REACHABLE today is a
 * separate question, and today's answer is no: the script phase is skipped once `episode.scriptTurns`
 * exists (`src/worker/synthesis.ts:711`), the script checkpoint is its only writer, and the storage
 * layers only replace what they are given. That is pinned, not assumed, by the audio-feed-vvwb row of
 * tests/synthesis_claim_lifecycle_test.ts, which asserts the script generator is NOT called on a resumed
 * tick. So this is a trap removed rather than the cause of a live failure, and it is tested here because
 * no end-to-end input can currently reach the divergence.
 *
 *   deno test --allow-net --allow-env --allow-read --allow-write --allow-run --unstable-kv \
 *     tests/synthesis_progress_predicate_test.ts
 */

import { assert, assertEquals } from "@std/assert";
import { synthesisMadeProgress } from "../src/worker/synthesis.ts";

type Row = {
  name: string;
  initial: { segments: number; scriptTurns: number };
  final: { segments: number; scriptTurns: number };
  expect: boolean;
  why: string;
};

const rows: Row[] = [
  {
    name: "a finalized segment is progress",
    initial: { segments: 0, scriptTurns: 0 },
    final: { segments: 1, scriptTurns: 0 },
    expect: true,
    why: "the first disjunct: entry-to-current growth in finalized segments",
  },
  {
    name: "a first script generation is progress (0 -> N)",
    initial: { segments: 0, scriptTurns: 0 },
    final: { segments: 0, scriptTurns: 2 },
    expect: true,
    why: "the only case the one-shot latch recognised; it must keep working",
  },
  {
    name: "a RESUMED invocation adding script turns is progress (audio-feed-uet6)",
    initial: { segments: 0, scriptTurns: 2 },
    final: { segments: 0, scriptTurns: 4 },
    expect: true,
    why:
      "the latch's blind spot: initialScriptTurns > 0 with new turns and no new segment. This is the row " +
      "that reddens against the old expression, because `finalScriptTurns > 0 && initialScriptTurns === 0` " +
      "is false whenever the invocation began with turns already checkpointed.",
  },
  {
    name: "nothing changed is NOT progress (the anti-livelock case)",
    initial: { segments: 3, scriptTurns: 2 },
    final: { segments: 3, scriptTurns: 2 },
    expect: false,
    why:
      "the shape audio-feed-fsr3 and audio-feed-o88z drive: repeated stalls must advance attempts and " +
      "eventually fail, or the worker livelocks and spends without bound",
  },
  {
    name: "a stalled invocation with partial-durable state is NOT progress",
    initial: { segments: 1, scriptTurns: 2 },
    final: { segments: 1, scriptTurns: 2 },
    expect: false,
    why: "same guard, reached by a long episode rather than a cold start",
  },
  {
    name: "segments growing while turns stand still is progress",
    initial: { segments: 1, scriptTurns: 5 },
    final: { segments: 2, scriptTurns: 5 },
    expect: true,
    why: "the ordinary path through a long episode: the script is fixed and segments accumulate",
  },
  {
    name: "a SHRUNK script count is not progress",
    initial: { segments: 0, scriptTurns: 4 },
    final: { segments: 0, scriptTurns: 2 },
    expect: false,
    why:
      "write `!==` here instead of `>` and this row fails, which is the point: a requeue or a cleared " +
      "checkpoint reduces the count, and treating that as progress would reset attempts forever",
  },
];

for (const row of rows) {
  Deno.test(`synthesis progress: ${row.name}`, () => {
    const observed = synthesisMadeProgress(row.initial, row.final);
    assertEquals(observed, row.expect, `${row.why}\n      observed: ${observed}`);
  });
}

Deno.test("synthesis progress: an added script turn with no new segment is exactly the boundary case", () => {
  // Guards the row above from being satisfied by accident: one more turn must flip the answer, and
  // holding the turn count must not.
  const base = { segments: 2, scriptTurns: 3 };
  assertEquals(synthesisMadeProgress(base, { segments: 2, scriptTurns: 4 }), true);
  assertEquals(synthesisMadeProgress(base, { segments: 2, scriptTurns: 3 }), false);
  assert(
    synthesisMadeProgress(base, { segments: 3, scriptTurns: 3 }) &&
      synthesisMadeProgress(base, { segments: 2, scriptTurns: 4 }),
    "either dimension growing independently must count",
  );
});
