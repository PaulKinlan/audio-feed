const RELATIONS = await deriveDataReadRelations(ROOT);

Deno.test("**DERIVATION**: the relation is read out of the suites, not listed beside them", async () => {
  // The two live instances of the gap this bead is about, derived rather than declared:
  assertSelected(RELATIONS.get("docs/evidence/"), [
    // tests/evidence_census_test.ts is NOT required here even though it usually appears: the helper
    // above records the measurement - a code change in the census script that adds no read flips it.
    "tests/evidence_size_test.ts",
    // audio-feed-3teu added a second observer of the same directory: evidence_size_trap_test.ts imports
    // auditEvidenceSizes() from scripts/evidence-compress.ts, which enumerates through evidencePngs(). The
    // relation is per-SUITE, so a suite that uses the audit is an observer - over-selection, the safe
    // direction, and the reason the gate still runs the size check when the tool itself changes.
    "tests/evidence_size_trap_test.ts",
  ]);
  assertEquals(RELATIONS.get("scripts/observability-agent-run.sh"), [
    "tests/observability_agent_poll_test.ts",
  ]);
  // A suite reading one file by name is found too, and every key is a real path.
  assert(RELATIONS.has("deno.json"), "deno.json is read by the suites that parse the task list");
  for (const path of RELATIONS.keys()) {
    const stat = await Deno.stat(`${ROOT}${path.replace(/\/$/, "")}`).catch(() => null);
    assert(stat !== null, `${path} should be a real path in the tree`);
  }
});

Deno.test("the relation is derived through a path CONSTANT and a default parameter (es8y)", async () => {
  // docs/evidence is read by evidencePngs(), whose directory comes from `EVIDENCE_DIR` in
  // scripts/evidence-compress.ts and reaches the read call through the `dir = EVIDENCE_DIR` default.
  // Break that chain and the derivation test above fails, which is the point: the relation must come
  // from the code rather than from a list that agrees today.
  const suite = await Deno.readTextFile(`${ROOT}tests/evidence_size_test.ts`);
  assert(
    suite.includes("auditEvidenceSizes"),
    "the suite must audit sizes through scripts/evidence-compress.ts (audio-feed-3teu), not walk the tree itself",
  );
  const compress = await Deno.readTextFile(`${ROOT}scripts/evidence-compress.ts`);
  assert(
    compress.includes("evidencePngs("),
    "and that audit must be the one call site that enumerates through evidencePngs()",
  );
  // EVIDENCE_DIR's SPELLING changed in audio-feed-3teu (a `new URL("../docs/evidence", import.meta.url)` so
  // git can read the same string as a path), so this asserts the OUTCOME the old regex was a proxy for: the
  // constant must still be statically resolvable, which is what makes docs/evidence/ a derived relation. The
  // DERIVATION test above asserts the same thing from the gate's own output.
  assert(
    RELATIONS.get("docs/evidence/")?.includes("tests/evidence_size_test.ts") === true,
    "EVIDENCE_DIR must still resolve to ../docs/evidence derivably",
  );
  assert(/dir: string = EVIDENCE_DIR/.test(compress), "the read call must take it by default");
});

Deno.test("module-graph config runs the FULL suite even when a suite happens to read it (es8y)", () => {
  // Found while answering a review question about the allowlist-versus-property shape: the config check used
  // to be a two-filename list, so a NEW config file that some suite reads (add import_map.json, read it in
  // one suite) would select that one suite while every suite's module resolution moved. The family that can
  // move the graph is now checked by name, and the unclassified default still covers everything new.
  const relations = new Map([["import_map.json", ["tests/deno-task-coverage_test.ts"]]]);
  for (
    const config of [
      "deno.json",
      "deno.jsonc",
      "deno.lock",
      "import_map.json",
      "tsconfig.json",
    ]
  ) {
    const plan = planTests([config], NO_GRAPH, NO_NAMED, relations);
    assertEquals(plan.testFiles, null, `${config} must run the full suite: ${plan.reason}`);
    assert(plan.reason.includes("module-graph config"), plan.reason);
  }
});

Deno.test('a detector that THROWS widens instead of answering "no read found" (es8y fail-safe)', async () => {
  // The gap coord named: the plan-level rule was tested, but a THROWING detector was only ever proven by a
  // transcript from a mutated run. A silent empty relation would be the hole itself, so the failure has to
  // be REPORTED and the plan has to widen, never shrink.
  const thrown = await deriveOrWiden(() => {
    throw new Error("detector blew up");
  });
  assertEquals(thrown.relations.size, 0);
  assertEquals(thrown.failure, "detector blew up");
  const widened = planForFailedRelation(thrown.failure!);
  assertEquals(widened.testFiles, null);
  assert(widened.reason.includes("detector blew up"), widened.reason);

  // The happy path returns the relation AND no failure, so the reported failure cannot be a constant.
  const known = new Map([["docs/evidence/", ["tests/evidence_size_test.ts"]]]);
  const ok = await deriveOrWiden(() => Promise.resolve(known));
  assertEquals(ok.failure, null);
  assertEquals(ok.relations.get("docs/evidence/"), ["tests/evidence_size_test.ts"]);
});

Deno.test("audio-feed-he7z: the empty relation the deriver RETURNS widens the plan, in one chain", async () => {
  // The two halves are asserted separately at the tip: deriveOrWiden reports a failure for a THROWING
  // deriver, and planTests widens when it is handed an empty relation. This is the INTEGRATION assertion -
  // the relation the deriver actually RETURNS is fed straight into the planner - because "the deriver
  // returned an empty relation" is exactly what a detector that found nothing produces, and a chain that
  // silently selected nothing there would be the same empty pass this bead exists to remove (audio-feed-38sn
  // was precisely a real input becoming an empty selection).
  const { relations, failure } = await deriveOrWiden(() => Promise.resolve(new Map()));
  assertEquals(failure, null, "an empty relation is NOT a failure - the deriver ran fine");
  assertEquals(relations.size, 0);

  const plan = planTests(["docs/evidence/probe.png"], NO_GRAPH, NO_NAMED, relations);
  assertEquals(plan.testFiles, null, "an empty relation must WIDEN, never select nothing");
  assert(plan.reason.includes("docs/evidence/probe.png"), plan.reason);
  assert(plan.reason.includes("no derived reader"), plan.reason);

  // And the flip side of the chain, so this cannot pass by widening unconditionally: a relation that DOES
  // name a reader selects that suite through the same call.
  const withReader = await deriveOrWiden(() =>
    Promise.resolve(new Map([["docs/evidence/probe.png", ["tests/evidence_size_test.ts"]]]))
  );
  assertEquals(
    planTests(["docs/evidence/probe.png"], NO_GRAPH, NO_NAMED, withReader.relations).testFiles,
    ["tests/evidence_size_test.ts"],
  );
});

Deno.test("a derivation that cannot run WIDENS to the full suite and says why (es8y, detector fail-safe)", () => {
  // The rule coord set for the detector: if it cannot understand, it must not answer "no read found". A
  // data file with no relation available is therefore UNCLASSIFIED, which runs the full suite - never a
  // silent zero. This pins the plan-level half; the gate-level half (the derivation THROWING) is proven by
  // running the gate with a mutated detector and is recorded on the bead.
  const noRelation = new Map<string, string[]>();
  const plan = planTests(["docs/evidence/x.png"], NO_GRAPH, NO_NAMED, noRelation);
  assertEquals(
    plan.testFiles,
    null,
    "a data file must not be silently dropped when no relation is known",
  );
  assert(plan.reason.includes("docs/evidence/x.png"), plan.reason);
  assert(plan.reason.includes("no derived reader"), plan.reason);

  // The inert exception is now markdown ONLY (audio-feed-r9fe removed the declarations): a tooling path
  // that used to be declared unread is unclassified, which runs the FULL suite and names the file.
  assertEquals(planTests(["README.md"], NO_GRAPH, NO_NAMED, noRelation).testFiles, []);
  const former = planTests([".beads/issues.jsonl"], NO_GRAPH, NO_NAMED, noRelation);
  assertEquals(former.testFiles, null, "a formerly-declared path must run the full suite now");
  assert(former.reason.includes(".beads/issues.jsonl"), former.reason);
});

Deno.test("audio-feed-x4kc: any change under tests/ selects tests/fast_gate_subset_test.ts", () => {
  // Altering what a test reads (or its assertions) can falsify read-relation invariants
  // without touching scripts/test-selection.ts. Rule (a) closes this by always selecting
  // the relation-policing suite whenever tests/ is touched.
  const plan = planTests(["tests/evidence_size_test.ts"], NO_GRAPH, NO_NAMED, RELATIONS);
  assert(plan.testFiles !== null);
  assert(
    plan.testFiles.includes("tests/fast_gate_subset_test.ts"),
    `Must include fast_gate_subset_test.ts: ${plan.testFiles.join(", ")}`,
  );
  assert(
    plan.testFiles.includes("tests/evidence_size_test.ts"),
    `Must include the changed test itself: ${plan.testFiles.join(", ")}`,
  );
});

Deno.test("a changed evidence PNG selects the suite that asserts its budget (es8y)", () => {
  // Before this: planTests(["docs/evidence/x.png"]) returned [] and the gate said
  // "no tests to run" - a fast PASS on a tree where evidence_size_test.ts fails.
  const plan = planTests(
    ["docs/evidence/audio-feed-0jp/edit-1280-light.png"],
    NO_GRAPH,
    NO_NAMED,
    RELATIONS,
  );
  assertSelected(
    plan.testFiles,
    ["tests/evidence_size_test.ts", "tests/evidence_size_trap_test.ts"],
  );
});

Deno.test("a changed shell runner selects the suite that executes it (es8y)", () => {
  const plan = planTests(["scripts/observability-agent-run.sh"], NO_GRAPH, NO_NAMED, RELATIONS);
  // audio-feed-t9w1's census test enumerates docs/evidence AND scripts/*.ts, so it observes this
  // runner too. Over-selection in the safe direction: a change to any script now also runs one 40ms
  // unit test. Measured, not assumed - it is the derivation doing this, not a listed relation.
  // audio-feed-sru1b: the bare "scripts" directory key now prefix-matches too, so the deno-task-coverage
  // scan (a whole-scripts/ reader) is selected for any script change - the correct relation for a scanner.
  // audio-feed-95pjk: the proof harness now READS the whole scripts/ directory (a readDir over ../scripts/)
  // to assert the listing is unchanged, so under the same bare-"scripts" prefix rule a script change
  // legitimately selects it - again the DERIVATION doing this, not a listed relation, and the row's own
  // job (prove the listing unchanged) is exactly why the read is right. The pin still reds on anything
  // truly unexpected; the extras list is only ever as complete as the derivation's truth.
  assertSelected(plan.testFiles, ["tests/observability_agent_poll_test.ts"], [
    "tests/evidence_census_test.ts",
    "tests/evidence_run_test.ts",
    "tests/evidence_selection_test.ts",
    "tests/deno-task-coverage_test.ts",
    "tests/l7m1_proof_test.ts",
  ]);
});

Deno.test("a changed data file rides ALONGSIDE a code change", () => {
  const plan = planTests(
    ["src/routes/widgets.ts", "docs/evidence/x.png"],
    new Map(),
    new Map([["src/routes/widgets.ts", ["tests/widgets_test.ts"]]]),
    RELATIONS,
  );
  assertSelected(plan.testFiles, [
    "tests/evidence_size_test.ts",
    "tests/evidence_size_trap_test.ts",
    "tests/widgets_test.ts",
    "tests/evidence_census_test.ts",
    "tests/evidence_run_test.ts",
    "tests/evidence_selection_test.ts",
    "tests/security_audit_test.ts",
    "tests/error_screen_test.ts",
    "tests/tokens_test.ts",
  ]);
});

Deno.test("an undeclared non-TypeScript file runs the FULL suite and names itself", () => {
  const plan = planTests(["mystery/payload.bin"], NO_GRAPH, NO_NAMED, RELATIONS);
  assertEquals(plan.testFiles, null);
  assert(plan.reason.includes("mystery/payload.bin"), plan.reason);
  assert(plan.reason.includes("no derived reader"), plan.reason);
});

Deno.test("a markdown file a suite READS selects that suite, not an inert empty pass (38sn)", () => {
  // Found in review of this delta (audio-feed-38sn): isDocumentation() outranked the derived relation, so a
  // test asserting README contents could be silently unselected while the relation named it in the same run.
  const relations = new Map([["README.md", ["tests/readme_docs_test.ts"]]]);
  assertEquals(
    planTests(["README.md"], NO_GRAPH, NO_NAMED, relations).testFiles,
    ["tests/readme_docs_test.ts"],
  );
  // Not read by anything -> documentation, and the loud inert state still applies. NOTE ON THE EXAMPLE, because
  // this line used to name README.md and no longer can: tests/evidence_size_test.ts (audio-feed-fnrp) now READS
  // the docs/evidence READMEs to enforce the declaration rule, so the repo's derived relation names markdown as
  // a real input and README.md is no longer an inert document. That is the evolution this file's own header
  // anticipates - "a `.md` a suite reads is a real input like any other", and a hand-written "nothing reads
  // this" is "a standing assertion that a later suite can contradict" - so the unread example moves to a
  // document no suite reads rather than the read being hidden from the detector.
  assertEquals(planTests(["docs/unread-notes.md"], NO_GRAPH, NO_NAMED, RELATIONS).testFiles, []);
});

Deno.test("audio-feed-q0ky: the detector REPORTS the read hints it could not resolve, it does not drop them", async () => {
  // The rule below rests on this signal existing. A hint the scan produces that names nothing in the tree is
  // the detector saying "a suite reads something here and I could not confirm what" - and it used to be
  // dropped SILENTLY, which is how an unreadable universe came to be described as inert.
  // NOTE the trailing slash: ROOT is `.../audio-feed/`, and the detector builds paths as `${root}${relPath}`,
  // so a fixture root without it makes every read invisible and the test passes for the wrong reason (it did,
  // on the first attempt - which is why this comment is here rather than in a commit message).
  const root = (await Deno.makeTempDir({ prefix: "q0ky-relation-" })) + "/";
  try {
    await Deno.mkdir(`${root}docs`, { recursive: true });
    await Deno.mkdir(`${root}tests`, { recursive: true });
    await Deno.writeTextFile(`${root}docs/present.md`, "hello\n");

    // A path-shaped template that names nothing: reported, not dropped.
    await Deno.writeTextFile(
      `${root}tests/unresolved_test.ts`,
      "export async function readIt() {\n" +
        "  return await Deno.readTextFile(`../docs/absent.html`);\n" +
        "}\n",
    );
    const report = await deriveReadRelationReport(root, ["tests/unresolved_test.ts"]);
    assertEquals(report.relations.size, 0);
    assertEquals(
      report.unresolved,
      ["docs/absent.html"],
      "a hint that names nothing must be REPORTED, not dropped silently",
    );

    // The resolvable case is silent, so the signal cannot be a constant that always fires.
    await Deno.writeTextFile(
      `${root}tests/resolved_test.ts`,
      'export async function readIt() { return await Deno.readTextFile("../docs/present.md"); }\n',
    );
    const clean = await deriveReadRelationReport(root, ["tests/resolved_test.ts"]);
    assertEquals(clean.unresolved, []);
    assertEquals(clean.relations.get("docs/present.md"), ["tests/resolved_test.ts"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-lkvz: an INTERPOLATED path tail is a hint, not a blind spot", async () => {
  // The blindness this closes: `${dir}/data/table.csv` produced NO hint at all, because the interpolation came
  // FIRST in the token and every path fragment after it was discarded. A detector that answers "I saw nothing"
  // where it in fact saw a path suffix is the silent-absence shape this whole area keeps producing, and under
  // audio-feed-q0ky's rule the fix has a second effect: a tail that names nothing is REPORTED, so an
  // unreadable universe cannot be described as inert.
  //
  // audio-feed-lm4d refined WHERE it is reported: a suffix after an interpolation is a CANDIDATE (it resolves
  // into the relation when it names a real file), so a miss from one is a fragment that names no file in the
  // tree rather than a read the detector could not resolve. It is still reported - never silent - and the
  // widening decision is what changed: a fragment that could hide an inert-eligible read still blocks
  // (scripts/fast-check.ts, couldHideInertRead), and `data/table.csv` cannot, because a .csv change is
  // unclassified and runs the full suite anyway.
  const root = (await Deno.makeTempDir({ prefix: "lkvz-relation-" })) + "/";
  try {
    await Deno.mkdir(`${root}tests`, { recursive: true });
    await Deno.mkdir(`${root}docs`, { recursive: true });
    await Deno.writeTextFile(`${root}docs/present.md`, "hello\n");

    // The tail names nothing: the hint is produced AND reported as a fragment (the no-silence case).
    await Deno.writeTextFile(
      `${root}tests/absent_test.ts`,
      "export async function readIt(dir: string) {\n" +
        "  return await Deno.readTextFile(`${dir}/data/table.csv`);\n" +
        "}\n",
    );
    const absent = await deriveReadRelationReport(root, ["tests/absent_test.ts"]);
    assertEquals(absent.relations.size, 0);
    assertEquals(
      absent.unattributed,
      ["data/table.csv"],
      "an interpolated path fragment must be reported, not silent",
    );

    // An interpolation FIRST, with a tail that DOES name a real file: the relation over-selects the suite,
    // which is the safe direction - and the point is that the detector saw it at all.
    await Deno.writeTextFile(
      `${root}docs/present.md`,
      "hello\n",
    );
    await Deno.writeTextFile(
      `${root}tests/tail_test.ts`,
      "export async function readIt(prefix: string) {\n" +
        "  return await Deno.readTextFile(`${prefix}/docs/present.md`);\n" +
        "}\n",
    );
    const tail = await deriveReadRelationReport(root, ["tests/tail_test.ts"]);
    assertEquals(
      tail.relations.get("docs/present.md"),
      ["tests/tail_test.ts"],
      "an interpolated tail that names a real file must be recorded as a relation",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audio-feed-q890: deriveReadRelationReport normalises root without trailing slash", async () => {
  // A caller who passes a root without a trailing slash (e.g. from Deno.makeTempDir()) must not get an empty
  // report with no diagnostic for a fixture that genuinely reads a file. Both forms must behave identically.
  //
  // audio-feed-weg5: the fixture must carry a real file and declaratively read it, so the test asserts
  // the positive derivation rather than an equality between two empty sets. The known-good with-slash
  // case is asserted first so fixture issues fail loudly before comparing spellings.
  const dir = await Deno.makeTempDir({ prefix: "q890-slash-demo-" });
  try {
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    await Deno.writeTextFile(`${dir}/README.md`, "# Test repo\nDeclarative read fixture.\n");
    await Deno.writeTextFile(
      `${dir}/tests/read_test.ts`,
      "const dir = import.meta.dirname;\n" +
        "Deno.readTextFile(`${dir}/README.md`);\n" +
        "Deno.readTextFile(`${dir}/README`);\n",
    );

    // Call with trailing slash first (the known-good baseline):
    const withSlash = await deriveReadRelationReport(`${dir}/`, ["tests/read_test.ts"]);

    // (1) POSITIVE FIXTURE: assert the known-good spelling derives the declarative relation first
    assert(
      withSlash.relations.has("README.md"),
      "with-slash positive fixture must derive README.md relation",
    );
    const withSlashObservers = withSlash.relations.get("README.md") ?? [];
    assert(
      withSlashObservers.includes("tests/read_test.ts"),
      "with-slash positive fixture must include tests/read_test.ts observer",
    );
    const allowedObservers = new Set(["tests/read_test.ts"]);
    for (const observer of withSlashObservers) {
      assert(
        allowedObservers.has(observer),
        `with-slash relation contained unexpected observer: ${observer}`,
      );
    }
    assertEquals(withSlash.unclassified, ["README"]);

    // Call without trailing slash (as returned by Deno.makeTempDir()):
    const withoutSlash = await deriveReadRelationReport(dir, ["tests/read_test.ts"]);

    // Assert without-slash derives the declarative relation identically:
    assert(
      withoutSlash.relations.has("README.md"),
      "a root without a trailing slash must derive the README.md relation",
    );
    const withoutSlashObservers = withoutSlash.relations.get("README.md") ?? [];
    assert(
      withoutSlashObservers.includes("tests/read_test.ts"),
      "without-slash relation must include tests/read_test.ts observer",
    );
    for (const observer of withoutSlashObservers) {
      assert(
        allowedObservers.has(observer),
        `without-slash relation contained unexpected observer: ${observer}`,
      );
    }
    assertEquals(
      withoutSlash.unclassified,
      ["README"],
      "a root without a trailing slash must derive relations identically to one with a trailing slash",
    );
    assertEquals(withoutSlash.unclassified, withSlash.unclassified);
    assertEquals([...withoutSlash.relations.entries()], [...withSlash.relations.entries()]);

    // (2) DEGENERATE FIXTURE: a genuinely empty fixture cannot derive the relation or manufactured reads
    const emptyDir = await Deno.makeTempDir({ prefix: "q890-empty-demo-" });
    try {
      await Deno.mkdir(`${emptyDir}/tests`, { recursive: true });
      await Deno.writeTextFile(`${emptyDir}/tests/empty_test.ts`, "export const x = 1;\n");
      const emptyReport = await deriveReadRelationReport(emptyDir, ["tests/empty_test.ts"]);
      assertEquals(emptyReport.unclassified, []);
      assertEquals(emptyReport.relations.size, 0);
      assert(
        !emptyReport.relations.has("README.md"),
        "degenerate fixture cannot derive README.md relation",
      );
    } finally {
      await Deno.remove(emptyDir, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("audio-feed-40ch / audio-feed-tz01: assets and fixtures INSIDE src/ and tests/ are in the relation, and no-reader ones still widen", async () => {
  // The property this bead adds, asserted against the REAL tree because that is where the two halves meet:
  // the detector must produce a relation for a non-TS file under src/ or tests/ that a suite reads, and the
  // OLD scope note (recorded nowhere) must be gone.
  // audio-feed-tz01: assetUrl(...) / assetBody(...) and text imports now derive readers for all 12 assets
  // under src/assets/, including src/assets/home.css (which previously had no derived reader and forced
  // the full 133-suite gate on rxa2).
  const { relations } = await deriveReadRelationReport(ROOT);
  for (
    const asset of [
      "src/assets/admin.css",
      "src/assets/admin.js",
      "src/assets/confirm-shared.js",
      "src/assets/cwv-stats.js",
      "src/assets/cwv.js",
      "src/assets/home.css",
      "src/assets/home.js",
      "src/assets/listen-landing.css",
      "src/assets/listen-landing.js",
      "src/assets/listen.css",
      "src/assets/listen.js",
      "src/assets/tooltip-client.js",
    ]
  ) {
    assert(
      relations.has(asset),
      `every shipped asset in src/assets/ must have a derived reader (audio-feed-40ch / audio-feed-tz01): ${asset}`,
    );
  }
  const derived = classifyNonTsChanges(["src/assets/admin.css"], relations);
  assertEquals(
    derived.unclassified,
    [],
    "a src/ asset with a derived reader must not fall to the full-suite class",
  );
  assertEquals(
    derived.suites,
    suitesObserving("src/assets/admin.css", relations),
    "the suites named by the relation - the exact-key readers AND the whole-tree scanners (audio-feed-sru1b) - are the suites selected",
  );
  const homeCssSuites = relations.get("src/assets/home.css") ?? [];
  assert(
    homeCssSuites.includes("tests/home_asset_test.ts"),
    `src/assets/home.css must select tests/home_asset_test.ts (audio-feed-tz01), got: ${
      JSON.stringify(homeCssSuites)
    }`,
  );

  // Anti-vacuity for the FALLBACK, which is the thing that makes this change safe to make: a non-TS file
  // that NOTHING is derived to read must still widen to the full suite, and must never be inert.
  // audio-feed-sru1b moved the EXAMPLE, not the rule: while a whole-src/ scanner lives (tokens_test reads
  // every src/assets/*.css; security_audit reads every src/**/*.ts), no path under src/ is unread, so the
  // case is exercised by a path outside every scanned tree. If the scanners ever go away, their relation
  // keys go with them and this example could move back.
  const unread = classifyNonTsChanges(["docs/unread.css"], relations);
  assertEquals(unread.inert, [], "an unread asset is not documentation - it may not be inert");
  assertEquals(unread.suites, [], "nothing is derived to read it");
  assertEquals(
    unread.unclassified,
    ["docs/unread.css"],
    "so it keeps the full-suite fallback",
  );

  // AND THE DECISION ITSELF, through planTests - because the classification above is only a step. My first
  // version of this case asserted the classification and stopped there, and the PLANNER was still returning
  // the full suite for src/assets/admin.css: a guard ahead of the relation widened every non-.ts file under
  // src/ or tests/ before the relation was ever consulted, so the relation's entries for those paths were
  // unreachable. Measuring the planner is what found it, so the planner is what this asserts.
  const derivedPlan = planTests(["src/assets/admin.css"], new Map(), new Map(), relations);
  assertEquals(
    derivedPlan.testFiles,
    suitesObserving("src/assets/admin.css", relations),
    "a src/ asset a suite reads must SELECT that suite, not the full suite",
  );
  // audio-feed-sru1b: the selection is the asset's readers PLUS the whole-src/ scanners, and nothing else.
  for (const scanner of ["tests/security_audit_test.ts", "tests/tokens_test.ts"]) {
    assert(
      derivedPlan.testFiles?.includes(scanner),
      `a src/ asset change must select the whole-tree scanner ${scanner}`,
    );
  }
  const homeCssPlan = planTests(["src/assets/home.css"], new Map(), new Map(), relations);
  assertEquals(
    homeCssPlan.testFiles,
    suitesObserving("src/assets/home.css", relations),
    "src/assets/home.css must select its readers rather than forcing the full gate (audio-feed-tz01)",
  );
  const unreadPlan = planTests(["docs/unread.css"], new Map(), new Map(), relations);
  assertEquals(
    unreadPlan.testFiles,
    null,
    "an unread asset must still run the FULL suite - the fallback is what makes this change safe",
  );
  assertStringIncludes(unreadPlan.reason, "docs/unread.css");

  // audio-feed-sru1b (coord's rule): a suite that declares a WHOLE-TREE scan of src/ is selected for ANY
  // src/ change - that is the correct relation for a scanner, not a widened timeout - and this row reds if
  // either scanner drops out of a src/ selection. Measured against the REAL tree because that is where the
  // detector, the directory keys, and the planner meet: "src" is earned by tokens_test's literal readDir
  // calls, "src/" by security_audit_test's literal entry read (its scan recursion crosses a parameter
  // boundary the resolver provably cannot see through, which is why the entry read carries the literal).
  assertEquals(
    relations.get("src"),
    ["tests/tokens_test.ts"],
    "the bare src/ tree scan must earn a directory relation keyed 'src'",
  );
  assertEquals(
    relations.get("src/"),
    ["tests/error_screen_test.ts", "tests/security_audit_test.ts"],
    "every whole-src/ text scan must earn the directory relation keyed 'src/' - error_screen walks the tree for throw sites, security_audit for CSP headers; a computed walk root earns nothing and this row reds",
  );
  const serverPlan = planTests(["src/server.ts"], NO_GRAPH, NO_NAMED, relations);
  for (
    const scanner of [
      "tests/error_screen_test.ts",
      "tests/security_audit_test.ts",
      "tests/tokens_test.ts",
    ]
  ) {
    assert(
      serverPlan.testFiles?.includes(scanner),
      `a src/ change must select the whole-tree scanner ${scanner} (audio-feed-sru1b), got: ${
        JSON.stringify(serverPlan.testFiles)
      }`,
    );
  }
});

Deno.test("audio-feed-q0ky: while the relation is INCOMPLETE no file is inert, and the widening is NAMED", () => {
  const unresolved = ["data/table.csv", "fixtures.html"];
  const widened = planTests(
    ["docs/observability-api.md"],
    NO_GRAPH,
    NO_NAMED,
    new Map(),
    [],
    unresolved,
  );
  assertEquals(
    widened.testFiles,
    null,
    "no file may be called inert while the detector has unresolved reads (coord's decision (b))",
  );
  assert(widened.reason.includes("INCOMPLETE"), widened.reason);
  assert(widened.reason.includes("docs/observability-api.md"), widened.reason);
  assert(widened.reason.includes("data/table.csv"), widened.reason);
  assertEquals(
    widened.reason.includes("selects nothing"),
    false,
    "a widened run must not read like an empty selection",
  );

  // The rule keys on INCOMPLETENESS, not on markdown: with a complete relation the same change is still
  // inert, which is what keeps a docs-only change off the full suite when nothing is in doubt.
  assertEquals(planTests(["docs/observability-api.md"], NO_GRAPH, NO_NAMED).testFiles, []);

  // And it cannot make an already-conservative path quieter: unclassified data still widens, named.
  const dataish = planTests(["docs/evidence/x.png"], NO_GRAPH, NO_NAMED, new Map(), [], unresolved);
  assertEquals(dataish.testFiles, null);
  assert(dataish.reason.includes("docs/evidence/x.png"), dataish.reason);
});

Deno.test("audio-feed-q0ky: a derivation that THROWS still widens and reports no unresolved list", async () => {
  const thrown = await deriveOrWidenReport(() => {
    throw new Error("detector blew up");
  });
  assertEquals(thrown.failure, "detector blew up");
  assertEquals(thrown.report.unresolved, []);
  assertEquals(thrown.report.relations.size, 0);
  assertEquals(planForFailedRelation(thrown.failure!).testFiles, null);
});

Deno.test("the ordering rule is CHECKED: inert documentation with a derived reader is a named full-suite run (38sn)", () => {
  // rev-13 found an ORDERING bug, so the order is what the gate now checks: the derived relation outranks the
  // category heuristic. The planner selects the reader (relation first), and the guard - the check that
  // would have caught 38sn - names any path treated as inert while a derived reader exists. Mutating the
  // order in classifyNonTsChanges() kills the planner half; the guard half is a pure function on purpose.
  const relations = new Map([["README.md", ["tests/readme_docs_test.ts"]]]);
  assertEquals(inertContradictions(["README.md"], relations), ["README.md"]);
  // And now against the repo's OWN derived relations: README.md is a contradiction there too, because
  // tests/evidence_size_test.ts really does read the docs/evidence READMEs (audio-feed-fnrp). A guard firing on
  // the repo's real relation rather than on a synthetic one is the case that matters most, so this replaces the
  // earlier assertion that the repo had no such contradiction - true when written, false since markdown became
  // a real input.
  assertEquals(inertContradictions(["README.md"], RELATIONS), ["README.md"]);
  // The case the guard must still pass: a document nothing derives a reader for.
  assertEquals(inertContradictions(["docs/unread-notes.md"], RELATIONS), []);
  // The inverse, and the reason the guard exists: THIS repo's relation observes docs/evidence/, so a data
  // path reaching the inert bucket is precisely the ordering bug - the guard must flag it. (With the
  // predicate-based guard this returned [] because the path is not markdown, which is how the .md-shaped
  // guard covered the instance and missed the shape - audio-feed-t0sp.)
  assertEquals(inertContradictions(["docs/evidence/x.png"], RELATIONS), ["docs/evidence/x.png"]);
  // audio-feed-t0sp: the guard covers the BUCKET, not the .md predicate. A NON-markdown category that some
  // future change pushes into the inert bucket is caught here even though isDocumentation() is false for it -
  // rev-16's repro (a `.csv` with a named reader) expressed as a guard call rather than as a classifier
  // mutation, which is what makes it a regression test rather than a demonstration.
  const csvRelations = new Map([["data/table.csv", ["tests/table_docs_test.ts"]]]);
  assertEquals(inertContradictions(["data/table.csv"], csvRelations), ["data/table.csv"]);
  // And the guard must not be a predicate in disguise: it is handed a bucket, so a path in that bucket with
  // NO derived reader is fine (the loud inert state), whatever its extension.
  assertEquals(inertContradictions(["data/table.csv"], RELATIONS), []);
  assertEquals(
    planTests(["README.md"], NO_GRAPH, NO_NAMED, relations).testFiles,
    ["tests/readme_docs_test.ts"],
    "the derived relation must outrank the documentation heuristic",
  );
});

Deno.test("documentation still runs nothing, and a formerly-declared path runs EVERYTHING (r9fe)", () => {
  assertEquals(planTests(["README.md"], NO_GRAPH, NO_NAMED).testFiles, []);
  assertEquals(planTests(["docs/observability-api.md"], NO_GRAPH, NO_NAMED).testFiles, []);
  // The six paths that used to carry an UNREAD_DECLARATIONS entry (audio-feed-r9fe measured them at 15
  // changes in 652 commits and deleted the list): unclassified now, so the full suite and a named reason.
  for (const formerlyDeclared of [".beads/issues.jsonl", ".github/workflows/x.yml", ".gitignore"]) {
    const plan = planTests([formerlyDeclared], NO_GRAPH, NO_NAMED, RELATIONS);
    assertEquals(
      plan.testFiles,
      null,
      `${formerlyDeclared} must run the full suite: ${plan.reason}`,
    );
    assert(plan.reason.includes(formerlyDeclared), plan.reason);
  }
});

Deno.test("classifyNonTsChanges sorts every changed non-.ts file into one of the buckets", () => {
  const classified = classifyNonTsChanges([
    "src/server.ts",
    "README.md",
    "docs/unread-notes.md",
    "docs/evidence/x.png",
    ".beads/issues.jsonl",
    "mystery/payload.bin",
  ], RELATIONS);
  // README.md moved out of the inert bucket for the reason recorded above: a suite reads the docs/evidence
  // READMEs now, so markdown is a real input and the inert bucket is exercised by a document nothing reads.
  assertEquals(classified.inert, ["docs/unread-notes.md"]);
  // audio-feed-sru1b: src/server.ts sits under the whole-tree scanners' directory keys ("src", "src/"),
  // so the scanners join the bucket. And since audio-feed-38f28 its SIX proven importers are an exact
  // relation, so classify names them too - the same suitesObserving channel planTests uses for code
  // changes, so the bucket and the selector cannot disagree. The .ts skip now applies only to files NO
  // channel observes.
  assertSelected(classified.suites, [
    "tests/admin_observability_test.ts",
    "tests/admin_throttle_test.ts",
    "tests/error_screen_test.ts",
    "tests/evidence_size_test.ts",
    "tests/evidence_size_trap_test.ts",
    "tests/legacy_audio_inventory_test.ts",
    "tests/log_request_surface_invariant_test.ts",
    "tests/observability_api_test.ts",
    "tests/security_audit_test.ts",
    "tests/server_bootstrap_test.ts",
    "tests/tokens_test.ts",
  ]);
  assertEquals(classified.unclassified, [".beads/issues.jsonl", "mystery/payload.bin"]);
});

// ---------------------------------------------------------------------------
// Condition 2: an empty selection is a distinct, loud state, never a silent pass
// ---------------------------------------------------------------------------

Deno.test("an empty selection is allowed only for provably inert changes (es8y condition 2)", () => {
  // Inert means markdown documentation and nothing else (audio-feed-r9fe: the declarations are gone).
  for (
    const inert of [
      ["README.md"],
      ["CHANGELOG.md"],
      ["docs/observability-api.md"],
    ]
  ) {
    const plan = planTests(inert, NO_GRAPH, NO_NAMED);
    assertEquals(plan.testFiles, [], `${inert} should select nothing: ${plan.reason}`);
    assert(plan.reason.includes("inert, no suite is derived to read it"), plan.reason);
  }
  // A tooling path is NOT inert any more: it runs the full suite and names itself.
  assertEquals(planTests([".beads/issues.jsonl"], NO_GRAPH, NO_NAMED).testFiles, null);
  assertEquals(
    planTests([], NO_GRAPH, NO_NAMED).testFiles,
    null,
    "an empty change set is NOT proven inert (nothing was checked)",
  );
});

Deno.test("a standalone script nothing imports runs the FULL suite, not a silent zero (es8y)", () => {
  // scripts/smoke.ts has no importer and no name-matched suite: the old carve-out called the type-check
  // its gate and returned [], which is indistinguishable from "suites ran and passed".
  const plan = planTests(["scripts/smoke.ts"], NO_GRAPH, NO_NAMED);
  assertEquals(plan.testFiles, null, plan.reason);
  assert(plan.reason.includes("scripts/smoke.ts"), plan.reason);
  assert(plan.reason.includes("not inert by declaration"), plan.reason);
});

Deno.test("the empty state is announced for the coverage line and said out loud", async () => {
  // PROSE MUST NOT BE PARSEABLE AS A GATE MARKER (audio-feed-psjb). The fleet's coverage reporter matches
  // `unmapped:` ANYWHERE in a line, so a test NAME containing that token is harvested as a list of changed
  // files: this test used to be called `... marked \`unmapped:\` ...` and the reporter published sixteen
  // English words ("and", "for", "line", "ok", ...) as changed files on a run where four files changed -
  // confident nonsense rather than an honest absence. This name is deliberately free of every marker token
  // (passed:, ran:, unmapped:); name new tests the same way.
  //
  // The reporter parses `fast-gate: .*unmapped:` into explicit_unmapped and turns a non-empty list into a
  // COVERAGE WARNING, so an all-inert change is visible in the coverage line instead of reading like a
  // green test run.
  const reporter = /(?:fast-gate:.*?)?unmapped:\s*(.*)/;
  const line = suiteMarker("unmapped", ["README.md", "docs/observability-api.md"]);
  const match = reporter.exec(line);
  assert(match !== null, line);
  assertEquals(match[1]!.split(/\s+/), ["README.md", "docs/observability-api.md"]);

  const source = await Deno.readTextFile(`${ROOT}scripts/fast-check.ts`);
  assert(source.includes("NO SUITES SELECTED"), "the fast gate must say the empty state out loud");
  assert(source.includes('suiteMarker("unmapped"'), "and mark it unmapped for the coverage line");
  assert(
    !source.includes("no tests to run"),
    "the old cheerful phrasing must be gone: it read like a pass",
  );
});

// ---------------------------------------------------------------------------
// Condition 4: the universe is PROVEN equal to Deno's discovery, by running Deno
// ---------------------------------------------------------------------------

const canRunDeno = (() => {
  try {
    return Deno.permissions.querySync({ name: "run", command: "deno" }).state === "granted";
  } catch {
    return false;
  }
})();

Deno.test({
  name:
    "discovery equals `deno test --no-run` over a planted corpus (needs --allow-run=deno; the gate grants it)",
  ignore: !canRunDeno,
  fn: async () => {
    const proof = await proveDiscoveryMatchesDeno();
    assert(proof.ok, proof.detail);
    assertEquals(proof.ours, proof.deno);
    // The corpus really does cover the patterns and the look-alikes:
    for (const planted of ["b.test.ts", "c_test.mts", "d_test.js", "src/inline.test.ts"]) {
      assert(
        proof.deno.includes(planted),
        `${planted} should be discovered: ${proof.deno.join(", ")}`,
      );
    }
    for (const notATest of ["tests/helper_in_tests.ts", "helper.ts"]) {
      assert(!proof.deno.includes(notATest), `${notATest} must not be discovered`);
    }
  },
});

// ---------------------------------------------------------------------------
// fastSelection(C) is inside the universe for an adversarial corpus
// ---------------------------------------------------------------------------

Deno.test("every selection in the adversarial corpus is inside the full gate's universe", async () => {
  const universe = new Set(await discoverFullGateTestFiles(ROOT));
  const corpus: string[][] = [
    ["docs/evidence/audio-feed-0jp/edit-1280-light.png"],
    ["scripts/observability-agent-run.sh"],
    ["docs/observability-api.md"],
    ["README.md"],
    ["scripts/smoke.ts"],
    ["src/storage/kv/runs.ts"],
    ["src/app.ts"],
    ["tests/fixtures.ts"],
    ["tests/fixtures/page.html"],
    ["deno.json"],
    ["mystery/payload.bin"],
    [],
  ];
  for (const changed of corpus) {
    const plan = planTests(changed, new Map(), NO_NAMED, RELATIONS);
    if (plan.testFiles === null) continue; // the full suite is trivially inside itself
    const outside = plan.testFiles.filter((f) => !universe.has(f));
    assertEquals(outside, [], `${changed.join(", ")} selected modules outside the universe`);
  }

  // The case that FAILS on the pre-fix code: the name-matching convention accepts tests/foo-test.ts, which
  // Deno never discovers - so selecting it makes the fast gate run something the full gate does not.
  const mirror = planTests(
    ["src/routes/widgets.ts"],
    new Map(),
    new Map([["src/routes/widgets.ts", ["tests/foo-test.ts"]]]),
  );
  assertEquals(mirror.testFiles, null, mirror.reason);
});

Deno.test("the module-graph config family is audited against what the resolver ACTUALLY reads (es8y)", async () => {
  // The family list is a net; this is the check that keeps it honest. Derived from deno.json(c) (`extends`
  // recursively, its `lock` field, the default lockfile) rather than enumerated, so a config shape nobody
  // thought of is still found - and a resolver input the family does not name is a NAMED failure.
  const inputs = await resolverConfigInputs(ROOT);
  assert(inputs.includes("deno.json"), inputs.join(", "));
  assertEquals(auditResolverConfigs(inputs), []);

  // Bites: an `extends` target the family does not know, and a fixture config that extends another file.
  const problems = auditResolverConfigs(["deno.json", "base.json"]);
  assertEquals(problems.length, 1);
  assert(problems[0]!.includes("base.json"), problems[0]);

  const dir = await Deno.makeTempDir({ prefix: "af-configs-" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ extends: "./base.json", lock: true }),
    );
    await Deno.writeTextFile(`${dir}/base.json`, "{}");
    await Deno.writeTextFile(`${dir}/deno.lock`, "{}");
    assertEquals(await resolverConfigInputs(`${dir}/`), ["base.json", "deno.json", "deno.lock"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the detector reads a fixture suite that reads a fixture data file (es8y)", async () => {
  // The detector is exercised on its own fixture tree, so the rules it claims to implement are visible here
  // rather than only in the live relation: a string literal, `new URL("<literal>", import.meta.url)`, and a
  // constant built from `${import.meta.dirname}` (the docs/evidence shape).
  const dir = await Deno.makeTempDir({ prefix: "af-relations-" });
  try {
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    await Deno.mkdir(`${dir}/scripts`, { recursive: true });
    await Deno.mkdir(`${dir}/data`, { recursive: true });
    await Deno.writeTextFile(`${dir}/data/table.csv`, "a,b\n");
    await Deno.writeTextFile(`${dir}/fixtures.html`, "<p>fixture</p>");
    await Deno.writeTextFile(
      `${dir}/scripts/paths.ts`,
      "export const DATA_DIR = `${import.meta.dirname}/../data`;\n",
    );
    await Deno.writeTextFile(
      `${dir}/tests/fixture_read_test.ts`,
      `import { DATA_DIR } from "../scripts/paths.ts";
import { assertEquals } from "jsr:@std/assert";

Deno.test("reads", async () => {
  await Deno.readTextFile(\`\${DATA_DIR}/table.csv\`);
  await Deno.readTextFile(new URL("../fixtures.html", import.meta.url));
  await Deno.readTextFile("data/table.csv");
  assertEquals(1, 1);
});
`,
    );

    const relations = await deriveDataReadRelations(`${dir}/`);
    assertEquals(relations.get("data/table.csv"), ["tests/fixture_read_test.ts"]);
    assertEquals(relations.get("fixtures.html"), ["tests/fixture_read_test.ts"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("audio-feed-coao: the exww proof script maps to its mutant suite", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const report = await deriveReadRelationReport(root);
  const suites = report.relations.get("scripts/exww-live-claims-browser-proof.ts") || [];
  assert(
    suites.includes("tests/exww_mutants_test.ts"),
    "the proof script must map to its executing test suite, not fail-close or select nothing",
  );
});
/**
 * audio-feed-es8y — the fast gate's selection must be a PROVEN SUBSET of the full gate's.
 *
 * The full gate ends in `deno test` with no file arguments, so Deno discovers test modules by basename
 * pattern anywhere in the repo. The fast gate runs an explicit list. These tests pin the two properties the
 * fix rests on, and the ledger that replaced "not a .ts file, so no test can care":
 *
 *   1. every module the fast gate selects is a module the full gate runs;
 *   2. every module the full gate runs is selectable by the fast gate or justified by an exclusion, and a
 *      module that is neither is a NAMED failure (the case that used to be silent).
 *
 * The fixture-tree case in `discovery follows Deno's basename rule` is the empirical rule measured on Deno
 * 2.9.7 (a_test.ts / b.test.ts / c_test.mts / d_test.js and tests/sub/deep.test.ts ran; helper.ts and
 * tests/helper_in_tests.ts did not) written down as a test, so the rule cannot quietly change under us
 * without this failing.
 *
 * Nothing here spawns a subprocess EXCEPT the discovery proof, which needs `--allow-run=deno`; that test
 * declares the requirement and is skipped where the permission is not granted (`deno task test` grants no
 * --allow-run, the gate tasks do, and `deno task gate` also runs the same proof at the start via the CLI).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  allTestFiles,
  deriveOrWiden,
  deriveOrWidenReport,
  planForFailedRelation,
  planTests,
  suiteMarker,
} from "../scripts/fast-check.ts";
import {
  auditResolverConfigs,
  auditSelection,
  classifyNonTsChanges,
  deriveDataReadRelations,
  deriveReadRelationReport,
  discoverFullGateTestFiles,
  FAST_GATE_EXCLUSIONS,
  inertContradictions,
  isFastGateSelectable,
  isTestModule,
  NEVER_WALKED,
  proveDiscoveryMatchesDeno,
  resolverConfigInputs,
  ROOT,
  suitesObserving,
  universeDrift,
} from "../scripts/test-selection.ts";

const NO_NAMED = new Map<string, string[]>();
const NO_GRAPH = new Map<string, string[]>();

// ---------------------------------------------------------------------------
// Deno's discovery rule, as a predicate
// ---------------------------------------------------------------------------

Deno.test("isTestModule pins Deno's basename rule ({*_,*.,}test.<ext>)", () => {
  for (
    const yes of [
      "tests/a_test.ts",
      "tests/b.test.ts",
      "tests/c_test.mts",
      "tests/d_test.js",
      "tests/sub/deep_test.ts",
      "tests/sub/deep.test.ts",
      "test.ts",
      "tests/thing_test.tsx",
    ]
  ) {
    assert(isTestModule(yes), `${yes} is a test module Deno discovers`);
  }
  for (
    const no of [
      "tests/helper_in_tests.ts",
      "tests/fixtures.ts",
      "src/server.ts",
      "tests/foo-test.ts", // the name-matching convention, NOT a Deno discovery pattern
      "docs/evidence/att-paging/measure.ts",
      "tests/foo_test.ts.bak",
    ]
  ) {
    assert(!isTestModule(no), `${no} is not a module Deno's runner picks up`);
  }
});

Deno.test("discovery follows Deno's basename rule and skips the unwalked trees", async () => {
  const dir = await Deno.makeTempDir({ prefix: "af-subset-" });
  try {
    const files: Record<string, string> = {
      "a_test.ts": "",
      "b.test.ts": "",
      "c_test.mts": "",
      "d_test.js": "",
      "helper.ts": "",
      "test.ts": "",
      "tests/t_test.ts": "",
      "tests/helper_in_tests.ts": "",
      "tests/sub/deep_test.ts": "",
      "tests/sub/deep.test.ts": "",
      "node_modules/dep/x_test.ts": "",
      ".beads/export_test.ts": "",
      "var/scratch_test.ts": "",
      "docs/evidence/measure.ts": "",
    };
    for (const [path, body] of Object.entries(files)) {
      const full = `${dir}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, body);
    }

    const discovered = await discoverFullGateTestFiles(`${dir}/`);
    assertEquals(discovered, [
      "a_test.ts",
      "b.test.ts",
      "c_test.mts",
      "d_test.js",
      "test.ts",
      "tests/sub/deep.test.ts",
      "tests/sub/deep_test.ts",
      "tests/t_test.ts",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the walk skips every directory deno.json excludes (audio-feed-es8y)", async () => {
  // A configured exclude the walk does not know about would add modules to the universe
  // that the full gate never runs - property 1 would be violated by configuration drift.
  const raw = await Deno.readTextFile(`${ROOT}deno.json`);
  const json = JSON.parse(
    raw.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"),
  ) as { exclude?: string[] };
  for (const entry of json.exclude ?? []) {
    const name = entry.replace(/\/$/, "");
    assert(
      NEVER_WALKED.includes(name),
      `deno.json excludes ${entry} but NEVER_WALKED does not: ${NEVER_WALKED.join(", ")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Property 1: nothing the fast gate can select sits outside the full gate's universe
// ---------------------------------------------------------------------------

Deno.test("the fast gate's universe is a subset of the full gate's, measured on this repo", async () => {
  const full = await discoverFullGateTestFiles(ROOT);
  const fast = await allTestFiles();

  assert(full.length > 0, "the full gate runs something");
  assert(fast.length > 0, "the fast gate can select something");
  const fullSet = new Set(full);
  const outside = fast.filter((f) => !fullSet.has(f));
  assertEquals(
    outside,
    [],
    `the fast gate selects modules the full gate never runs: ${outside.join(", ")}`,
  );
  // The derivation is a filter, so this is structural; asserted anyway because the
  // structural claim is the whole point of the module.
  assertEquals(fast, full.filter(isFastGateSelectable));
});

Deno.test("a reachable test module outside the selectable universe is a full-suite fallback", () => {
  // tests/foo-test.ts is the NAME-MATCHING convention, not a Deno discovery pattern: the full gate
  // never runs it, so selecting it for a change would make the fast gate run something "more" than
  // the full gate - the mirror image of the gap this bead is about.
  const plan = planTests(
    ["src/routes/widgets.ts"],
    new Map([["src/routes/widgets.ts", ["tests/foo-test.ts"]]]),
    new Map([["src/routes/widgets.ts", ["tests/foo-test.ts"]]]),
  );
  assertEquals(plan.testFiles, null, plan.reason);
  assert(/outside the fast gate/.test(plan.reason), plan.reason);
});

// ---------------------------------------------------------------------------
// Property 2: an account of every full-gate module, and a NAMED failure when one is missing
// ---------------------------------------------------------------------------

Deno.test("every module the full gate runs is selectable or justified (this repo)", async () => {
  const full = await discoverFullGateTestFiles(ROOT);
  const audit = auditSelection(full);
  assertEquals(audit.unaccounted, []);
  assertEquals(audit.badExclusions, []);
  assertEquals(audit.ok, true, audit.message);
  assertEquals(audit.message, "");
  assertEquals(audit.fastGateUniverse.length, (await allTestFiles()).length);
  assertEquals(FAST_GATE_EXCLUSIONS, [], "the exclusion list is empty: nothing needs one today");
});

Deno.test("a `.test.ts` module the fast gate cannot select is a NAMED failure, not a silent gap", () => {
  const audit = auditSelection([
    "tests/origin_test.ts",
    "tests/future.test.ts",
    "src/inline_test.mts",
  ]);

  assertEquals(audit.ok, false);
  assertEquals(audit.unaccounted, ["tests/future.test.ts", "src/inline_test.mts"]);
  assert(audit.message.includes("SELECTION GAP"), audit.message);
  assert(audit.message.includes("tests/future.test.ts"), audit.message);
  assert(audit.message.includes("src/inline_test.mts"), audit.message);
  // The FILE-LEVEL fix comes first, because that is usually the whole fix: a lane under time pressure
  // should rename a module rather than edit the gate's own predicate.
  assert(audit.message.includes("tests/*_test.ts"), audit.message);
  assert(
    audit.message.indexOf("tests/*_test.ts") < audit.message.indexOf("isFastGateSelectable"),
    "the file-level fix must be named before the gate-level one",
  );
  assert(audit.message.includes("isFastGateSelectable"), audit.message);
  assert(audit.message.includes("FAST_GATE_EXCLUSIONS"), audit.message);
});

Deno.test("the audit cannot be defeated by the builder drifting from the run (es8y condition 1/2)", () => {
  // The audit and the run consume ONE walk; this is the check that keeps the exported builder honest.
  assertEquals(universeDrift(["tests/a_test.ts"], ["tests/a_test.ts"]), null);
  assertEquals(universeDrift(["tests/a_test.ts", "tests/a_test.ts"], ["tests/a_test.ts"]), null);

  const narrower = universeDrift(["tests/a_test.ts", "tests/b_test.ts"], ["tests/a_test.ts"]);
  assert(narrower !== null, "a builder that lost a module must be a named failure");
  assert(narrower.includes("SELECTION DRIFT"), narrower);
  assert(narrower.includes("only in the run's universe: 1: tests/b_test.ts"), narrower);

  const wider = universeDrift(["tests/a_test.ts"], ["tests/a_test.ts", "tests/c_test.ts"]);
  assert(wider !== null, "a builder that gained a module must be a named failure too");
  assert(wider.includes("only in allTestFiles(): 1: tests/c_test.ts"), wider);
});

Deno.test("an exclusion justifies itself or it is reported (a reason, and a module that exists)", () => {
  const full = ["tests/a_test.ts", "tests/b.test.ts"];

  const missingReason = auditSelection(full, [{ path: "tests/b.test.ts", reason: "   " }]);
  assertEquals(missingReason.ok, false);
  assertEquals(missingReason.badExclusions, ["tests/b.test.ts (no reason given)"]);

  const notAFullGateModule = auditSelection(full, [{
    path: "tests/nope.test.ts",
    reason: "run nightly",
  }]);
  assertEquals(notAFullGateModule.ok, false);
  assertEquals(notAFullGateModule.badExclusions, [
    "tests/nope.test.ts (the full gate does not run this module)",
  ]);

  const justified = auditSelection(full, [{
    path: "tests/b.test.ts",
    reason: "factory line runs it",
  }]);
  assertEquals(justified.ok, true, justified.message);
  assertEquals(justified.unaccounted, []);
});

// ---------------------------------------------------------------------------
// The data ledger: non-TypeScript changes that a suite can see
// ---------------------------------------------------------------------------

// The DERIVED read relation: non-TypeScript changes a suite can see
// ---------------------------------------------------------------------------

// Derived once from this repo, exactly as the gate derives it.
/**
 * THE SELECTION ASSERTED AS A PROPERTY, NOT AS A PROSE-DERIVED LIST (audio-feed-vex8).
 *
 * These four assertions used to pin the EXACT observer list for `docs/evidence/`, and that list
 * includes tests/evidence_census_test.ts - an over-selection their own comments already describe as
 * "the safe direction, a changed evidence PNG runs a 40ms census test" (and once character-level
 * scanning accurately un-swallows scripts/evidence-run.ts, tests/evidence_run_test.ts and
 * tests/evidence_selection_test.ts similarly observe docs/evidence/). MEASURED while fixing a
 * comma bug: rewriting CODE in scripts/evidence-census.ts that adds no read call at all FLIPPED that
 * membership (hunk 2 of that change alone flips it; the other two hunks alone do not), so the
 * membership is a function of unrelated script text rather than of what observes the directory.
 * A pinned exact list therefore goes red for reasons that have nothing to do with the property it
 * exists to protect - that a changed evidence file selects the suites which really assert on it.
 * So the genuine observers are REQUIRED, the declared over-selection is tolerated BY NAME, and
 * anything else is still a failure.
 */
function assertSelected(
  actual: readonly string[] | null | undefined,
  required: readonly string[],
  overSelection: readonly string[] = [
    "tests/evidence_census_test.ts",
    "tests/evidence_run_test.ts",
    "tests/evidence_selection_test.ts",
    // audio-feed-amho REMOVED A DECLARATION FROM THIS LIST, and the reason it is recorded here rather
    // than silently dropped is that its absence from the diff is otherwise indistinguishable from an
    // oversight. tests/chrome_profile_sweep_sites_test.ts used to be tolerated as an over-selector
    // because it imported maskNonCode()/firstArgument() from scripts/evidence-census.ts - a pure string
    // utility living in a module that WALKS DIRECTORIES, so the relation closure (depth 2, recorded per
    // suite) lent the suite docs/evidence/ and scripts/ relations it never observes. Those helpers now
    // live in scripts/source-mask.ts, which reads nothing: the suite derives NO relation, and it is
    // therefore selected only for what it really reads. The declaration is gone because the CAUSE is
    // gone, not because the assertion was loosened - `required` is unchanged and `unexpected` still
    // fails - so if this suite ever needs a declaration here again, that means a module it imports has
    // started lending it directory relations and the reason should be re-derived rather than assumed.
  ],
): void {
  assert(
    actual !== null && actual !== undefined,
    "a selection was expected, got the full-suite fallback",
  );
  for (const file of required) {
    assert(actual.includes(file), `${file} must be selected, got ${JSON.stringify(actual)}`);
  }
  const unexpected = actual.filter((file) =>
    !required.includes(file) && !overSelection.includes(file)
  );
  assertEquals(unexpected, [], `unexpected selection member(s): ${JSON.stringify(unexpected)}`);
}
