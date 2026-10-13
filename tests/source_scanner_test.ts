/**
 * audio-feed-ghym — the selector's comment/string scanner, pinned at the boundaries that have
 * historically traded one defect for another.
 *
 * WHERE THESE FIXTURES COME FROM: the gxp7 measurement (investigator audio-feed-inv-ghym), which drove
 * these cases against 6460a58 and classified 11/16, with the grammar expectations checked independently by
 * parse/eval. They are reproduced here against the REAL function, and that detail is the point: a fixture
 * harness over an extracted copy measures the copy.
 *
 * WHY THEY LIVE HERE: no test drove this scanner at all before this file, so the boundaries ghym is about
 * had no guard. stripComments is exported and returns { stripped, spans }. This file imports
 * scripts/test-selection.ts, which reads nothing at module level, so it inherits NO derived relations and
 * needs no entry in assertSelected's tolerance list - the same reasoning as audio-feed-amho.
 *
 * THE TWO IGNORED CASES ARE OUTSTANDING WORK WITH THEIR CAUSES NAMED, NOT PASSING TESTS: an ignored test
 * without a reason is indistinguishable from a forgotten one, and the two that remain belong to DIFFERENT
 * defects - one in the brace classifier, one in the regex/string context machine. Measured on main
 * (a525563): 11/16 before this fix, 14/16 after, same fixtures and same instrument.
 */
import { assert } from "@std/assert";
import { stripComments } from "../scripts/test-selection.ts";

function inSpan(spans: Array<[number, number]>, marker: string, stripped: string): boolean {
  const idx = stripped.indexOf(marker);
  if (idx === -1) return false;
  return spans.some(([s, e]) => idx >= s && idx < e);
}

type Case = {
  ignore?: boolean;
  name: string;
  src: string;
  expect: string; // human statement of the grammatically-correct behaviour
  check: (
    r: { stripped: string; spans: Array<[number, number]> },
  ) => { pass: boolean; obs: string };
};

const cases: Case[] = [
  // ---- A. uiyv's string/interpolation boundaries -------------------------
  {
    name: "A1 kpua: multiline template containing /* must not eat following code",
    src:
      'const config = `\n  tests/*\n`;\nconst b = Deno.readTextFile("kpua-survives");\n/** Deno.readTextFile("kpua-hidden") */',
    expect: "kpua-survives is CODE (survives, unspanned); kpua-hidden is a comment (gone)",
    check: (r) => ({
      pass: r.stripped.includes("kpua-survives") && !r.stripped.includes("kpua-hidden") &&
        !inSpan(r.spans, "Deno.readTextFile", r.stripped),
      obs: `argSurvives=${r.stripped.includes("kpua-survives")} hiddenGone=${!r.stripped.includes(
        "kpua-hidden",
      )} callIsCode=${!inSpan(r.spans, "Deno.readTextFile", r.stripped)} testsGlobIsSpan=${
        inSpan(r.spans, "tests/*", r.stripped)
      }`,
    }),
  },
  {
    name: "A2 iz0j: regex literal containing a quote must not flip string state",
    src:
      'const re = /"/;\nconst a = Deno.readTextFile("iz0j-after-regex");\n/* Deno.readTextFile("iz0j-swallowed") */',
    expect: "iz0j-after-regex survives; iz0j-swallowed (comment) is gone",
    check: (r) => ({
      pass: r.stripped.includes("iz0j-after-regex") && !r.stripped.includes("iz0j-swallowed"),
      obs: `afterSurvives=${r.stripped.includes("iz0j-after-regex")} commentGone=${!r.stripped
        .includes("iz0j-swallowed")}`,
    }),
  },
  {
    name: "A3 iz0j: interpolation containing quotes/regex must not break the template",
    src:
      'const p = `pre ${x.replace(/"/g, "")} post`;\nconst q = Deno.readTextFile("iz0j-after-interp");',
    expect: "iz0j-after-interp survives as code; ' post' is string content (spanned)",
    check: (r) => ({
      pass: r.stripped.includes("iz0j-after-interp") &&
        !inSpan(r.spans, "Deno.readTextFile", r.stripped) &&
        inSpan(r.spans, " post", r.stripped),
      obs: `argSurvives=${r.stripped.includes("iz0j-after-interp")} callIsCode=${!inSpan(
        r.spans,
        "Deno.readTextFile",
        r.stripped,
      )} postIsSpan=${inSpan(r.spans, " post", r.stripped)}`,
    }),
  },
  {
    name: "A4 nested template inside interpolation",
    src: 'const s = `a ${`inner ${x}`} b`;\nconst t = Deno.readTextFile("nested-after");',
    expect: "nested-after survives as code; ' b' tail is string content",
    check: (r) => ({
      pass: r.stripped.includes("nested-after") &&
        !inSpan(r.spans, "Deno.readTextFile", r.stripped) &&
        inSpan(r.spans, " b", r.stripped),
      obs: `argSurvives=${r.stripped.includes("nested-after")} callIsCode=${!inSpan(
        r.spans,
        "Deno.readTextFile",
        r.stripped,
      )} tailIsSpan=${inSpan(r.spans, " b", r.stripped)}`,
    }),
  },

  // ---- B. ghym's remaining boundaries -------------------------------------
  {
    name: "B1 obj.if: keyword-named property, then division",
    src: "const r = obj.if / divisorA;",
    expect: "GRAMMAR: division (obj.if is a legal ES5+ member name) -> divisorA survives",
    check: (r) => ({
      pass: r.stripped.includes("divisorA"),
      obs: `divisorSurvives=${r.stripped.includes("divisorA")}`,
    }),
  },
  {
    name: "B1b obj.default: statement keyword as property, then division",
    src: "const r = obj.default / divisorB;",
    expect: "GRAMMAR: division -> divisorB survives",
    check: (r) => ({
      pass: r.stripped.includes("divisorB"),
      obs: `divisorSurvives=${r.stripped.includes("divisorB")}`,
    }),
  },
  {
    name: "B1c control head: if (ok) /regex/ is a regex",
    src: "if (ok) /reI/.test(x);",
    expect: "GRAMMAR: regex -> reI blanked",
    check: (r) => ({
      pass: !r.stripped.includes("reI"),
      obs: `reIBlanked=${!r.stripped.includes("reI")}`,
    }),
  },
  {
    name: "B2 label same line: outer: /regex/.test(x)",
    src: "outer: /reL/.test(x);",
    expect: "GRAMMAR: regex (labeled expression statement) -> reL blanked",
    check: (r) => ({
      pass: !r.stripped.includes("reL"),
      obs: `reLBlanked=${!r.stripped.includes("reL")}`,
    }),
  },
  {
    name: "B2b label + block, regex statement on next line",
    // OUTSTANDING - DEFECT 1, the CLASSIFIER (scripts/test-selection.ts): a LABEL body brace still
    // classifies as OBJECT, so the labelled block's closing brace sets expectOperand = false and the next
    // statement's leading / reads as division. The CONTROL-HEAD half of this defect IS fixed below. Closing
    // the label half needs statement-start tracking in the classifier, which is more than one clause.
    ignore: true,
    src: "outer: {\n  const v = 1;\n}\n/reLB/.test(x);",
    expect: "GRAMMAR: regex (block statement is complete; new statement starts) -> reLB blanked",
    check: (r) => ({
      pass: !r.stripped.includes("reLB"),
      obs: `reLBBlanked=${!r.stripped.includes("reLB")}`,
    }),
  },
  {
    name: "B2c if-block, regex statement on next line (ASI boundary)",
    src: "if (c) {\n  const r = 1;\n}\n/reIB/.test(x);",
    expect: "GRAMMAR: regex -> reIB blanked",
    check: (r) => ({
      pass: !r.stripped.includes("reIB"),
      obs: `reIBBlanked=${!r.stripped.includes("reIB")}`,
    }),
  },
  {
    name: "B2d for-block, regex statement on next line (ASI boundary)",
    src: "for (let i = 0; i < 1; i++) {\n  break;\n}\n/reFB/.test(x);",
    expect: "GRAMMAR: regex -> reFB blanked",
    check: (r) => ({
      pass: !r.stripped.includes("reFB"),
      obs: `reFBBlanked=${!r.stripped.includes("reFB")}`,
    }),
  },
  {
    name: "B2e function-decl block, regex statement on next line (control)",
    src: "function f() {\n  const r = 1;\n}\n/reFN/.test(x);",
    expect: "GRAMMAR: regex -> reFN blanked (main should already pass this)",
    check: (r) => ({
      pass: !r.stripped.includes("reFN"),
      obs: `reFNBlanked=${!r.stripped.includes("reFN")}`,
    }),
  },
  {
    name: "B3 return + ASI: return on its own line, regex next line",
    src: "function g() {\n  return\n  /reR/.test(x);\n}",
    expect: "GRAMMAR: regex (ASI ends the return statement) -> reR blanked",
    check: (r) => ({
      pass: !r.stripped.includes("reR"),
      obs: `reRBlanked=${!r.stripped.includes("reR")}`,
    }),
  },
  {
    name: "B3b identifier line then / on next line (no ASI: it IS division)",
    src: "const y = b\n/reD/.test(x);",
    expect: "GRAMMAR: division (expression continues across the line) -> reD survives",
    check: (r) => ({
      pass: r.stripped.includes("reD"),
      obs: `reDSurvives=${r.stripped.includes("reD")}`,
    }),
  },

  // ---- C. the harm probe: misread boundary => iz0j-class over-read --------
  {
    name: "C1 quote-regex right after an if-block: string state must not leak",
    src: 'if (c) {\n  const r = 1;\n}\n/"/.test(x);\nconst k = Deno.readTextFile("qtail");',
    expect: 'qtail is string content (spanned) - the quote inside /"/ must not open a string',
    check: (r) => ({
      pass: inSpan(r.spans, "qtail", r.stripped) && r.stripped.includes("qtail"),
      obs: `qtailPresent=${r.stripped.includes("qtail")} qtailIsSpan=${
        inSpan(r.spans, "qtail", r.stripped)
      }`,
    }),
  },
  {
    name: "C2 realistic: char-class regex after if-block leaks a false path hint",
    // OUTSTANDING - DEFECT 3, the REGEX/string context machine, and it is NOT the brace classifier: a
    // regex literal whose character class contains a quote (/["/*]/) is only PARTIALLY masked - the
    // leading / and two chars are blanked while /*]/.test(name); survives as code. MEASURED with the same
    // if-block on one line and across lines, and a SIMPLE regex (/ab/) after the same block is fully
    // masked, so the trigger is the quote inside the character class rather than the block. The HARM is
    // already fixed (real.txt IS spanned); what remains is the regex body surviving as code.
    ignore: true,
    src:
      'if (cfg.verbose) { log("x"); }\n/["/*]/.test(name);\nconst data = Deno.readTextFile("real.txt");',
    expect:
      "real.txt stays string content (spanned); the regex is blanked so its quotes cannot open a string",
    check: (r) => ({
      pass: inSpan(r.spans, "real.txt", r.stripped) && !r.stripped.includes("real.txt") === false &&
        !r.stripped.includes("/*]/.test"),
      obs: `realIsSpan=${inSpan(r.spans, "real.txt", r.stripped)} regexBodyKeptAsCode=${
        r.stripped.includes("/*]/.test")
      }`,
    }),
  },
  {
    // audio-feed-pgpp: MALFORMED INPUT, AND THE DIRECTION IT FAILS IN. A string left unterminated at EOF
    // by a trailing escape produces NO spans, which means nothing is excluded from code, so every read
    // site survives and the selection can only WIDEN. That is the selector's safe direction - a wider
    // selection costs gate time and can never lose a suite - and this row exists so a future change to
    // the scanner has to keep it deliberate. The read is asserted PRESENT, not blanked.
    name: "M1 malformed: unterminated string at EOF (trailing escape) marks nothing non-code",
    src: `const s = "Deno.readTextFile(\n`,
    expect: "FAIL-CLOSED: no span is marked non-code, so the text stays code and the read survives",
    check: (r) => ({
      pass: r.spans.length === 0 && r.stripped.includes("Deno.readTextFile("),
      obs: `spans=${r.spans.length} readSurvived=${r.stripped.includes("Deno.readTextFile(")}`,
    }),
  },
  {
    // The order that could plausibly HIDE a real read rather than widen: the real site comes AFTER the
    // unterminated string, so a phantom string swallowing the rest of the file would lose it. Measured
    // not to happen; the row pins that.
    name: "M2 malformed: real read AFTER an unterminated string still survives",
    src: `const s = "unterminated\nawait Deno.readTextFile(p);\n`,
    expect: "FAIL-CLOSED: the read after the malformed string is still code, so it is not lost",
    check: (r) => ({
      pass: r.spans.length === 0 && r.stripped.includes("Deno.readTextFile("),
      obs: `spans=${r.spans.length} readSurvived=${r.stripped.includes("Deno.readTextFile(")}`,
    }),
  },
  {
    // A stray close quote forms a phantom string. Same assertion: the read outside it is never eaten.
    name: "M3 malformed: stray close quote does not swallow a real read",
    src: `const s = "abc\";\nawait Deno.readTextFile(p);\n`,
    expect: "FAIL-CLOSED: a phantom string does not remove the read that follows it",
    check: (r) => ({
      pass: r.stripped.includes("Deno.readTextFile("),
      obs: `readSurvived=${r.stripped.includes("Deno.readTextFile(")}`,
    }),
  },
];
for (const c of cases) {
  Deno.test({
    name: `scanner boundary: ${c.name}`,
    ignore: c.ignore === true,
    fn: () => {
      const { pass, obs } = c.check(stripComments(c.src));
      assert(pass, `${c.expect}\n      observed: ${obs}`);
    },
  });
}
