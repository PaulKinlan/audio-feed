/**
 * audio-feed-ruqh: plumb the evidence DECLARATIONS into test selection (Shape B).
 *
 * THE PROBLEM. `scripts/evidence-run.ts` (audio-feed-4oe2) made a proof able to declare the suite that
 * executes it, and made an evidence RUN fail when that suite does not exist. But nothing connected the
 * declaration to the FAST GATE's selection: a changed proof could declare `- Executed by: tests/x_test.ts`
 * and the gate would happily select some other suite, or none, while reporting itself covered. The
 * declaration existed and nothing consumed it.
 *
 * SHAPE B, DELIBERATELY, AND WHY NOT THE STRICTER ONE: a README that DECLARES an executor must have that
 * suite selected, or the gate fails with a NAMED failure. A README that declares NOTHING keeps exactly
 * today's behaviour. The stricter reading - every changed proof needs an executing suite - would newly
 * fail the 33 declaration sites that carry no `- Executed by:` line, which is not a test-selection change
 * at all but a tree-wide policy change, and that is not a decision one lane should make by editing a rule.
 *
 * PURE BY CONSTRUCTION, so the interesting half is testable without a repo: the caller supplies the
 * changed README paths, the selected suites, and a reader. Nothing here touches the disk.
 *
 * COST ON THE COMMON PATH IS ZERO, and that is a design constraint rather than an accident: this runs
 * only when a changed file is an evidence README (see `evidenceReadmesAmong`), which is rare, so a normal
 * tip reads no READMEs at all. When it does run, it reads one README per changed proof.
 */
import { readDeclaration } from "./evidence-run.ts";

/** A changed evidence README whose DECLARED executor was not selected. */
export interface DeclarationSelectionViolation {
  /** The README that declares the executor, repo-relative. */
  readme: string;
  /** The suite it declares, as written in the README. */
  executedBy: string;
}

/** `./tests/x.ts` and `tests/x.ts` are the same file: selection compares normalised paths. */
function normalise(path: string): string {
  return path.replace(/^\.\//, "");
}

/**
 * The changed paths that ARE evidence READMEs. Declared limit: this matches the flat layout that
 * `audio-feed-c0ft` enforces (`docs/evidence/<dir>/README.md`); a README nested deeper is refused by
 * that check long before it reaches here, so no case is silently skipped.
 */
export function evidenceReadmesAmong(changed: Iterable<string>): string[] {
  return [...changed].filter((p) => /^docs\/evidence\/[^/]+\/README\.md$/.test(normalise(p)));
}

/**
 * Which of `changedReadmes` declare an executor the plan did NOT select.
 *
 * A README that cannot be read, or that declares no executor, is NOT a violation - that is Shape B, and
 * it is the half that keeps this from becoming a tree-wide policy change. Declared limit: the comparison
 * is between the declared path and the plan's suite paths, so a README that declares its executor as an
 * ABSOLUTE path will not match a repo-relative selection and will be reported as a violation. That is the
 * loud direction, and `evidence-run.ts`'s own executor resolution already treats such a declaration as
 * unresolved, so both halves agree about it.
 */
export function findUnselectedExecutors(
  changedReadmes: Iterable<string>,
  selected: Iterable<string>,
  readReadme: (path: string) => string | null,
): DeclarationSelectionViolation[] {
  const chosen = new Set([...selected].map(normalise));
  const violations: DeclarationSelectionViolation[] = [];
  for (const readme of changedReadmes) {
    const text = readReadme(readme);
    if (text === null) continue;
    const { executedBy } = readDeclaration(text);
    if (executedBy === null || executedBy === "") continue;
    if (chosen.has(normalise(executedBy))) continue;
    violations.push({ readme, executedBy });
  }
  return violations;
}
