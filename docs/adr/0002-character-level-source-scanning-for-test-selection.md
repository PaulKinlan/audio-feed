# 0002. Scan test-selection's source at character level, not with regexes

- **Status:** Accepted — implemented by `audio-feed-70u4` (`97d5552`, `884dc2d`), refined by
  `audio-feed-aiiy` (`ab3f2eb`), `5c43ef2`, `702ef63` and `audio-feed-ghym` (`6215f55`).
- **Date:** 2026-10-13
- **Decision bead:** `audio-feed-2ggf` (this record). This is a **record of a decision already
  taken**: the bead that asked for it described the tokenizer as a proposal, and by the time it was
  picked up the scanner was one. What was missing was the written decision, not the code.
- **Evidence pinned at:** `0bf07a7`. Every line number below is as of that revision.

## Context

`scripts/test-selection.ts` derives which test suites a change needs by reading source text, not by
running a type checker or a parser. It has to answer questions like "does this file call
`Deno.readTextFile` with a path that lands in the repository?" — and the honest answer depends on
whether a given occurrence of that call is **code**, is inside a **string literal**, or is inside a
**comment**, because a read inside a string is data (`audio-feed-lm4d`) and a count of one put
synthetic fixtures into the unresolved list, keeping the inert class unreachable
(`audio-feed-q0ky`).

The first attempts answered those questions with regex replacements. A regex cannot decide whether
`/` is division or the start of a regex literal, cannot tell a `/*` inside a string from a real
block comment, and cannot know how far a template's `${…}` extends. Each attempt therefore traded
one misread for another, and the record of that trade is the file's own history:

| Commit    | Date       | What it had to fix                                                                |
| --------- | ---------- | --------------------------------------------------------------------------------- |
| `97d5552` | 2026-10-12 | a `/*` inside a quoted string was read as a block-comment opener                  |
| `884dc2d` | 2026-10-12 | the character-level scan exposed a latent unresolved-hint bug (`audio-feed-70u4`) |
| `13ec14f` | 2026-10-12 | bare identifiers were classified dishonestly (`audio-feed-rd8l`)                  |
| `ab3f2eb` | 2026-10-12 | regex literals were read as division (`audio-feed-aiiy`)                          |
| `5c43ef2` | 2026-10-12 | regex/division disambiguation needed bracket context                              |
| `702ef63` | 2026-10-12 | a multiline template swallowed code, because string spans were not tracked        |
| `6215f55` | 2026-10-13 | a control head's body brace was read as an object brace (`audio-feed-ghym`)       |
| `374fb40` | 2026-10-13 | out-of-repo status needed to propagate transitively across bindings               |

**Twenty-two commits touched this file in those two days; the eight in the table are the lexical
chain.** Each was correct on its own terms and each is evidence of the same thing: a text-level
question answered with pattern matching gets a text-level answer, and the next construct nobody
thought of is a silent wrong relation. A wrong relation here is not a crash — it is a suite that is
not selected (a gap in the gate) or one selected for no reason (noise that trains people to ignore
the output). Measured with
`git log --since=2026-10-12 --until=2026-10-14 origin/main -- scripts/test-selection.ts`: 22
commits, of which the lexical fixes above are 8; the rest is the relation logic built on top of the
scan (binding scopes, per-module constant visibility, execute relations).

## Decision

The scanner is a **single-pass character-level scan** that maintains lexical state, because lexical
state is the only thing that answers these questions correctly. Whether it is ALSO cheap enough to
run on every gate is a question with a measured answer, in "What it costs" below — not an assumption
of this decision.

`stripComments` (`scripts/test-selection.ts:343`, **271 lines**) returns `{ stripped, spans }`:
`stripped` is the source with comments removed, and `spans` records the UTF-16 code-unit ranges that
are string **content** — so a read call inside a string is data, while a read inside a template's
`${…}` is still a read, because an interpolation is code.

1. **Six contexts** — `CODE`, `STRING`, `TEMPLATE`, `REGEX`, `LINE_COMMENT`, `BLOCK_COMMENT`.
2. **A frame stack, not a single context**, where each frame carries its own `braceDepth`. A
   template interpolation is therefore entered as a new frame and left when its braces balance,
   which is what makes `${ { a:`${b}`} }` tractable. The state _names_ are not the design; the stack
   and the per-frame depth are.
3. **`/` is disambiguated by operand expectation**, not by neighbouring characters: `expectOperand`
   is set by what has been read so far, informed by keyword sets for expression positions (`return`,
   `typeof`, `await`, …), statement positions (`else`, `do`, `default`) and control heads (`if`,
   `for`, `while`, `with`, `switch`, `catch`).
4. **A bracket stack of `OBJECT | BLOCK | CONTROL_HEAD | CALL_GROUP | ARRAY`**, because `{` is not
   one thing: a control head's body brace is a block, a destructuring or literal brace is an object,
   and telling them apart is what `audio-feed-ghym` had to add.

## Consequences

**What it buys.** The four classes above stop being possible-by-construction rather than being
patched one at a time, and lexical state lives in exactly one place that can be tested directly.
`tests/source_scanner_test.ts` (239 lines) is table-driven: **16 cases, of which 2 are
`ignore: true`**, driving `stripComments` directly and named after the beads that found them
(`kpua`, `iz0j`, …). `bare_name_relation_test.ts` (2 rows), `spawn_relation_test.ts` (26),
`read_relation_hints_test.ts` (26) and `fast_gate_subset_test.ts` (39) pin the relations that depend
on the scan — 93 rows in total, and they are the real safety net, because a scanner that reads
correctly but classifies wrongly still loses a relation.

**What it costs — and this is the part to keep in view.** 271 lines of hand-written lexer is itself
a correctness surface, and the eight fixes above are the price already paid for it. It is not a
parser and does not pretend to be: it tracks only the state this file's questions need. The residual
risk is visible and measured rather than imagined: **2 of the 16 cases are known-open and marked
`ignore: true` with their reasons in the file** — a regex after a **labelled** block
(`outer: { … } /re/.test(x)`) still reads as division, because closing the label half needs
statement-start tracking in the classifier, and a regex whose character class contains a quote after
an if-block still has its body survive as code, though there **the harm is already fixed** because
the real path is spanned either way. Keeping them in the table with a reason, rather than deleting
them, is the right shape: an ignored case with a reason is a known gap, an absent case is a
surprise.

**What it costs, measured (audio-feed-csbr).** The cost of the scan is not an impression. Over **335
files / 5,148,143 UTF-16 code units** (5,151,935 UTF-8 bytes; the unit is named because a
`String.length` figure is code units, not bytes, and this is the one place in this record that
should be exact) — every `.ts` under `tests/`, `scripts/` and `src/`, walked recursively — a full
pass of `stripComments` takes **225–406 ms**, which is **671–1212 µs per file**. That is a RANGE
because the spread is machine load, not the corpus: five runs over the same 335 files on this
contended 2-vCPU VM gave 224.83, 248.85, 292.25, 266.96 and 405.86 ms — three of them consecutive at
249/292/267 ms — with `steal` at 9.7M ticks. Quoting any single one as "the" cost would be the same
defect as an unstated unit. Against the 14 s to 40 s a fast gate actually takes, the entire universe
costs **0.6% to 2.1%** of the run, and a typical invocation is far smaller than the universe: the
selector scans the changed suite and the modules it imports to a closure depth of 2, so **ten files
is 7–12 ms**. Method: three warm-up passes then twenty timed, reading the same file contents for
every scanner compared, on this VM. The corpus is walked recursively and deliberately overstates a
single invocation, which is the safe direction for a budget.

The pre-lexer revision has no comparable function to time — `97d5552^` has no `stripComments` at
all, and is 1813 lines against today's 2026 — so the comparison this record can honestly make is the
scan against the gate's total, plus the correctness record above, where eight fixes are the price
the earlier approach paid instead. The parser alternative stays real, and the numbers above say how
much room it has before it is worth taking.

**Budget and trigger.** The scan is expected to stay under **250 ms per full pass on an unloaded
VM** and **450 ms under heavy-slot contention**, with **1.5 ms per file** covering both; even the
contended figure is still under 3.3% of a 14 s gate. If a change doubles the measured range — past
roughly 450 ms quiet or 800 ms contended — or the open-case rate keeps climbing, the parser trade
becomes the cheaper option and should be measured rather than assumed.

**Malformed and uncertain input, and why the failure direction is the safe one (audio-feed-pgpp).**
The scanner has no error channel: it reports spans of text that are NOT code, and a malformed input
produces no spans rather than a complaint. That is the behaviour to state, because "no spans" means
NOTHING is excluded from code, so every read site survives and the selection can only WIDEN — the
selector's safe direction, since a wider selection costs gate time and can never lose a suite. It is
a property of the shape rather than of one case: only marking text as non-code can hide a reference,
and malformed input marks none.

Measured on five inputs, each producing `spans === []` with `stripped` identical to the source and
no read lost: a string left unterminated at EOF by a trailing escape; an unterminated string with a
read BEFORE it and again with a read AFTER it (the order that could plausibly swallow a real site);
and a stray close quote forming a phantom string. Boundary rows for the malformed cases are in
`tests/source_scanner_test.ts` (M1–M3), so the next change to the scanner has to keep this direction
deliberate rather than accidental. The two known-ambiguous lexical cases above are the same story
with the harm named, and they stay pinned with `ignore: true` and their reasons rather than deleted.

**The alternative considered and not taken:** treat an uncertain scan as "unresolved", or fall back
to the full suite. Both are safe, and both were declined for the same reason: there is no error
channel to detect the uncertainty with, so they add a second mechanism whose only effect is MORE
selection on inputs that already widen — and the coarser version selects the whole universe for a
stray backslash instead of the handful of files that mention a symbol. If a future change gives the
scanner an error channel, this section is the thing to revisit.

**What it forecloses, and the trigger to revisit.** Nothing permanently. The escalation path is a
real TypeScript parser, and the trigger should be stated rather than felt: **two of sixteen cases
are already open, each needing "more than one clause" to close** — if scanner fixes keep arriving at
this rate, pattern-matching has stopped being the cheap option and the parser becomes the cheaper
one.

## Alternatives considered

1. **Do nothing and keep patching regexes.** Refuted by the table above: the misreads were not a bug
   in one rule but a property of the approach, and each patch moved the boundary instead of removing
   it.
2. **Parse with a real TypeScript parser** (`deno_ast`, or SWC compiled to WebAssembly). This is the
   correct-by-construction answer and it is what most tools would do. It was not chosen because this
   file runs on **every** gate invocation, on every lane, for every change: a WebAssembly parser
   adds a dependency and a startup cost to the hottest path in the toolchain, to answer questions
   that need lexical state and not a syntax tree. The startup cost remains unmeasured for this
   record — measuring it means adding the dependency and its lockfile change, which is a decision in
   its own right rather than a probe — so what this record fixes instead is the budget that decides
   the question: if the lexer's own per-pass cost doubles past the 225–406 ms measured above, the
   parser's startup stops being a hypothetical and becomes the next thing to measure. This is also
   why the escalation trigger above matters: the alternative stays real and gets better as the lexer
   grows.
3. **Track only strings and comments, and ignore regex literals.** This is what the earlier attempts
   effectively did, and `audio-feed-aiiy` is the record of why it does not work: a regex literal
   containing a quote or a brace makes the string tracker lose its place, and everything after it is
   read as the wrong kind of text.
