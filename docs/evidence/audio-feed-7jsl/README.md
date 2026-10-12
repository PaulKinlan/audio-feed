# audio-feed-7jsl — the gate was green over a tree it never checked

- Capture: no assertions
- Reason: Historical CLI transcripts (fmt-check-clean.log, gate-fails-on-unformatted-script.log) demonstrating gate failure on unformatted scripts. Ongoing regression coverage is enforced by tests/deno-task-coverage_test.ts, not an evidence script.

## The gap, measured on main before the fix

| command                                 | result                                              |
| --------------------------------------- | --------------------------------------------------- |
| `deno fmt --check` (what the gate runs) | `Checked 205 files` — exit 0                        |
| `deno fmt --check scripts/`             | `Found 17 not formatted files in 45 files` — exit 1 |

So the gate reported formatting as verified while 45 files under `scripts/` were not examined and 17
of them were unformatted. The cause is `fmt.include` in `deno.json`, which named `src/`, `tests/`
and `main.ts` only.

This is how it was found: a lane ran `deno fmt scripts/` while formatting its own change, the
formatter rewrote 19 unrelated files, and the churn was in the diff instead of in a gate failure.

## The fix

`"scripts/"` added to `fmt.include`. Deliberately there and not in the `fmt` task string: the gate,
editors and CI all run bare `deno fmt --check`, so a path added to the task alone would leave every
other entry point blind. `scripts/` is hand-written TypeScript and the gate already type-checks it,
so the include commentary's rationale — tool-authored markdown and config rewritten by `bd setup` —
never applied to it.

After the fix, `deno fmt --check` covers `Checked 250 files` (205 + the 45 in `scripts/`), and the
17 files are formatted in a second, mechanical commit.

## Verification: the gate fails on a deliberately unformatted script

Appending an unformatted line to `scripts/auth-demo.ts` and running the real task — not a stand-in:

```
$ deno task gate
from .../scripts/auth-demo.ts:
error: Found 1 not formatted file in 250 files
$ echo $?
1
```

Full transcript: `gate-fails-on-unformatted-script.log`. The gate exits at the fmt stage and never
reaches the test suite, which is both the proof and the reason the check is cheap. With the file
restored the fmt stage is green again: `fmt-check-clean.log` (`Checked 250 files`).

## The regression guard, and that it bites

`tests/deno-task-coverage_test.ts` asserts the general property, not "scripts/ is listed": every
tree the gate type-checks must also be inside the fmt scope, so a new directory added to the check
stage without a matching include fails. Verified by removing `scripts/` from the include and
watching it fail with `scripts is type-checked by the gate but is not in fmt.include`, then
restoring it.

## One correction to the finding

The second half was not accurate: bare `deno lint` already checks 245 files and does cover
`scripts/`. This is a fmt gap only. Also worth recording, because it is the trap that started all of
this: `deno fmt <path>` on a path OUTSIDE `fmt.include` reformats files the project deliberately
leaves alone, so format files by name, never directories, unless the directory is in scope.

## Interaction with audio-feed-dc2y

dc2y (in review) edits two of these files — `scripts/home-module-browser-proof.ts` and
`scripts/landing-tooltip-browser-proof.ts` — and had already `deno fmt`-ed them by hand. Both
branches sit on 76b96d1, so the formatting hunks are identical and the merge should be clean; if it
is not, resolve it on the branch rather than by dropping the formatting.
