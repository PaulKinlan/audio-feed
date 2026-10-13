# 0002. Scan test-selection's source at character level, not with regexes

- **Status:** Accepted — implemented by `audio-feed-70u4` (`97d5552`, `884dc2d`), refined by
  `audio-feed-aiiy` (`ab3f2eb`), `5c43ef2`, `702ef63` and `audio-feed-ghym` (`6215f55`).
- **Date:** 2026-10-13
- **Decision bead:** `audio-feed-2ggf` (this record). This is a **record of a decision already
  taken**: the bead that asked for it described the tokenizer as a proposal, and by the time it was
  picked up the scanner was one. What was missing was the written decision, not the code.
- **Evidence pinned at:** `0bf07a7`. Every line number **and every count** below is as of that
  revision, which is the whole point of pinning it: a reader comparing a figure here against a
  later tree is comparing it against the wrong thing, and will read a correct historical
  measurement as a stale number (`audio-feed-n5e9`). Re-derive rather than trust them — the
  `stripComments` span is its `export function` line to its closing brace, the file sizes are
  `wc -l`, and the test figures are the row count of the case table and the rows that set
  `ignore: true` in it.

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

`stripComments` (`scripts/test-selection.ts:343`, **268 lines** at the pinned revision) returns
`{ stripped, spans }`:
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

**What it costs — and this is the part to keep in view.** 268 lines of hand-written lexer is itself
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
costs **0.6% to 2.9%** of the run, depending on which of the five runs and which end of the 14–40 s
range is used (0.56% at the fastest run against a 40 s gate, 2.90% at the slowest against a 14 s
one), and a typical invocation is far smaller than the universe: the selector scans the changed
suite and the modules it imports to a closure depth of 2, so **ten files is 7–12 ms**. Method: three
warm-up passes then twenty timed, reading the same file contents for every scanner compared, on this
VM. The corpus is walked recursively and deliberately overstates a single invocation, which is the
safe direction for a budget.

The pre-lexer revision has no comparable function to time — `97d5552^` has no `stripComments` at
all, and is 1813 lines against today's 2026 — so the comparison this record can honestly make is the
scan against the gate's total, plus the correctness record above, where eight fixes are the price
the earlier approach paid instead. The parser alternative stays real, and the numbers above say how
much room it has before it is worth taking.

**Budget and trigger.** The scan is expected to stay under **250 ms per full pass on an unloaded
VM** and **450 ms under heavy-slot contention**, with **1.5 ms per file** covering both; even the
contended figure is still under 3.2% of a 14 s gate (450 ms of 14,000). If a change doubles the
measured range — past roughly 450 ms quiet or 800 ms contended — or the open-case rate keeps
climbing, the parser trade becomes the cheaper option and should be measured rather than assumed.

**Malformed and uncertain input, and where the failure direction is safe and where it is not
(audio-feed-pgpp).** The scanner has no error channel: it reports spans of text that are NOT code,
and a malformed input produces no spans rather than a complaint. THE DIRECTION DEPENDS ON THE CASE,
so it is stated per case rather than as a rule about malformed input in general.

**Where it widens, and this is the measured set.** A string left unterminated at EOF by a trailing
escape; an unterminated string with a read BEFORE it and again with a read AFTER it (the order that
could plausibly swallow a real site); and a stray close quote forming a phantom string. Each
produces `spans === []` with `stripped` identical to the source and no read lost, because nothing is
excluded from code, every read site survives, and the selection can therefore only widen — the
selector's safe direction, since a wider selection costs gate time and cannot lose a suite. Boundary
rows for these are in `tests/source_scanner_test.ts` (M1–M3).

**Where it NARROWS, the named counterexample: an unterminated block comment.** A `/*` with no
closing `*/` puts the scanner into comment state for the remainder of the file, so the spans are
empty AND everything to EOF is blanked — measured as 54 characters of source reduced to 1 — and a
read after it is LOST. That makes the selection NARROW rather than widen, and NARROWING IS THE
UNSAFE DIRECTION: a suite that should have been selected can be missed. This is the exception to the
paragraph above and it is named as one, because "malformed input generally widens" would keep the
false universal while sounding like a caveat.

WHY IT IS NOT URGENT, and what would fix it: the trigger is a file that cannot parse, so
`deno check` and the gate fail loudly on that file regardless of what the selector derived from it.
The path that would make it reachable from VALID code — the labelled-block defect letting a `/*`
inside a regex body open a phantom comment — was tested in three shapes and does not lose the read.
The safe answer when the scan reaches EOF still inside any lexical state is to exclude nothing
rather than blank to EOF, because widening costs gate time and narrowing loses a suite. It is filed
as `audio-feed-ywjz` and pinned as ignored row M4 in `tests/source_scanner_test.ts`, so it is
discoverable from the code.

The two known-ambiguous lexical cases above are a different story again, with the harm named, and
they stay pinned with `ignore: true` and their reasons rather than deleted.

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

## Amendment — 2026-10-13: the read question this record left open (`audio-feed-tziw`)

The Context above asks whether a read is a relation when `Deno.readTextFile` names a path that lands
in the repository, and records that the honest answer depends on whether such a path is a
**comment** or **data**, because a read inside a string is data (`audio-feed-lm4d`). This is that
answer, with its measurements, and with both dead ends kept so the next person does not repeat them.

### The decision

A read is admitted as a relation for a `.ts` path **only when the resolver resolved the path**. In
`scripts/test-selection.ts` that is exactly `resolvedPaths`, and the admission is the one-word
call-site change from `add(path, suite)` to `add(path, suite, true)` — the same proven flag
`executedPaths` already passes. Nothing else changes. The guard is no longer `!isExecute` but
`!isProvenRead`, because two different reads now reach it and only one is admitted.

### What "proven" means here, and what it deliberately does not

**`proven read` means THE RESOLVER RESOLVED THE PATH. It does not mean "the suite reads it".** A
read is NOT admitted when its path arrives through `authoredPaths`, which includes a **parameterised
or dynamic read** where the argument is assembled at run time. The worked example is the fixture
tree in `tests/spawn_relation_test.ts`: a suite reading `"../scripts/tool.ts"` by literal lands in
`authoredPaths` and earns **no** relation, and the row asserting that (`audio-feed-4kl3`'s read row)
is left exactly as it was. The distinction this draws is **read-visible-to-the-resolver versus
read-not-visible**, _not_ read versus mention; the broader mention-versus-read distinction is the
next section.

### The gap that remains, and the escape hatch that is NOT BUILT

A suite whose read is dynamic cannot earn the relation this way, and an unresolvable read still
falls to the same FAIL-CLOSED path rather than being silently dropped, because a dynamic read is
exactly where being loud beats being quiet. Such a suite should declare the dependency explicitly.
**NO SUCH DECLARATION MECHANISM IS BUILT — it does not exist yet.** Until it does, a suite with a
dynamic read is uncovered and the full-tier fallback is what protects it.

### The two rejected forms, measured rather than remembered

All three shapes were built and run against the same tree. The numbers are data paths from
`--list-relations` and rows from `tests/spawn_relation_test.ts`:

| shape                                                         | data paths | `.ts` keys | the four pinned rows             |
| ------------------------------------------------------------- | ---------- | ---------- | -------------------------------- |
| `main` before this change                                     | 34         | 11         | pass                             |
| admit every `.ts` path a suite **mentions** (the A2 widening) | 47         | —          | **FOUR FAIL**                    |
| admit `authoredPaths` **and** `resolvedPaths`                 | 45         | 22         | **FOUR FAIL**, plus the read row |
| **admit `resolvedPaths` only (accepted)**                     | **40**     | **17**     | **pass**                         |

The four rows are not incidental: they are the acceptance test of this change, and they are the
reason the narrow form was chosen. In their own words they assert that a change to a spawned script
selects the suite that executes it **and only that suite**; that a path passed in `env`/`cwd` earns
**no** execute relation; that with only `env`/`cwd` mentions the selection is the **FAIL-CLOSED
TIER**; and that _"echo prints the path as data; a relation here is the false positive this bead is
about"_.

Reading the failure messages rather than only the count showed why every broader design fails the
same four: with admission widened, those rows report a relation for `tests/consumer_test.ts` where
they expect none — a suite in a **read** position. So the four encode a policy that a reading suite
gets no relation, and this change **keeps** that policy for every read the resolver cannot see,
rather than reversing it.

### Why not the broader read-class form

A third build admitted literal read-call arguments by classifying the **call** (`readTextFile` and
its equivalents) rather than the bucket. It is a defensible design and it does admit the five
`src/*.ts` keys that suites read as data, but it turns the same four rows red, because those rows
protect the _position_ rather than the _call_. Kept here as a named option: if a future author needs
coverage for reads the resolver cannot follow, that shape is the starting point, and the four rows
are the price to be argued for explicitly — not a cost to be slipped in.

### Consequence

A change to a `.ts` file that a suite reads **as data** now selects that suite when the resolver can
see the path (6 additional keys, none removed), and continues not to when it cannot. The fast gate
gains those suites' runtime, which is the intended trade: the alternative was a read that selected
nobody.

### THIS AMENDMENT IS A PARTIAL, AND IT MUST NOT BE READ AS COMPLETE

Stated plainly, because a partial described as complete is the same class of error as a documented
mechanism that is not built:

1. **It does NOT cover `Deno.readTextFile` with a LITERAL path.** That is the common form, and it is
   the form `audio-feed-tziw` was filed about. A suite reading
   `Deno.readTextFile("../scripts/tool.ts")` still earns **no** relation and a change to that file
   still selects none of its readers. What this amendment covers is the residue: reads whose path
   the **resolver** can follow.
2. **The declaration escape hatch does NOT exist.** A suite with a dynamic read has no way to
   declare the dependency, and that mechanism is **not built**. Until it is, the full-tier fallback
   is what protects those suites, and the FAIL-CLOSED path is deliberate rather than incidental.
3. **The contract question is open, and it is tracked rather than settled.** The four pinned rows go
   red as soon as a `.ts` path is derived for a **reading** suite at all - not because `env`/`cwd`
   is misread as a read, which was the initial hypothesis - and this amendment is green only because
   it admits nothing those four fixtures touch. Whether those rows should still say what they say,
   now that a read is a relation in some cases, is a decision about the SELECTOR's contract rather
   than a detail of this change. It has been split out to its own bead carrying the three builds'
   measurements and the four rows' exact assertions and fixtures, so it is argued on its evidence
   rather than re-litigated here.

**Read this amendment for:** reads the resolver can see now select their readers, and three broader
designs were measured and rejected with their numbers. **Do not read it as:** reads-as-data are
covered.

### THE RULING ON THE CONFLICT, AND WHY IT IS THIS WAY (`audio-feed-rwx5`)

**`audio-feed-9rer` WINS, and the reasoning belongs here rather than only the outcome.** Three
designs were built and measured and every one that admits a literal `.ts` read turns the same four
assertions red. That is not a run of bad designs: it is proof that **no predicate satisfies both
policies**, because `audio-feed-tziw` and `audio-feed-9rer` encode **opposite** ones. `tziw` says a
suite that reads a `.ts` file as data _should_ get the relation; `9rer` says a suite in that
position _must not_, in its own words _"echo prints the path as data; a relation here is the false
positive this bead is about."_ Chasing a fourth shape would have been trying to satisfy a
contradiction, which is why the attempt stopped rather than continued.

`9rer` wins on **specificity**: it is about a specific _position_ — a path that is printed, or
passed via `env`/`cwd`, is not a dependency — whereas `tziw` is about a category. It was also
written **deliberately**, after a false positive was observed. Reversing it therefore needs a
**cost/benefit** argument with the false-positive volume measured, not a design argument, and no
such argument has been made.

**The gap is DOCUMENTED rather than closed, and this record is the documentation.** The conflict now
has its own bead rather than living only in an ADR, so it is findable by the next person who asks
why a read does not select its reader.

### The loss is real, and this is how big it is

The narrower reading of "proven" is not a non-event dressed up as one. Of the keys this change adds,
the five that arrive **only** from literal read-class arguments are
`scripts/passkey-provider-browser-proof.ts`, `src/feed/rss.ts`, `src/ingest/url.ts`,
`src/routes/account.ts` and `src/routes/shell.ts` — and those are **exactly the class
`audio-feed-tziw` exists for**: `src/*.ts` files that suites read as data. They are the reason this
outcome is a **measured** loss rather than a convenient one, and they are the starting point for
anyone who later makes the cost/benefit argument `9rer` is entitled to.

### The dead end worth keeping most

The most useful paragraph in this amendment is the **mechanism** behind `v1`'s failure: the bucket
carrying a read's own argument — `authoredPaths` — **also carries every other non-execute call's
argument.** So "a path the resolver resolved" and "a path the suite merely mentions" are **not
separated by the code as it stands**, and no amount of condition-twisting on that bucket can
separate them. A future attempt at the wider coverage has to introduce a genuinely different signal
— classifying the **call** rather than the bucket — and must then argue the four rows on their
merits. That is the one thing this record most wants to save the next person.
