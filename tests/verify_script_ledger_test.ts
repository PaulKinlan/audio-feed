/**
 * A checked-in script whose name says "verify" is cited by future readers as evidence of current
 * behaviour - but unless a suite actually executes or reads it, nothing keeps it true
 * (audio-feed-byh4j: verify_i7vi_events.ts asserted severity bands that a later landing had moved;
 * the whole-tree scanners "observe" every script only by TEXT-READING the directory, which selects
 * them for changes but proves nothing about the script's claims - the ngrm6 selection/coverage
 * distinction again). So the ledger is binary and enforced: a scripts/verify_*.ts either has an
 * EXACT relation from a suite (a resolver-proven read or execute - the same coverage standard the
 * fast gate's uncovered-code fallback uses), or it carries the HISTORICAL banner as its first line,
 * telling the reader it is not evidence. Anything else is a named failure here.
 */

import { assert } from "@std/assert";
import { deriveDataReadRelations, ROOT, suitesObservingExact } from "../scripts/test-selection.ts";

const BANNER_MARKER = "audio-feed-byh4j: HISTORICAL";

Deno.test("every scripts/verify_*.ts is suite-referenced or bannerred as historical (audio-feed-byh4j)", async () => {
  const relations = await deriveDataReadRelations(ROOT);
  const names = [...Deno.readDirSync(`${ROOT}scripts`)]
    .map((e) => e.name)
    .filter((n) => /^verify_.*\.ts$/.test(n))
    .sort();

  assert(
    names.length > 0,
    "the verify_* family must still exist for this invariant to mean anything",
  );

  const violators: string[] = [];
  for (const name of names) {
    const relPath = `scripts/${name}`;
    if (suitesObservingExact(relPath, relations).length > 0) continue;
    const first = (await Deno.readTextFile(`${ROOT}${relPath}`)).split("\n")[0] ?? "";
    if (first.includes(BANNER_MARKER)) continue;
    violators.push(
      `${relPath}: no suite references it and the HISTORICAL banner ("${BANNER_MARKER}") is missing from line 1`,
    );
  }

  assert(
    violators.length === 0,
    `ungated verify script(s) presented as live evidence - either wire the script into a suite (a test that executes or imports it) or banner line 1 as historical:\n${
      violators.join("\n")
    }`,
  );
});
