/**
 * Tests for proof-helper port and profile hygiene (audio-feed-9se).
 *
 * Verifies:
 * - Temporary Chrome profiles are uniquely allocated via mkdtemp and removed by cleanup()
 * - Harness processes bind ephemeral port 0 and report assigned port
 * - Output (stdout and stderr) is retained rather than discarded
 * - Premature harness exit before /health is detected and fails fast
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  assertVisibleExpression,
  CheckFailureError,
  ChromeHandle,
  createChecker,
  createTempChromeProfile,
  type ElementMeasurement,
  formatEvidenceReadme,
  getActiveProof,
  isFullyVisible,
  isVisible,
  killChromeAndWait,
  launchChrome,
  newestChrome,
  originalCopyFile,
  originalCopyFileSync,
  originalOpen,
  originalWriteFile,
  proofPathLocks,
  removeDirWhenQuiet,
  resolveChromeBinary,
  runProof,
  setOriginalCopyFileForTesting,
  setOriginalCopyFileSyncForTesting,
  spawnHarness,
  startInProcessServer,
  waitForChromeProfileUnused,
  withChrome,
  writeEvidenceReadme,
} from "../scripts/proof-helper.ts";
import { HARNESS_PORT_DEFAULT, resolveHarnessPort } from "../scripts/harness-port.ts";
import { GENERATED_BEGIN, GENERATED_END } from "../scripts/evidence-readme.ts";

Deno.test("proof-helper: newestChrome resolves Chrome binary path or throws descriptive error", () => {
  try {
    const chrome = newestChrome();
    assertStringIncludes(chrome, "chrome-linux64/chrome");
  } catch (err) {
    assertStringIncludes((err as Error).message, "No Chrome binaries found under");
  }
});

Deno.test("proof-helper: newestChrome throws descriptive error for absent cache directory", () => {
  const absentDir = "/nonexistent-audiofeed-puppeteer-chrome";
  assertThrows(
    () => newestChrome(absentDir),
    Error,
    `No Chrome binaries found under ${absentDir}`,
  );
});

Deno.test({
  name:
    "proof-helper: newestChrome handles controlled absent/empty cache fixtures and resolves newest version",
  ignore: (await Deno.permissions.query({ name: "write" })).state !== "granted",
  async fn() {
    const tempDir = await Deno.makeTempDir({ prefix: "audiofeed-chrome-test-" });
    try {
      const absentDir = `${tempDir}/absent-puppeteer-chrome`;
      const emptyDir = `${tempDir}/empty-puppeteer-chrome`;
      await Deno.mkdir(emptyDir);

      assertThrows(
        () => newestChrome(absentDir),
        Error,
        `No Chrome binaries found under ${absentDir}`,
      );

      assertThrows(
        () => newestChrome(emptyDir),
        Error,
        `No Chrome binaries found under ${emptyDir}`,
      );

      const v1 = `${tempDir}/mock-cache/120.0.0`;
      const v2 = `${tempDir}/mock-cache/121.0.0`;
      await Deno.mkdir(v1, { recursive: true });
      await Deno.mkdir(v2, { recursive: true });
      assertEquals(
        newestChrome(`${tempDir}/mock-cache`),
        `${tempDir}/mock-cache/121.0.0/chrome-linux64/chrome`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
  },
});

/**
 * audio-feed-9ot4 / audio-feed-oyf3g: run `body` against a scratch root that the code under test is HANDED.
 *
 * WHY EVERY ROW THAT ALLOCATES A PROFILE USES THIS: `createTempChromeProfile` reclaims abandoned profiles under
 * the root it is given BEFORE it allocates, so a row that calls it with the machine's real temp dir makes a unit
 * test mutate shared machine state. That was always true of the row's own prefix; since the sweep became
 * age-and-signature based rather than prefix-scoped (audio-feed-h62q) it is true of EVERY abandoned profile on the
 * VM. MEASURED: a single run of the allocating rows reclaimed 82 directories from the real /tmp, none of which
 * belonged to any test here. The root argument keeps that protection without the coupling the old redirect had:
 * under `deno test --parallel` Deno runs test modules CONCURRENTLY IN ONE PROCESS, so a process-global TMPDIR
 * captured other modules' temp dirs into this sandbox and deleted them with it.
 *
 * The sandbox is VERIFIED, not assumed: each row asserts that the profile it was handed lives under the scratch
 * root, which is the same guarantee the old "assert the redirect took" line was making about the old mechanism.
 * Removal of the scratch tree is best-effort because the row that locks a subdirectory to exercise the failure
 * path cannot always unlock it again; a leftover SCRATCH directory holds no `Default/`, so the profile sweep
 * ignores it, and the sweep is now scoped to this root anyway.
 */
async function withScratchRoot<T>(body: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = await Deno.makeTempDir({ prefix: "9ot4-scratch-" });
  try {
    return await body(scratch);
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
}

Deno.test("proof-helper: createTempChromeProfile creates and cleanly removes temp dir", async () => {
  await withScratchRoot(async (scratch) => {
    const { profileDir, cleanup } = await createTempChromeProfile(
      "audiofeed-test-profile-",
      scratch,
    );
    assert(profileDir.startsWith(scratch), "the profile must live under the row's scratch root");
    const stat = await Deno.stat(profileDir);
    assertEquals(stat.isDirectory, true);

    await cleanup();
    await assertRejects(
      async () => await Deno.stat(profileDir),
      Deno.errors.NotFound,
    );
  });
});

Deno.test({
  name: "harness-port: an explicit value always beats the pinned default (audio-feed-mkn3)",
  fn() {
    // spawnHarness passes "0", so this is the contract that kept breaking.
    assertEquals(resolveHarnessPort(["0"], undefined), 0, '"0" must bind an ephemeral port');
    assertEquals(
      resolveHarnessPort([], undefined),
      HARNESS_PORT_DEFAULT,
      "no input must use the pin, or evidence stops being reproducible",
    );
    assertEquals(
      resolveHarnessPort(["1234"], undefined),
      1234,
      "an explicit port must be honoured",
    );
    assertEquals(resolveHarnessPort([], "ephemeral"), 0, "the env spelling must bind ephemeral");
    assertEquals(resolveHarnessPort([], "0"), 0, "the env zero must bind ephemeral");
    assertEquals(
      resolveHarnessPort(["0"], "4321"),
      4321,
      "a numeric env must outrank the argument",
    );
    // The regression this bead was about: 0 must NOT fall through to the pin.
    assertNotEquals(
      resolveHarnessPort(["0"], undefined),
      HARNESS_PORT_DEFAULT,
      "an explicit 0 must never resolve to the pinned default",
    );
  },
});

Deno.test({
  name: "proof-helper: spawnHarness binds ephemeral port 0 and answers health check",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const harness = await spawnHarness("scripts/account-harness.ts");
    try {
      // spawnHarness ALWAYS passes "0", so this must be an EPHEMERAL bind.
      // `port > 0` alone was satisfied by the pinned default too, so a green row
      // named a contract it did not check (audio-feed-bm58).
      assertEquals(harness.port > 0, true, `assigned port ${harness.port} must be > 0`);
      assertNotEquals(
        harness.port,
        HARNESS_PORT_DEFAULT,
        `spawnHarness passes "0", so the bind must be ephemeral, not the pinned default ${HARNESS_PORT_DEFAULT}`,
      );
      const health = await fetch(`${harness.base}/health`);
      assertEquals(health.ok, true);

      const logs = harness.getLogs();
      assertStringIncludes(logs.stdout, `READY port=${harness.port}`);
    } finally {
      // audio-feed-ft1sj: kill AND await, so the harness child is reaped before the test continues.
      await killChromeAndWait(harness.process);
    }
  },
});

Deno.test({
  name:
    "proof-helper: killChromeAndWait reaps the child, and nothing still references the profile afterwards (audio-feed-ft1sj)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  fn: async () => {
    const chrome = await launchChrome();
    const { profileDir, process } = chrome;
    // A profile under the prefix we just created: this asserts about THIS run's directory, never about other
    // scratch directories on the machine (audio-feed-wj8o2 left ~708 pre-existing ones, and a teardown fix stops
    // the leak going forward without emptying them).
    assertStringIncludes(profileDir, "audiofeed-chrome-");
    try {
      // The mechanism under test. If this is not awaited (or not called), the browser is still alive below.
      await killChromeAndWait(process);
      // BOTH acceptance assertions, and the second is the one that reddens by NAME when the reap is missing: a
      // live Chrome carries --user-data-dir=<profileDir> on its own command line.
      assertEquals(
        await waitForChromeProfileUnused(profileDir),
        true,
        `no process may still carry --user-data-dir=${profileDir} after a reaped kill`,
      );
      assertEquals(
        await removeDirWhenQuiet(profileDir),
        true,
        `the profile directory ${profileDir} must be gone after a reaped kill`,
      );
    } finally {
      await killChromeAndWait(process);
      await removeDirWhenQuiet(profileDir);
    }
  },
});

Deno.test({
  name: "proof-helper: spawnHarness fails fast if child process exits prematurely",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    // Test with non-existent or failing script argument
    await assertRejects(
      async () => {
        await spawnHarness("scripts/non-existent-script.ts", [], { timeoutMs: 3000 });
      },
      Error,
      "exited prematurely",
    );
  },
});

Deno.test("proof-helper: createTempChromeProfile cleanup is idempotent and safe to call twice", async () => {
  await withScratchRoot(async (scratch) => {
    const { profileDir, cleanup } = await createTempChromeProfile(
      "audiofeed-test-idempotent-",
      scratch,
    );
    assert(profileDir.startsWith(scratch), "the profile must live under the row's scratch root");
    await cleanup();
    await cleanup(); // second call must not throw
    await assertRejects(
      async () => await Deno.stat(profileDir),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("proof-helper: createTempChromeProfile throws descriptive error if profile directory cannot be removed", async () => {
  await withScratchRoot(async (scratch) => {
    const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-test-fail-", scratch);
    assert(profileDir.startsWith(scratch), "the profile must live under the row's scratch root");
    const sub = `${profileDir}/locked-sub`;
    await Deno.mkdir(sub);
    await Deno.writeTextFile(`${sub}/file.txt`, "lock");
    await Deno.chmod(sub, 0o555);

    try {
      await assertRejects(
        async () => await cleanup(),
        Error,
        `Failed to clean up temp Chrome profile '${profileDir}'`,
      );
    } finally {
      await Deno.chmod(sub, 0o755);
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("proof-helper: createChecker passes when all checks pass and finish() does not throw", () => {
  const checker = createChecker();
  checker.check("first check", true, "detail 1");
  checker.check("second check", true);
  assertEquals(checker.failures.length, 0);
  checker.finish();
});

Deno.test("proof-helper: createChecker throws CheckFailureError immediately on false check", () => {
  const checker = createChecker();
  checker.check("passing check", true);
  const thrown = assertThrows(
    () => checker.check("failing check alpha", false, "reason A"),
    CheckFailureError,
    "Check failed: failing check alpha (reason A)",
  );
  assertEquals(thrown.checkName, "failing check alpha");
  assertEquals(thrown.detail, "reason A");
  assertEquals(checker.failures.length, 1);
  assertEquals(checker.failures[0]?.name, "failing check alpha");
  assertEquals(checker.failures[0]?.detail, "reason A");

  const finishErr = assertThrows(
    () => checker.finish(),
    Error,
    "Checker failed 1 check(s)",
  );
  assertStringIncludes(finishErr.message, "failing check alpha (reason A)");
});

Deno.test("proof-helper: createChecker implements [Symbol.dispose] calling finish on scope exit", () => {
  {
    using checker = createChecker();
    checker.check("passing scoped check", true);
  }

  assertThrows(
    () => {
      using checker = createChecker();
      try {
        checker.check("caught fail", false, "detail");
      } catch {
        // swallowed CheckFailureError
      }
    },
    Error,
    "Checker failed 1 check(s): caught fail (detail)",
  );
});

Deno.test("proof-helper: runProof collects all failures in deferred mode and throws in finish", async () => {
  await assertRejects(
    async () => {
      await runProof("deferred-test", (checker) => {
        checker.check("passing check", true);
        checker.check("failing check alpha", false, "reason A");
        checker.check("failing check beta", false, "reason B");
      });
    },
    Error,
    "Checker failed 2 check(s): failing check alpha (reason A); failing check beta (reason B)",
  );
});

Deno.test("proof-helper: createChecker accepts custom logger without writing to console.log", () => {
  const loggedLines: string[] = [];
  const origLog = console.log;
  let consoleLogCalled = false;
  console.log = (..._args: unknown[]) => {
    consoleLogCalled = true;
  };
  try {
    const checker = createChecker((line) => loggedLines.push(line));
    checker.check("first check", true, "detail 1");
    checker.check("second check", true);
    assertEquals(consoleLogCalled, false);
    assertEquals(loggedLines, [
      "PASS  first check  detail 1",
      "PASS  second check",
    ]);
    checker.finish();
  } finally {
    console.log = origLog;
  }
});

Deno.test("proof-helper: runProof accepts custom logger in options object and routes output", async () => {
  const loggedLines: string[] = [];
  const origLog = console.log;
  let consoleLogCalled = false;
  console.log = (..._args: unknown[]) => {
    consoleLogCalled = true;
  };
  try {
    await runProof(
      "custom-logger-test",
      (checker) => {
        checker.check("pass step", true, "ok detail");
        checker.check("pass step no detail", true);
      },
      { logger: (line) => loggedLines.push(line) },
    );
    assertEquals(consoleLogCalled, false);
    assertEquals(loggedLines, [
      "PASS  pass step  ok detail",
      "PASS  pass step no detail",
    ]);
  } finally {
    console.log = origLog;
  }
});

Deno.test("proof-helper: subprocess: fixture recording failing check without finish exits non-zero", async () => {
  const fixture = new URL("./fixtures/checker_fail_return_child.ts", import.meta.url).pathname;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--unstable-kv", fixture],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  assertEquals(output.success, false);
  assertEquals(output.code !== 0, true);
});

Deno.test("proof-helper: subprocess: fixture through runProof exits non-zero and stderr names failure", async () => {
  const fixture = new URL("./fixtures/checker_run_proof_child.ts", import.meta.url).pathname;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--unstable-kv", fixture],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  assertEquals(output.success, false);
  assertEquals(output.code !== 0, true);
  const stderrText = new TextDecoder().decode(output.stderr);
  assertStringIncludes(stderrText, "failing check alpha");
  assertStringIncludes(stderrText, "reason A");
});

Deno.test("proof-helper: subprocess: all-pass fixture exits zero", async () => {
  const fixture = new URL("./fixtures/checker_pass_child.ts", import.meta.url).pathname;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--unstable-kv", fixture],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  assertEquals(output.success, true);
  assertEquals(output.code, 0);
});

Deno.test("proof-helper: assertVisibleExpression produces evaluable JS expression", () => {
  const expr = assertVisibleExpression("#target");
  assertStringIncludes(expr, '"#target"');
  const syntheticEval = new Function("document", "window", `return ${expr};`);

  const mockWin = { innerWidth: 1024, innerHeight: 768 };
  const mockDoc = {
    querySelector: (sel: string) => {
      if (sel === "#target") {
        return {
          scrollWidth: 100,
          clientWidth: 100,
          offsetHeight: 30,
          getBoundingClientRect: () => ({
            width: 100,
            height: 30,
            top: 20,
            left: 20,
            bottom: 50,
            right: 120,
          }),
        };
      }
      return null;
    },
  };

  const found = syntheticEval(mockDoc, mockWin);
  assertEquals(found.found, true);
  assertEquals(found.scrollWidth, 100);
  assertEquals(found.clientWidth, 100);
  assertEquals(found.offsetHeight, 30);
  assertEquals(found.rectWidth, 100);
  assertEquals(found.rectHeight, 30);
  assertEquals(found.rectTop, 20);
  assertEquals(found.rectBottom, 50);
  assertEquals(found.viewportHeight, 768);
  assertEquals(found.inViewport, true);

  const notFound = syntheticEval({ querySelector: () => null }, mockWin);
  assertEquals(notFound.found, false);
  assertEquals(notFound.inViewport, false);
  assertEquals(notFound.rectTop, 0);
  assertEquals(notFound.rectBottom, 0);
  assertEquals(notFound.viewportHeight, 0);
});

Deno.test("proof-helper: isVisible validates element visibility, box size, clipping, and viewport presence", () => {
  // Well-formed measurement is visible
  const ok = isVisible({
    found: true,
    scrollWidth: 150,
    clientWidth: 150,
    offsetHeight: 30,
    rectWidth: 150,
    rectHeight: 30,
    inViewport: true,
  });
  assertEquals(ok.visible, true);

  // Allow scrollWidth <= clientWidth + 1
  const tolerance = isVisible({
    found: true,
    scrollWidth: 151,
    clientWidth: 150,
    offsetHeight: 30,
    rectWidth: 150,
    rectHeight: 30,
    inViewport: true,
  });
  assertEquals(tolerance.visible, true);

  // Clipped one is NOT visible, with reason naming clipping
  const clipped = isVisible({
    found: true,
    scrollWidth: 200,
    clientWidth: 150,
    offsetHeight: 30,
    rectWidth: 150,
    rectHeight: 30,
    inViewport: true,
  });
  assertEquals(clipped.visible, false);
  assertStringIncludes(clipped.reason.toLowerCase(), "clipped");

  // Not-found measurement is not visible
  const notFound = isVisible({
    found: false,
    scrollWidth: 0,
    clientWidth: 0,
    offsetHeight: 0,
    rectWidth: 0,
    rectHeight: 0,
    inViewport: false,
  });
  assertEquals(notFound.visible, false);
  assertStringIncludes(notFound.reason.toLowerCase(), "not found");

  // Zero-box measurement is not visible
  const zeroBox = isVisible({
    found: true,
    scrollWidth: 0,
    clientWidth: 0,
    offsetHeight: 0,
    rectWidth: 0,
    rectHeight: 0,
    inViewport: true,
  });
  assertEquals(zeroBox.visible, false);
  assertStringIncludes(zeroBox.reason.toLowerCase(), "zero");

  // Outside viewport measurement is not visible
  const outsideViewport = isVisible({
    found: true,
    scrollWidth: 100,
    clientWidth: 100,
    offsetHeight: 30,
    rectWidth: 100,
    rectHeight: 30,
    inViewport: false,
  });
  assertEquals(outsideViewport.visible, false);
  assertStringIncludes(outsideViewport.reason.toLowerCase(), "viewport");
});

Deno.test("proof-helper: isFullyVisible distinguishes strict vertical containment from partial intersection", () => {
  // Reviewer's exact synthetic reproduction (audio-feed-ar6u):
  // A 1231x100 card with rect top=-99, bottom=1 in a 1280x900 viewport.
  // isVisible is true (partial intersection), but isFullyVisible is false.
  const reproMeasurement: ElementMeasurement = {
    found: true,
    scrollWidth: 1231,
    clientWidth: 1231,
    offsetHeight: 100,
    rectWidth: 1231,
    rectHeight: 100,
    rectTop: -99,
    rectBottom: 1,
    viewportHeight: 900,
    inViewport: true,
  };
  assertEquals(isVisible(reproMeasurement).visible, true);
  assertEquals(isFullyVisible(reproMeasurement).visible, false);
  assertStringIncludes(
    isFullyVisible(reproMeasurement).reason.toLowerCase(),
    "not fully in viewport",
  );

  // Boundary case 1: fully-inside box (both true)
  const fullyInside: ElementMeasurement = {
    found: true,
    scrollWidth: 1231,
    clientWidth: 1231,
    offsetHeight: 100,
    rectWidth: 1231,
    rectHeight: 100,
    rectTop: 100,
    rectBottom: 200,
    viewportHeight: 900,
    inViewport: true,
  };
  assertEquals(isVisible(fullyInside).visible, true);
  assertEquals(isFullyVisible(fullyInside).visible, true);

  // Boundary case 2: box that is 99% below bottom edge (top=850, bottom=950 in 900: partial true, full false)
  const belowBottom: ElementMeasurement = {
    found: true,
    scrollWidth: 1231,
    clientWidth: 1231,
    offsetHeight: 100,
    rectWidth: 1231,
    rectHeight: 100,
    rectTop: 850,
    rectBottom: 950,
    viewportHeight: 900,
    inViewport: true,
  };
  assertEquals(isVisible(belowBottom).visible, true);
  assertEquals(isFullyVisible(belowBottom).visible, false);
  assertStringIncludes(isFullyVisible(belowBottom).reason.toLowerCase(), "not fully in viewport");

  // Boundary exact edges: top=0, bottom=900 (both true)
  const exactEdges: ElementMeasurement = {
    found: true,
    scrollWidth: 1231,
    clientWidth: 1231,
    offsetHeight: 900,
    rectWidth: 1231,
    rectHeight: 900,
    rectTop: 0,
    rectBottom: 900,
    viewportHeight: 900,
    inViewport: true,
  };
  assertEquals(isVisible(exactEdges).visible, true);
  assertEquals(isFullyVisible(exactEdges).visible, true);

  // Common guards inherited from isVisible:
  // 1. Not found
  assertEquals(
    isFullyVisible({
      found: false,
      scrollWidth: 0,
      clientWidth: 0,
      offsetHeight: 0,
      rectWidth: 0,
      rectHeight: 0,
      inViewport: false,
      rectTop: 0,
      rectBottom: 0,
      viewportHeight: 900,
    }).visible,
    false,
  );
  // 2. Zero box
  assertEquals(
    isFullyVisible({
      found: true,
      scrollWidth: 0,
      clientWidth: 0,
      offsetHeight: 0,
      rectWidth: 0,
      rectHeight: 0,
      inViewport: true,
      rectTop: 0,
      rectBottom: 0,
      viewportHeight: 900,
    }).visible,
    false,
  );
  // 3. Clipped
  assertEquals(
    isFullyVisible({
      found: true,
      scrollWidth: 200,
      clientWidth: 100,
      offsetHeight: 30,
      rectWidth: 100,
      rectHeight: 30,
      inViewport: true,
      rectTop: 10,
      rectBottom: 40,
      viewportHeight: 900,
    }).visible,
    false,
  );
  // 4. Outside viewport
  assertEquals(
    isFullyVisible({
      found: true,
      scrollWidth: 100,
      clientWidth: 100,
      offsetHeight: 30,
      rectWidth: 100,
      rectHeight: 30,
      inViewport: false,
      rectTop: 1000,
      rectBottom: 1030,
      viewportHeight: 900,
    }).visible,
    false,
  );
});

Deno.test("proof-helper: passkey provider browser proof desktop claim uses isFullyVisible", async () => {
  const content = await Deno.readTextFile(
    new URL("../scripts/passkey-provider-browser-proof.ts", import.meta.url),
  );
  assertMatch(
    content,
    /isFullyVisible\(desktopMeasurement\)/,
    "desktop measurement must use isFullyVisible (strict containment) not isVisible (partial intersection)",
  );
  assertMatch(
    content,
    /isVisible\(mobileMeasurement\)/,
    "mobile measurement preserves isVisible (partial intersection)",
  );
});

Deno.test("proof-helper: writeEvidenceReadme throws when called outside runProof without allowOutsideProof", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-unbound-" });
  try {
    const err = await assertRejects(
      () =>
        writeEvidenceReadme({
          dir,
          title: "Browser Proof: Untransactioned Readme",
          script: "scripts/unbound-proof.ts",
          asserts: ["some assertion"],
        }),
      Error,
      "writeEvidenceReadme() called outside of runProof() context",
    );
    assertStringIncludes(err.message, "Evidence must be written inside await runProof");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme generates valid README passing evidence declaration regexes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-test-" });
  try {
    const readmePath = await writeEvidenceReadme({
      dir,
      title: "Browser Proof: Audio Feed Verification (audio-feed-test)",
      script: "scripts/test-browser-proof.ts",
      asserts: ["audio route serves audio/wav", "web player renders playback bar"],
      allowOutsideProof: true,
      sections: [
        {
          heading: "Verified Features",
          body: "Verified that playback bar renders and direct audio responds with 200 OK.",
        },
      ],
    });
    assertEquals(readmePath, `${dir}/README.md`);

    const content = await Deno.readTextFile(readmePath);
    assertStringIncludes(content, "# Browser Proof: Audio Feed Verification (audio-feed-test)");
    assertStringIncludes(content, "- Script: scripts/test-browser-proof.ts");
    assertStringIncludes(
      content,
      "- Asserts: audio route serves audio/wav; web player renders playback bar",
    );
    assertStringIncludes(
      content,
      "## Verified Features\n\nVerified that playback bar renders and direct audio responds with 200 OK.",
    );

    // Matches regexes enforced by tests/evidence_size_test.ts
    const assertsMatch = content.match(/^- Asserts:\s*(.+)$/m);
    assertEquals(
      assertsMatch?.[1]?.trim(),
      "audio route serves audio/wav; web player renders playback bar",
    );
    const scriptMatch = content.match(/^- Script:\s*(\S+)/m);
    assertEquals(scriptMatch?.[1], "scripts/test-browser-proof.ts");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme renders Executed by field when provided (audio-feed-4oe2)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-exec-" });
  try {
    const readmePath = await writeEvidenceReadme({
      dir,
      title: "Browser Proof: Audio Feed Verification (audio-feed-test)",
      script: "scripts/test-browser-proof.ts",
      executedBy: "tests/my_suite_test.ts",
      asserts: ["audio route serves audio/wav"],
      allowOutsideProof: true,
    });
    const content = await Deno.readTextFile(readmePath);
    assertStringIncludes(content, "- Script: scripts/test-browser-proof.ts");
    assertStringIncludes(content, "- Executed by: tests/my_suite_test.ts");
    assertStringIncludes(content, "- Asserts: audio route serves audio/wav");

    // Negative check: executedBy without script throws
    await assertRejects(
      () =>
        writeEvidenceReadme({
          dir,
          title: "Invalid Readme",
          executedBy: "tests/my_suite_test.ts",
          capture: true,
          captureReason: "no assertions",
          allowOutsideProof: true,
        }),
      Error,
      "writeEvidenceReadme with executedBy requires a script",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme handles capture declarations and enforces reason", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-capture-" });
  try {
    const readmePath = await writeEvidenceReadme({
      dir,
      title: "Capture: Snapshot of Storage",
      script: "scripts/capture-storage.ts",
      capture: true,
      captureReason: "no assertions; state observation only",
      allowOutsideProof: true,
    });
    const content = await Deno.readTextFile(readmePath);
    assertStringIncludes(content, "- Script: scripts/capture-storage.ts");
    assertStringIncludes(content, "- Capture: no assertions");
    assertStringIncludes(content, "no assertions; state observation only");
    assertEquals(/^- Capture:\s*no assertions\s*$/m.test(content), true);

    // capture: true without a reason throws
    await assertRejects(
      async () => {
        await writeEvidenceReadme({
          dir,
          title: "Capture Without Reason",
          script: "scripts/capture-storage.ts",
          capture: true,
          allowOutsideProof: true,
        });
      },
      Error,
      "capture: true requires a mandatory one-line reason",
    );

    // empty asserts throws
    await assertRejects(
      async () => {
        await writeEvidenceReadme({
          dir,
          title: "Empty Asserts",
          script: "scripts/proof.ts",
          asserts: [],
          allowOutsideProof: true,
        });
      },
      Error,
      "non-empty asserts array",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme refuses ephemeral localhost URLs unless opt-out given", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-localhost-" });
  try {
    await assertRejects(
      async () => {
        await writeEvidenceReadme({
          dir,
          title: "Ephemeral Localhost Run",
          script: "scripts/proof.ts",
          asserts: ["page loaded"],
          sections: [
            { heading: "Target", body: "Tested against http://localhost:5173/overview" },
          ],
          allowOutsideProof: true,
        });
      },
      Error,
      "ephemeral localhost URL",
    );

    // allowLocalhost: true passes
    const path = await writeEvidenceReadme({
      dir,
      title: "Ephemeral Localhost Run Allowed",
      script: "scripts/proof.ts",
      asserts: ["page loaded"],
      sections: [
        { heading: "Target", body: "Tested against http://localhost:5173/overview" },
      ],
      allowLocalhost: true,
      allowOutsideProof: true,
    });
    const content = await Deno.readTextFile(path);
    assertStringIncludes(content, "http://localhost:5173/overview");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme refuses bare commit SHA tokens", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-sha-" });
  try {
    await assertRejects(
      async () => {
        await writeEvidenceReadme({
          dir,
          title: "Stale SHA Run",
          script: "scripts/proof.ts",
          asserts: ["page loaded"],
          sections: [
            { heading: "Environment", body: "Verified against commit a1b2c3d4e5f6 on origin/main" },
          ],
          allowOutsideProof: true,
        });
      },
      Error,
      "commit SHA",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: startInProcessServer binds ephemeral ports and shutdown is safe twice", async () => {
  const s1 = startInProcessServer(() => new Response("s1"));
  const s2 = startInProcessServer(() => new Response("s2"));

  try {
    assertEquals(s1.port > 0, true);
    assertEquals(s2.port > 0, true);
    assertEquals(s1.port !== s2.port, true, `ports ${s1.port} and ${s2.port} must differ`);
    assertEquals(s1.base.includes(String(s1.port)), true);
    assertEquals(s2.base.includes(String(s2.port)), true);

    const res1 = await fetch(`${s1.base}/`);
    assertEquals(await res1.text(), "s1");
    const res2 = await fetch(`${s2.base}/`);
    assertEquals(await res2.text(), "s2");
  } finally {
    await s1.shutdown();
    await s1.shutdown(); // second shutdown safe
    await s2.shutdown();
    await s2.shutdown(); // second shutdown safe
  }
});

const fakeChromeStub = new URL("./fixtures/fake_chrome.sh", import.meta.url).pathname;

Deno.test("proof-helper: launchChrome with stub exiting immediately rejects and removes profile", async () => {
  await assertRejects(
    async () => {
      await launchChrome({
        binary: fakeChromeStub,
        args: ["--mode=exit_immediately"],
        prefix: "audiofeed-stub-exit-",
      });
    },
    Error,
    "exited prematurely with code 0 before writing DevToolsActivePort",
  );

  const leftovers = [...Deno.readDirSync("/tmp")]
    .filter((e) => e.name.startsWith("audiofeed-stub-exit-"));
  assertEquals(leftovers.length, 0);
});

Deno.test("proof-helper: resolveChromeBinary supports explicit override and env var", () => {
  // The env is INJECTED rather than set process-globally (audio-feed-w5i0m): under
  // `deno test --parallel` a Deno.env.set here is visible to every concurrently running module for the
  // whole set/restore window. The assertion is unchanged - override beats the env var, the env var
  // beats discovery - and the default reader (`Deno.env`) is exercised by every launching test below.
  assertEquals(resolveChromeBinary("/custom/chrome"), "/custom/chrome");
  const env = {
    get: (key: string) => key === "AUDIOFEED_CHROME_BIN" ? "/env/chrome" : undefined,
  };
  assertEquals(resolveChromeBinary(undefined, env), "/env/chrome");
  assertEquals(resolveChromeBinary("/override/chrome", env), "/override/chrome");
  // An empty reader does not silently fall back to the process env: it reaches discovery, which fails on an
  // empty cache root rather than returning something plausible.
  assertThrows(
    () =>
      resolveChromeBinary(undefined, { get: () => undefined }, "/tmp/absent-audiofeed-chrome-root"),
    Error,
  );
});

Deno.test("proof-helper: withChrome with stub writing port succeeds, close is idempotent, profile removed", async () => {
  let capturedProfile = "";
  let handleRef: ChromeHandle | null = null;
  const result = await withChrome(
    async (chrome) => {
      capturedProfile = chrome.profileDir;
      handleRef = chrome;
      assertEquals(chrome.port, 9222);
      const existsDuringBody = await Deno.stat(capturedProfile).then(() => true, () => false);
      assertEquals(existsDuringBody, true);
      return "success-result";
    },
    {
      binary: fakeChromeStub,
      args: ["--mode=write_port_and_exit"],
      prefix: "audiofeed-stub-port-",
    },
  );

  assertEquals(result, "success-result");
  const existsAfter = await Deno.stat(capturedProfile).then(() => true, () => false);
  assertEquals(existsAfter, false);

  assertEquals(handleRef !== null, true);
  await handleRef!.close();
});

Deno.test("proof-helper: launchChrome with hanging stub rejects on bounded timeout and removes profile", async () => {
  await assertRejects(
    async () => {
      await launchChrome({
        binary: fakeChromeStub,
        args: ["--mode=hang"],
        portTimeoutMs: 150,
        prefix: "audiofeed-stub-hang-",
      });
    },
    Error,
    "Timed out after 150ms waiting for DevToolsActivePort",
  );

  const leftovers = [...Deno.readDirSync("/tmp")]
    .filter((e) => e.name.startsWith("audiofeed-stub-hang-"));
  assertEquals(leftovers.length, 0);
});

Deno.test("proof-helper: AUDIOFEED_CHROME_BIN env override redirects launch and cleans up on failure", async () => {
  // Injected env, not Deno.env.set (audio-feed-w5i0m): the launch reads the same field the process env
  // would have given it, and no other concurrently running module can see the value.
  await assertRejects(
    async () => {
      await withChrome(
        async () => {},
        {
          prefix: "audiofeed-stub-env-",
          env: { get: (key: string) => key === "AUDIOFEED_CHROME_BIN" ? "/bin/true" : undefined },
        },
      );
    },
    Error,
    "exited prematurely with code 0 before writing DevToolsActivePort",
  );

  const leftovers = [...Deno.readDirSync("/tmp")]
    .filter((e) => e.name.startsWith("audiofeed-stub-env-"));
  assertEquals(leftovers.length, 0);
});

Deno.test("proof-helper: contract interlock: failing check or body throw in withChrome surfaces failure after guaranteed profile cleanup", async () => {
  // Case 1: check() failure inside withChrome
  let profileDir1 = "";
  const checkErr = await assertRejects(
    async () => {
      const checker = createChecker();
      await withChrome(
        (chrome) => {
          profileDir1 = chrome.profileDir;
          checker.check("contract check", false, "deliberate fail");
        },
        {
          binary: fakeChromeStub,
          args: ["--mode=write_port_and_exit"],
          prefix: "audiofeed-contract-check-",
        },
      );
    },
    CheckFailureError,
    "Check failed: contract check (deliberate fail)",
  );
  assertEquals(checkErr.checkName, "contract check");
  assertEquals(checkErr.detail, "deliberate fail");

  const exists1 = await Deno.stat(profileDir1).then(() => true, () => false);
  assertEquals(exists1, false);

  // Case 2: arbitrary body throw inside withChrome
  let profileDir2 = "";
  await assertRejects(
    async () => {
      await withChrome(
        (chrome) => {
          profileDir2 = chrome.profileDir;
          throw new Error("body crashed during proof");
        },
        {
          binary: fakeChromeStub,
          args: ["--mode=write_port_and_exit"],
          prefix: "audiofeed-contract-throw-",
        },
      );
    },
    Error,
    "body crashed during proof",
  );

  const exists2 = await Deno.stat(profileDir2).then(() => true, () => false);
  assertEquals(exists2, false);
});

Deno.test("proof-helper: error precedence: body throw propagates with teardown failure attached as cause", async () => {
  let profileDir = "";
  let lockedSubdir = "";
  try {
    const err = await assertRejects(
      async () => {
        await withChrome(
          async (chrome) => {
            profileDir = chrome.profileDir;
            lockedSubdir = `${profileDir}/locked-dir`;
            await Deno.mkdir(lockedSubdir, { recursive: true });
            await Deno.chmod(lockedSubdir, 0o000);
            throw new Error("primary body failure");
          },
          {
            binary: fakeChromeStub,
            args: ["--mode=write_port_and_exit"],
            prefix: "audiofeed-err-prec-",
          },
        );
      },
      Error,
      "primary body failure",
    );

    assertEquals(err.message, "primary body failure");
    assertEquals(err.cause instanceof Error, true);
    assertStringIncludes(
      (err.cause as Error).message,
      "Failed to clean up temp Chrome profile",
    );
  } finally {
    if (lockedSubdir) {
      await Deno.chmod(lockedSubdir, 0o755).catch(() => {});
    }
    if (profileDir) {
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
    }
  }
});

Deno.test("proof-helper: launchChrome rejects without creating profile when Chrome binary discovery fails", async () => {
  const testPrefix = "audiofeed-disc-fail-inproc-";
  const fakeHome = "/tmp/nonexistent-audiofeed-inproc-home";
  try {
    // The cache root and the env are PASSED, not mutated (audio-feed-w5i0m): a global HOME change redirects
    // path resolution for anything spawning a child in a concurrently running module, and a global
    // AUDIOFEED_CHROME_BIN delete makes another module's launch fail for reasons it cannot see.
    const err = await assertRejects(
      async () => {
        await launchChrome({
          prefix: testPrefix,
          chromeCacheRoot: `${fakeHome}/.cache/puppeteer/chrome`,
          env: { get: () => undefined },
        });
      },
      Error,
      `No Chrome binaries found under ${fakeHome}/.cache/puppeteer/chrome`,
    );
    assertStringIncludes(err.message, "No Chrome binaries found under");

    const leftovers = [...Deno.readDirSync("/tmp")]
      .filter((e) => e.name.startsWith(testPrefix));
    assertEquals(
      leftovers.length,
      0,
      `Expected 0 leftovers for prefix ${testPrefix}, found: ${
        leftovers.map((e) => e.name).join(", ")
      }`,
    );
  } finally {
    for (const entry of Deno.readDirSync("/tmp")) {
      if (entry.name.startsWith(testPrefix)) {
        await Deno.remove(`/tmp/${entry.name}`, { recursive: true }).catch(() => {});
      }
    }
  }
});

Deno.test("proof-helper: subprocess: binary discovery failure exits non-zero and leaves no profile", async () => {
  const fixture = new URL("./fixtures/chrome_discovery_failure_child.ts", import.meta.url).pathname;
  const testPrefix = "audiofeed-disc-fail-subp-";
  const fakeHome = "/tmp/nonexistent-audiofeed-subp-home";
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--unstable-kv", fixture, testPrefix],
      env: {
        HOME: fakeHome,
        AUDIOFEED_CHROME_BIN: "",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    assertEquals(output.success, false);
    assertEquals(output.code !== 0, true);
    const stderrText = new TextDecoder().decode(output.stderr);
    assertStringIncludes(
      stderrText,
      `No Chrome binaries found under ${fakeHome}/.cache/puppeteer/chrome`,
    );

    const leftovers = [...Deno.readDirSync("/tmp")]
      .filter((e) => e.name.startsWith(testPrefix));
    assertEquals(
      leftovers.length,
      0,
      `Expected 0 leftovers for prefix ${testPrefix}, found: ${
        leftovers.map((e) => e.name).join(", ")
      }`,
    );
  } finally {
    for (const entry of Deno.readDirSync("/tmp")) {
      if (entry.name.startsWith(testPrefix)) {
        await Deno.remove(`/tmp/${entry.name}`, { recursive: true }).catch(() => {});
      }
    }
  }
});

Deno.test("proof-helper: writeEvidenceReadme refuses to write and names failures when runProof has recorded failures (audio-feed-nksl)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-guard-fail-" });
  try {
    const err = await assertRejects(
      async () => {
        await runProof(
          "test-failing-proof",
          async (checker) => {
            checker.check("passing step", true, "ok");
            checker.check("failing step 1", false, "reason 1");
            checker.check("failing step 2", false, "reason 2");

            // Attempt to write evidence README after recorded failures
            await writeEvidenceReadme({
              dir,
              title: "Failing Proof Report",
              script: "scripts/test-failing-proof.ts",
              asserts: ["passing step", "failing step 1", "failing step 2"],
            });
          },
          { logger: () => {} },
        );
      },
      Error,
      "Refusing to write evidence README for proof 'test-failing-proof': proof has 2 recorded failure(s): failing step 1 (reason 1); failing step 2 (reason 2)",
    );

    assertStringIncludes(
      err.message,
      "Refusing to write evidence README for proof 'test-failing-proof'",
    );
    assertStringIncludes(err.message, "failing step 1 (reason 1)");
    assertStringIncludes(err.message, "failing step 2 (reason 2)");

    // Target evidence directory remains untouched / no README.md was created
    const files = [...Deno.readDirSync(dir)];
    assertEquals(
      files.length,
      0,
      `Expected 0 files written to evidence dir on failure, found: ${
        files.map((f) => f.name).join(", ")
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme refuses to write when options.checker has recorded failures", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-explicit-checker-" });
  try {
    const checker = createChecker(() => {});
    try {
      checker.check("explicit failure", false, "explicit reason");
    } catch {
      // immediate throw swallowed to test checker instance failure state
    }
    assertEquals(checker.failures.length, 1);

    const err = await assertRejects(
      async () => {
        await writeEvidenceReadme({
          dir,
          title: "Explicit Checker Report",
          script: "scripts/test-proof.ts",
          asserts: ["explicit failure"],
          checker,
          allowOutsideProof: true,
        });
      },
      Error,
      "Refusing to write evidence README: proof has 1 recorded failure(s): explicit failure (explicit reason)",
    );
    assertStringIncludes(err.message, "explicit failure (explicit reason)");

    const files = [...Deno.readDirSync(dir)];
    assertEquals(files.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme refuses to write when active runProof has failures even if options.checker passes (audio-feed-nksl)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-bypass-" });
  try {
    const passingChecker = createChecker(() => {});
    assertEquals(passingChecker.failures.length, 0);

    const err = await assertRejects(
      async () => {
        await runProof(
          "test-bypass-proof",
          async (activeChecker) => {
            activeChecker.check("failing active step", false, "active fail reason");

            // Attempt to write evidence README with a clean/passing explicit checker
            await writeEvidenceReadme({
              dir,
              title: "Bypass Attempt Report",
              script: "scripts/test-bypass-proof.ts",
              asserts: ["failing active step"],
              checker: passingChecker,
            });
          },
          { logger: () => {} },
        );
      },
      Error,
      "Refusing to write evidence README for proof 'test-bypass-proof': proof has 1 recorded failure(s): failing active step (active fail reason)",
    );

    assertStringIncludes(
      err.message,
      "Refusing to write evidence README for proof 'test-bypass-proof'",
    );
    assertStringIncludes(err.message, "failing active step (active fail reason)");

    // Target evidence directory remains untouched / no README.md was created
    const files = [...Deno.readDirSync(dir)];
    assertEquals(
      files.length,
      0,
      `Expected 0 files written to evidence dir on failure, found: ${
        files.map((f) => f.name).join(", ")
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme refuses to write when active runProof passes but options.checker has failures", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-explicit-fail-" });
  try {
    const failingChecker = createChecker(() => {});
    try {
      failingChecker.check("explicit failure", false, "explicit fail reason");
    } catch {
      // immediate throw caught
    }
    assertEquals(failingChecker.failures.length, 1);

    const err = await assertRejects(
      async () => {
        await runProof(
          "test-active-pass-explicit-fail-proof",
          async (activeChecker) => {
            activeChecker.check("passing active step", true);

            await writeEvidenceReadme({
              dir,
              title: "Explicit Fail Report",
              script: "scripts/test-proof.ts",
              asserts: ["passing active step"],
              checker: failingChecker,
            });
          },
          { logger: () => {} },
        );
      },
      Error,
      "Refusing to write evidence README for proof 'test-active-pass-explicit-fail-proof': proof has 1 recorded failure(s): explicit failure (explicit fail reason)",
    );

    assertStringIncludes(
      err.message,
      "Refusing to write evidence README for proof 'test-active-pass-explicit-fail-proof'",
    );
    assertStringIncludes(err.message, "explicit failure (explicit fail reason)");

    const files = [...Deno.readDirSync(dir)];
    assertEquals(
      files.length,
      0,
      `Expected 0 files written to evidence dir on failure, found: ${
        files.map((f) => f.name).join(", ")
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme succeeds inside runProof when both active checker and options.checker pass", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-both-pass-" });
  try {
    const passingChecker = createChecker(() => {});
    passingChecker.check("passing explicit step", true);
    assertEquals(passingChecker.failures.length, 0);

    await runProof(
      "test-both-pass-proof",
      async (checker) => {
        checker.check("passing active step 1", true);
        checker.check("passing active step 2", true, "detail 2");

        await writeEvidenceReadme({
          dir,
          title: "Both Passing Proof Report",
          script: "scripts/test-both-pass-proof.ts",
          asserts: ["passing active step 1", "passing active step 2"],
          checker: passingChecker,
        });
      },
      { logger: () => {} },
    );

    const readmeContent = await Deno.readTextFile(`${dir}/README.md`);
    assertStringIncludes(readmeContent, "# Both Passing Proof Report");
    assertStringIncludes(readmeContent, "- Script: scripts/test-both-pass-proof.ts");
    assertStringIncludes(readmeContent, "- Asserts: passing active step 1; passing active step 2");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme succeeds inside runProof when all checks pass", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-guard-pass-" });
  try {
    await runProof(
      "test-passing-proof",
      async (checker) => {
        checker.check("passing step 1", true);
        checker.check("passing step 2", true, "detail 2");

        await writeEvidenceReadme({
          dir,
          title: "Passing Proof Report",
          script: "scripts/test-passing-proof.ts",
          asserts: ["passing step 1", "passing step 2"],
        });
      },
      { logger: () => {} },
    );

    const readmeContent = await Deno.readTextFile(`${dir}/README.md`);
    assertStringIncludes(readmeContent, "# Passing Proof Report");
    assertStringIncludes(readmeContent, "- Script: scripts/test-passing-proof.ts");
    assertStringIncludes(readmeContent, "- Asserts: passing step 1; passing step 2");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: writeEvidenceReadme isolates failure state under concurrent runProof executions", async () => {
  const dirPass = await Deno.makeTempDir({ prefix: "evidence-concurrent-pass-" });
  const dirFail = await Deno.makeTempDir({ prefix: "evidence-concurrent-fail-" });

  try {
    const [resPass, resFail] = await Promise.allSettled([
      runProof(
        "concurrent-pass",
        async (checker) => {
          checker.check("concurrent pass step", true);
          await new Promise((r) => setTimeout(r, 10));
          await writeEvidenceReadme({
            dir: dirPass,
            title: "Concurrent Pass",
            script: "scripts/concurrent-pass.ts",
            asserts: ["concurrent pass step"],
          });
        },
        { logger: () => {} },
      ),
      runProof(
        "concurrent-fail",
        async (checker) => {
          checker.check("concurrent fail step", false, "isolated fail");
          await new Promise((r) => setTimeout(r, 10));
          await writeEvidenceReadme({
            dir: dirFail,
            title: "Concurrent Fail",
            script: "scripts/concurrent-fail.ts",
            asserts: ["concurrent fail step"],
          });
        },
        { logger: () => {} },
      ),
    ]);

    assertEquals(resPass.status, "fulfilled");
    assertEquals(resFail.status, "rejected");

    // The passing run wrote its README
    const passReadme = await Deno.readTextFile(`${dirPass}/README.md`);
    assertStringIncludes(passReadme, "# Concurrent Pass");

    // The failing run wrote nothing
    const failFiles = [...Deno.readDirSync(dirFail)];
    assertEquals(failFiles.length, 0);
  } finally {
    await Deno.remove(dirPass, { recursive: true }).catch(() => {});
    await Deno.remove(dirFail, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: late-failing check restores pre-existing evidence file to original bytes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-restore-" });
  const pngPath = `${dir}/01-test-evidence.png`;
  const originalBytes = new Uint8Array([1, 2, 3, 4]);
  const overwrittenBytes = new Uint8Array([9, 9, 9, 9]);

  try {
    await Deno.writeFile(pngPath, originalBytes);

    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-late-fail",
          async (checker) => {
            checker.check("step 1 passing", true);
            // Overwrite evidence file mid-proof
            await Deno.writeFile(pngPath, overwrittenBytes);
            // Late check fails
            checker.check("step 2 failing", false, "deliberate late failure");
            await writeEvidenceReadme({
              dir,
              title: "Test 2bfv",
              script: "scripts/test-2bfv.ts",
              asserts: ["step 1 passing", "step 2 failing"],
            });
          },
          { logger: () => {} },
        );
      },
      Error,
      "step 2 failing",
    );

    // Verify original content was restored on failure
    const currentBytes = await Deno.readFile(pngPath);
    assertEquals(Array.from(currentBytes), Array.from(originalBytes));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: late-failing check cleans up newly created evidence files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-cleanup-" });
  const newPng = `${dir}/02-new-screenshot.png`;

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-new-file-cleanup",
          async (checker) => {
            await Deno.writeFile(newPng, new Uint8Array([5, 6, 7]));
            checker.check("failing check", false, "fail after write");
          },
          { logger: () => {} },
        );
      },
      Error,
      "failing check",
    );

    // Verify newly created file was removed on failure
    let exists = true;
    try {
      await Deno.stat(newPng);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        exists = false;
      }
    }
    assertEquals(exists, false, "newly created file must be removed on failure");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: passing proof keeps updated evidence files on disk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-pass-" });
  const pngPath = `${dir}/01-success.png`;
  const initialBytes = new Uint8Array([1, 1]);
  const newBytes = new Uint8Array([2, 2]);

  try {
    await Deno.writeFile(pngPath, initialBytes);

    await runProof(
      "test-2bfv-pass",
      async (checker) => {
        checker.check("passing check", true);
        await Deno.writeFile(pngPath, newBytes);
        await writeEvidenceReadme({
          dir,
          title: "Success Proof",
          script: "scripts/success.ts",
          asserts: ["passing check"],
        });
      },
      { logger: () => {} },
    );

    // Verify new content remains on disk after passing proof
    const currentBytes = await Deno.readFile(pngPath);
    assertEquals(Array.from(currentBytes), Array.from(newBytes));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: disk write error bubbles up and triggers rollback of partial writes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-write-err-" });
  const file1 = `${dir}/01-first.png`;
  const file2 = `${dir}/02-second.png`;
  const originalBytes1 = new Uint8Array([1, 1, 1]);

  await Deno.writeFile(file1, originalBytes1);

  let injectThrow = false;
  const originalWrite = Deno.writeFile;
  // Mock throw on second write
  Deno.writeFile = async function (path, data, options) {
    if (injectThrow && String(path).includes("02-second.png")) {
      throw new Error("ENOSPC: Simulated disk full error");
    }
    return await originalWrite(path, data, options);
  };

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-enospc",
          async (checker) => {
            checker.check("step 1", true);
            // First file writes successfully
            await Deno.writeFile(file1, new Uint8Array([2, 2, 2]));
            // Inject throw on second write
            injectThrow = true;
            await Deno.writeFile(file2, new Uint8Array([3, 3, 3]));
          },
          { logger: () => {} },
        );
      },
      Error,
      "ENOSPC",
    );

    // Verify original content was restored on write error
    const currentBytes1 = await Deno.readFile(file1);
    assertEquals(Array.from(currentBytes1), Array.from(originalBytes1));

    // Verify second file does not exist
    let file2Exists = true;
    try {
      await Deno.stat(file2);
    } catch {
      file2Exists = false;
    }
    assertEquals(file2Exists, false);
  } finally {
    Deno.writeFile = originalWrite;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: external tmp file renamed into evidence is not recreated on rollback", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-tmp-rename-" });
  const finalPng = `${dir}/final-evidence.png`;
  const tmpPng = `${dir}/final-evidence.png8.tmp`;
  const unrelatedFile = `${dir}/unrelated-evidence.png`;

  const originalFinalBytes = new Uint8Array([10, 20, 30]);
  const originalUnrelatedBytes = new Uint8Array([99, 99]);
  const convertedBytes = new Uint8Array([40, 50, 60]);

  await Deno.writeFile(finalPng, originalFinalBytes);
  await Deno.writeFile(unrelatedFile, originalUnrelatedBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-rename-rollback",
          async (checker) => {
            // Simulate external command (e.g. ImageMagick convert) creating tmp file
            // by writing directly using Deno.core or file creation before rename
            await Deno.writeFile(tmpPng, convertedBytes);

            // Proof renames tmp file into target evidence path
            await Deno.rename(tmpPng, finalPng);

            // Late check fails
            checker.check("failing late check", false, "fail after rename");
          },
          { logger: () => {} },
        );
      },
      Error,
      "failing late check",
    );

    // 1. The target file must be restored to its pre-proof bytes
    const restoredFinalBytes = await Deno.readFile(finalPng);
    assertEquals(Array.from(restoredFinalBytes), Array.from(originalFinalBytes));

    // 2. The tmp file must NOT be recreated or left on disk
    let tmpExists = true;
    try {
      await Deno.stat(tmpPng);
    } catch {
      tmpExists = false;
    }
    assertEquals(tmpExists, false, "temporary rename source must not be recreated on rollback");

    // 3. Unrelated file must be completely untouched (no blanket restore)
    const currentUnrelated = await Deno.readFile(unrelatedFile);
    assertEquals(Array.from(currentUnrelated), Array.from(originalUnrelatedBytes));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: pre-existing source file renamed during proof is restored on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-preexisting-rename-" });
  const sourceFile = `${dir}/pre-existing-source.png`;
  const destFile = `${dir}/pre-existing-dest.png`;

  const sourceOriginal = new Uint8Array([1, 2, 3]);
  const destOriginal = new Uint8Array([4, 5, 6]);

  await Deno.writeFile(sourceFile, sourceOriginal);
  await Deno.writeFile(destFile, destOriginal);

  // Brief pause so file timestamps precede runProof startTime
  await new Promise((r) => setTimeout(r, 20));

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-preexisting-rename",
          async (checker) => {
            // Rename pre-existing source to dest
            await Deno.rename(sourceFile, destFile);
            checker.check("failing check", false, "fail after renaming pre-existing source");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after renaming pre-existing source",
    );

    // Source must be restored to original bytes
    const restoredSource = await Deno.readFile(sourceFile);
    assertEquals(Array.from(restoredSource), Array.from(sourceOriginal));

    // Dest must also be restored to its original bytes
    const restoredDest = await Deno.readFile(destFile);
    assertEquals(Array.from(restoredDest), Array.from(destOriginal));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: file URL with encoded spaces is correctly snapshotted and rolled back on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-url-test-" });
  const dirWithSpaces = `${rootDir}/dir with spaces and %20`;
  await Deno.mkdir(dirWithSpaces, { recursive: true });

  const filePath = `${dirWithSpaces}/evidence image.png`;
  const originalBytes = new Uint8Array([7, 8, 9]);
  const overwrittenBytes = new Uint8Array([99, 99, 99]);

  await Deno.writeFile(filePath, originalBytes);

  // Construct file:// URL which will encode the spaces as %20
  const fileUrl = toFileUrl(filePath);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-file-url-spaces",
          async (checker) => {
            // Write using file URL
            await Deno.writeFile(fileUrl, overwrittenBytes);
            checker.check("failing check", false, "fail with file URL");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail with file URL",
    );

    // Verify original content was restored to the decoded filesystem path
    const restoredBytes = await Deno.readFile(filePath);
    assertEquals(Array.from(restoredBytes), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: pre-existing .tmp file renamed during proof is restored on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-preexisting-tmp-" });
  const sourceTmp = `${dir}/pre-existing.tmp`;
  const destFile = `${dir}/final-dest.png`;

  const sourceOriginal = new Uint8Array([11, 22, 33]);
  const destOriginal = new Uint8Array([44, 55, 66]);

  await Deno.writeFile(sourceTmp, sourceOriginal);
  await Deno.writeFile(destFile, destOriginal);

  // Brief pause so file timestamps precede runProof startTime
  await new Promise((r) => setTimeout(r, 20));

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-preexisting-tmp-rename",
          async (checker) => {
            // Rename pre-existing .tmp file to destination
            await Deno.rename(sourceTmp, destFile);
            checker.check("failing check", false, "fail after renaming pre-existing tmp");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after renaming pre-existing tmp",
    );

    // Source .tmp must be restored to original bytes
    const restoredSource = await Deno.readFile(sourceTmp);
    assertEquals(Array.from(restoredSource), Array.from(sourceOriginal));

    // Dest must also be restored to its original bytes
    const restoredDest = await Deno.readFile(destFile);
    assertEquals(Array.from(restoredDest), Array.from(destOriginal));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: pre-existing file deleted with Deno.remove is restored on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-remove-restore-" });
  const targetFile = `${dir}/file-to-delete.png`;
  const originalBytes = new Uint8Array([77, 88, 99]);

  await Deno.writeFile(targetFile, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-remove-restore",
          async (checker) => {
            // Delete pre-existing file during proof
            await Deno.remove(targetFile);
            // Verify it was actually deleted
            let exists = true;
            try {
              await Deno.stat(targetFile);
            } catch {
              exists = false;
            }
            assertEquals(exists, false);

            checker.check("failing check", false, "fail after removing file");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after removing file",
    );

    // Deleted file must be restored to original bytes
    const restoredBytes = await Deno.readFile(targetFile);
    assertEquals(Array.from(restoredBytes), Array.from(originalBytes));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: pre-existing source with updated mtime is restored on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-mtime-rename-" });
  const sourceFile = `${dir}/mtime-source.png`;
  const destFile = `${dir}/mtime-dest.png`;

  const sourceOriginal = new Uint8Array([100, 101, 102]);
  const destOriginal = new Uint8Array([200, 201, 202]);

  await Deno.writeFile(sourceFile, sourceOriginal);
  await Deno.writeFile(destFile, destOriginal);

  // Pause so birthtime clearly precedes runProof startTime
  await new Promise((r) => setTimeout(r, 25));

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-mtime-rename",
          async (checker) => {
            // Update mtime of source during proof execution
            await Deno.utime(sourceFile, new Date(), new Date());

            // Rename to dest
            await Deno.rename(sourceFile, destFile);

            checker.check("failing check", false, "fail after mtime update and rename");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after mtime update and rename",
    );

    // Source must be restored to original bytes despite mtime change
    const restoredSource = await Deno.readFile(sourceFile);
    assertEquals(Array.from(restoredSource), Array.from(sourceOriginal));

    // Dest must also be restored to original bytes
    const restoredDest = await Deno.readFile(destFile);
    assertEquals(Array.from(restoredDest), Array.from(destOriginal));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: directory removed recursively is restored on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-recursive-remove-" });
  const subDir = `${rootDir}/subfolder`;
  await Deno.mkdir(subDir, { recursive: true });

  const file1 = `${subDir}/file1.png`;
  const file2 = `${subDir}/file2.png`;
  const bytes1 = new Uint8Array([1, 3, 5]);
  const bytes2 = new Uint8Array([2, 4, 6]);

  await Deno.writeFile(file1, bytes1);
  await Deno.writeFile(file2, bytes2);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-recursive-remove",
          async (checker) => {
            // Recursively remove directory containing files
            await Deno.remove(subDir, { recursive: true });

            checker.check("failing check", false, "fail after recursive removal");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after recursive removal",
    );

    // Both files and directory must be restored
    const restored1 = await Deno.readFile(file1);
    assertEquals(Array.from(restored1), Array.from(bytes1));

    const restored2 = await Deno.readFile(file2);
    assertEquals(Array.from(restored2), Array.from(bytes2));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: path aliases resolve to single canonical key without restoring intermediate bytes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-aliases-" });
  const originalBytes = new Uint8Array([111, 111]);
  const intermediateBytes = new Uint8Array([222, 222]);

  const testFile = `${dir}/evidence.png`;
  await Deno.writeFile(testFile, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-aliases",
          async (checker) => {
            // Write using relative dot path ./
            await Deno.writeFile(`${dir}/./evidence.png`, intermediateBytes);
            // Write using clean path
            await Deno.writeFile(testFile, new Uint8Array([333, 333]));

            checker.check("failing check", false, "fail after aliased writes");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after aliased writes",
    );

    // File must be restored to originalBytes (111, 111), NOT intermediateBytes (222, 222)
    const currentBytes = await Deno.readFile(testFile);
    assertEquals(Array.from(currentBytes), Array.from(originalBytes));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: pre-existing directory renamed during proof is restored on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dir-rename-" });
  const srcDir = `${rootDir}/source_dir`;
  const destDir = `${rootDir}/destination_dir`;

  await Deno.mkdir(srcDir, { recursive: true });
  const file1 = `${srcDir}/pic1.png`;
  const file2 = `${srcDir}/pic2.png`;
  const bytes1 = new Uint8Array([10, 20]);
  const bytes2 = new Uint8Array([30, 40]);

  await Deno.writeFile(file1, bytes1);
  await Deno.writeFile(file2, bytes2);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-dir-rename",
          async (checker) => {
            // Rename entire directory
            await Deno.rename(srcDir, destDir);

            checker.check("failing check", false, "fail after directory rename");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after directory rename",
    );

    // Destination directory must be removed
    let destExists = true;
    try {
      await Deno.stat(destDir);
    } catch {
      destExists = false;
    }
    assertEquals(destExists, false, "destination directory must be removed on rollback");

    // Source directory and all its files must be restored
    const restored1 = await Deno.readFile(file1);
    assertEquals(Array.from(restored1), Array.from(bytes1));

    const restored2 = await Deno.readFile(file2);
    assertEquals(Array.from(restored2), Array.from(bytes2));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: source created in same timestamp millisecond as proof start is restored on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-same-ms-" });
  const source = `${dir}/same-ms-source.png`;
  const dest = `${dir}/same-ms-dest.png`;
  const originalBytes = new Uint8Array([9, 8, 7]);

  // Create file immediately before calling runProof without any setTimeout pause
  await Deno.writeFile(source, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-same-ms",
          async (checker) => {
            await Deno.rename(source, dest);
            checker.check("failing check", false, "fail after immediate rename");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after immediate rename",
    );

    // Source must be restored to originalBytes
    const restoredSource = await Deno.readFile(source);
    assertEquals(Array.from(restoredSource), Array.from(originalBytes));

    // Dest must not exist
    let destExists = true;
    try {
      await Deno.stat(dest);
    } catch {
      destExists = false;
    }
    assertEquals(destExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: command-created file with lowercase png8: prefix does not survive rollback on failed rename", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-cmd-png8-" });
  const finalPng = `${dir}/final.png`;
  const tmpPng = `${dir}/final.png8.tmp`;
  const originalFinal = new Uint8Array([55, 66, 77]);

  await Deno.writeFile(finalPng, originalFinal);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-cmd-png8",
          async (checker) => {
            // Simulate convert command with lowercase png8: prefix without plain path argument
            const cmd = new Deno.Command("sh", {
              args: [
                "-c",
                'target="${1#png8:}"; echo -n "converted" > "$target"',
                "sh",
                `png8:${tmpPng}`,
              ],
            });
            await cmd.output();

            // Rename tmp to final
            await Deno.rename(tmpPng, finalPng);

            checker.check("failing check", false, "fail after command rename");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after command rename",
    );

    // Final must be restored to original bytes
    const restoredFinal = await Deno.readFile(finalPng);
    assertEquals(Array.from(restoredFinal), Array.from(originalFinal));

    // tmpPng must NOT exist on disk
    let tmpExists = true;
    try {
      await Deno.stat(tmpPng);
    } catch {
      tmpExists = false;
    }
    assertEquals(tmpExists, false, "command-created tmp file must not survive rollback");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: empty directory renamed during proof is restored on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-empty-dir-" });
  const emptySrc = `${rootDir}/empty_src`;
  const emptyDest = `${rootDir}/empty_dest`;

  await Deno.mkdir(emptySrc);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-empty-dir-rename",
          async (checker) => {
            await Deno.rename(emptySrc, emptyDest);
            checker.check("failing check", false, "fail after empty dir rename");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after empty dir rename",
    );

    // Dest must not exist
    let destExists = true;
    try {
      await Deno.stat(emptyDest);
    } catch {
      destExists = false;
    }
    assertEquals(destExists, false);

    // Source must exist as an empty directory
    const srcStat = await Deno.stat(emptySrc);
    assertEquals(srcStat.isDirectory, true);

    const entries = [];
    for await (const entry of Deno.readDir(emptySrc)) {
      entries.push(entry);
    }
    assertEquals(entries.length, 0);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: removed symlink is restored as a symlink on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-symlink-" });
  const targetFile = `${dir}/target.txt`;
  const symlinkFile = `${dir}/link.txt`;

  await Deno.writeTextFile(targetFile, "symlink target content");
  await Deno.symlink(targetFile, symlinkFile);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-symlink-restore",
          async (checker) => {
            // Remove symlink during proof
            await Deno.remove(symlinkFile);
            checker.check("failing check", false, "fail after symlink removal");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after symlink removal",
    );

    // Symlink must be restored as a symlink pointing to targetFile
    const lstat = await Deno.lstat(symlinkFile);
    assertEquals(lstat.isSymlink, true, "restored file must be a symlink");
    const linkTarget = await Deno.readLink(symlinkFile);
    assertEquals(linkTarget, targetFile);
    assertEquals(await Deno.readTextFile(symlinkFile), "symlink target content");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: newly created directory via Deno.mkdir is removed on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-new-dir-" });
  const newSubDir = `${rootDir}/brand_new_directory`;

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-new-dir-cleanup",
          async (checker) => {
            await Deno.mkdir(newSubDir, { recursive: true });
            checker.check("failing check", false, "fail after creating directory");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after creating directory",
    );

    // Newly created directory must be removed on failure
    let exists = true;
    try {
      await Deno.stat(newSubDir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "newly created directory must be removed on failure");
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: writing through a symlink restores the target file bytes on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-symlink-write-" });
  const targetFile = `${dir}/real-target.png`;
  const symlinkFile = `${dir}/symlink-alias.png`;

  const originalTargetBytes = new Uint8Array([12, 34, 56]);
  const newWrittenBytes = new Uint8Array([78, 90]);

  await Deno.writeFile(targetFile, originalTargetBytes);
  await Deno.symlink(targetFile, symlinkFile);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-symlink-write",
          async (checker) => {
            // Write to the symlink path (Deno.writeFile follows symlinks)
            await Deno.writeFile(symlinkFile, newWrittenBytes);
            checker.check("failing check", false, "fail after writing through symlink");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after writing through symlink",
    );

    // The real target file bytes must be restored
    const currentTargetBytes = await Deno.readFile(targetFile);
    assertEquals(Array.from(currentTargetBytes), Array.from(originalTargetBytes));

    // The symlink itself must still exist as a symlink
    const lstat = await Deno.lstat(symlinkFile);
    assertEquals(lstat.isSymlink, true);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: renaming onto existing empty directory restores source and clears destination on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dest-dir-clear-" });
  const srcDir = `${rootDir}/source_folder`;
  const destDir = `${rootDir}/dest_folder`;

  await Deno.mkdir(srcDir, { recursive: true });
  await Deno.mkdir(destDir, { recursive: true });

  const srcFile = `${srcDir}/evidence.png`;
  const originalBytes = new Uint8Array([99, 88, 77]);
  await Deno.writeFile(srcFile, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-dest-clear",
          async (checker) => {
            // Move file into pre-existing destDir
            await Deno.rename(srcFile, `${destDir}/evidence.png`);
            checker.check("failing check", false, "fail after moving into dest directory");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after moving into dest directory",
    );

    // Source file must be restored
    const restoredSrc = await Deno.readFile(srcFile);
    assertEquals(Array.from(restoredSrc), Array.from(originalBytes));

    // Destination directory must still exist, but must be empty
    const destStat = await Deno.stat(destDir);
    assertEquals(destStat.isDirectory, true);

    const destEntries = [];
    for await (const entry of Deno.readDir(destDir)) {
      destEntries.push(entry);
    }
    assertEquals(destEntries.length, 0, "destination directory must be cleared of moved files");
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: recursive mkdir removes all newly created ancestors on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-ancestor-mkdir-" });
  const parentDir = `${rootDir}/new_parent`;
  const deepDir = `${parentDir}/middle/child`;

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-ancestor-mkdir",
          async (checker) => {
            await Deno.mkdir(deepDir, { recursive: true });
            checker.check("failing check", false, "fail after recursive mkdir");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after recursive mkdir",
    );

    // parentDir and all descendants must be removed
    let parentExists = true;
    try {
      await Deno.stat(parentDir);
    } catch {
      parentExists = false;
    }
    assertEquals(parentExists, false, "all newly created ancestors must be removed on failure");
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: replacing a file with a directory restores original file on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-file-to-dir-" });
  const targetPath = `${rootDir}/item.txt`;
  const originalBytes = new Uint8Array([42, 43, 44]);

  await Deno.writeFile(targetPath, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-file-to-dir",
          async (checker) => {
            await Deno.remove(targetPath);
            await Deno.mkdir(targetPath);
            await Deno.writeTextFile(`${targetPath}/sub.txt`, "hello");
            checker.check("failing check", false, "fail after replacing file with directory");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after replacing file with directory",
    );

    // targetPath must be restored as a file with its original bytes
    const stat = await Deno.lstat(targetPath);
    assertEquals(stat.isDirectory, false);
    assertEquals(stat.isFile, true);
    const restoredBytes = await Deno.readFile(targetPath);
    assertEquals(Array.from(restoredBytes), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: writing through a dangling symlink removes the created target on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dangling-" });
  const targetPath = `${rootDir}/missing_target.png`;
  const linkPath = `${rootDir}/dangling_link.png`;

  // Create dangling symlink pointing to non-existent target
  await Deno.symlink(targetPath, linkPath);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-dangling-write",
          async (checker) => {
            // Write through the dangling link (creates targetPath)
            await Deno.writeFile(linkPath, new Uint8Array([1, 2, 3]));
            checker.check("failing check", false, "fail after writing through dangling symlink");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after writing through dangling symlink",
    );

    // Target must NOT exist on disk
    let targetExists = true;
    try {
      await Deno.lstat(targetPath);
    } catch {
      targetExists = false;
    }
    assertEquals(
      targetExists,
      false,
      "created target of dangling symlink must be removed on failure",
    );

    // Symlink must still exist as a dangling symlink
    const linkStat = await Deno.lstat(linkPath);
    assertEquals(linkStat.isSymlink, true);
    assertEquals(await Deno.readLink(linkPath), targetPath);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess overwrite of existing output restores prior bytes on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-cmd-overwrite-" });
  const outputPath = `${rootDir}/output.png`;
  const originalBytes = new Uint8Array([11, 22, 33, 44]);

  await Deno.writeFile(outputPath, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-cmd-overwrite",
          async (checker) => {
            const cmd = new Deno.Command("sh", {
              args: ["-c", 'echo -n "overwritten" > "$1"', "sh", outputPath],
            });
            await cmd.output();

            checker.check("failing check", false, "fail after subprocess overwrite");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after subprocess overwrite",
    );

    // Output file must be restored to original bytes
    const restoredBytes = await Deno.readFile(outputPath);
    assertEquals(Array.from(restoredBytes), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess overwrite with relative path and configured cwd restores prior bytes on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-cmd-cwd-" });
  const subDir = `${rootDir}/custom_workdir`;
  await Deno.mkdir(subDir);

  const outputPath = `${subDir}/relative_output.png`;
  const originalBytes = new Uint8Array([123, 45, 67, 89]);

  await Deno.writeFile(outputPath, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-cmd-cwd",
          async (checker) => {
            const cmd = new Deno.Command("sh", {
              args: ["-c", 'echo -n "overwritten_in_cwd" > "$1"', "sh", "relative_output.png"],
              cwd: subDir,
            });
            await cmd.output();

            checker.check("failing check", false, "fail after subprocess overwrite with cwd");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after subprocess overwrite with cwd",
    );

    // Output file in subDir must be restored to original bytes
    const restoredBytes = await Deno.readFile(outputPath);
    assertEquals(Array.from(restoredBytes), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: cleaned Chrome profile remains absent after proof failure", async () => {
  let profileDirRef = "";

  try {
    await assertRejects(
      async () => {
        // THE REDIRECT WRAPS THE WHOLE RUN, NOT JUST THE ALLOCATION (audio-feed-9ot4). TMPDIR is both
        // the sweep's root and the profile's root, so restoring it - and deleting the scratch tree -
        // the moment createTempChromeProfile returned would delete the profile out from under the
        // callback below. Measured: that version of this fix failed the row with ENOENT writing
        // `Preferences`, which is a real contract failing rather than a test artefact.
        await withScratchRoot((scratch) =>
          runProof(
            "test-2bfv-chrome-profile-cleanup",
            async (checker) => {
              const { profileDir, cleanup } = await createTempChromeProfile(
                "audiofeed-chrome-test-fail-",
                scratch,
              );
              assert(
                profileDir.startsWith(scratch),
                "the profile must live under the row's scratch root",
              );
              profileDirRef = profileDir;

              // Simulate files created by browser inside profile
              await Deno.writeTextFile(`${profileDir}/Preferences`, '{"test":true}');

              // Browser teardown cleans up profile
              await cleanup();

              // Verify profile is absent before failure
              let existsBeforeFail = true;
              try {
                await Deno.stat(profileDir);
              } catch {
                existsBeforeFail = false;
              }
              assertEquals(existsBeforeFail, false);

              // Proof fails
              checker.check("failing check", false, "fail after chrome profile cleanup");
            },
            { logger: () => {} },
          )
        );
      },
      Error,
      "fail after chrome profile cleanup",
    );

    // Profile must remain absent after proof failure rollback
    let existsAfterRollback = true;
    try {
      await Deno.stat(profileDirRef);
    } catch {
      existsAfterRollback = false;
    }
    assertEquals(
      existsAfterRollback,
      false,
      "cleaned Chrome profile must not be recreated by rollback on failure",
    );
  } finally {
    if (profileDirRef) {
      await Deno.remove(profileDirRef, { recursive: true }).catch(() => {});
    }
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess spawn with embedded shell command output is rolled back on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-cmd-spawn-" });
  const outPath = `${rootDir}/spawn_output.png`;
  const originalBytes = new Uint8Array([5, 5, 5]);

  await Deno.writeFile(outPath, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-cmd-spawn",
          async (checker) => {
            const child = new Deno.Command("sh", {
              args: ["-c", `echo -n "spawned_content" > ${outPath}`],
            }).spawn();
            await child.status;

            checker.check("failing check", false, "fail after spawn command");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after spawn command",
    );

    // outPath must be restored to originalBytes
    const restored = await Deno.readFile(outPath);
    assertEquals(Array.from(restored), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: untracked file in existing directory is preserved on rollback", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-untracked-preserve-" });
  const folder = `${rootDir}/managed_folder`;
  await Deno.mkdir(folder);

  const trackedFile = `${folder}/tracked.png`;
  const untrackedFile = `${folder}/untracked_external.txt`;
  const untrackedBytes = new Uint8Array([99, 100, 101]);

  await Deno.writeFile(trackedFile, new Uint8Array([1, 2, 3]));

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-preserve-untracked",
          async (checker) => {
            // Proof touches trackedFile
            await Deno.writeFile(trackedFile, new Uint8Array([4, 5, 6]));

            // Simulate file created by concurrent process without proof tracking
            // Write using originalWriteFile to simulate an untracked background/external write
            await Deno.writeFile(untrackedFile, untrackedBytes);
            const active = getActiveProof();
            if (active) {
              active.snapshots.delete(untrackedFile);
            }

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // untrackedFile must still exist with its contents
    const currentUntracked = await Deno.readFile(untrackedFile);
    assertEquals(Array.from(currentUntracked), Array.from(untrackedBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess with quoted shell path containing spaces restores prior bytes on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-quoted-space-" });
  const dirWithSpaces = `${rootDir}/evidence folder with spaces`;
  await Deno.mkdir(dirWithSpaces, { recursive: true });

  const outPath = `${dirWithSpaces}/space output.png`;
  const originalBytes = new Uint8Array([11, 22, 33]);

  await Deno.writeFile(outPath, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-quoted-space-rollback",
          async (checker) => {
            const cmd = new Deno.Command("sh", {
              args: ["-c", `echo -n "overwritten_content" > "${outPath}"`],
            });
            await cmd.output();

            checker.check("failing check", false, "fail after quoted shell command");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after quoted shell command",
    );

    // outPath must be restored to originalBytes
    const restored = await Deno.readFile(outPath);
    assertEquals(Array.from(restored), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: renaming directory onto existing empty directory restores source and clears destination on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dir-dest-clear-" });
  const srcDir = `${rootDir}/source_folder`;
  const destDir = `${rootDir}/dest_folder`;

  await Deno.mkdir(srcDir, { recursive: true });
  await Deno.mkdir(destDir, { recursive: true });

  const file1 = `${srcDir}/pic1.png`;
  const file2 = `${srcDir}/pic2.png`;
  const bytes1 = new Uint8Array([11, 12]);
  const bytes2 = new Uint8Array([13, 14]);

  await Deno.writeFile(file1, bytes1);
  await Deno.writeFile(file2, bytes2);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-dir-dest-clear",
          async (checker) => {
            // Rename entire srcDir onto existing empty destDir
            await Deno.rename(srcDir, destDir);
            checker.check("failing check", false, "fail after renaming directory onto empty dest");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after renaming directory onto empty dest",
    );

    // Source directory and all its files must be restored
    const restored1 = await Deno.readFile(file1);
    assertEquals(Array.from(restored1), Array.from(bytes1));
    const restored2 = await Deno.readFile(file2);
    assertEquals(Array.from(restored2), Array.from(bytes2));

    // Destination directory must still exist, but must be completely empty (no moved files left behind)
    const destStat = await Deno.stat(destDir);
    assertEquals(destStat.isDirectory, true);

    const destEntries = [];
    for await (const entry of Deno.readDir(destDir)) {
      destEntries.push(entry);
    }
    assertEquals(destEntries.length, 0, "destination directory must be cleared of moved files");
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess read-only input file is not overwritten by rollback on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-readonly-input-" });
  const inputFile = `${rootDir}/input.txt`;
  const initialBytes = new Uint8Array([1, 2, 3]);
  const concurrentBytes = new Uint8Array([9, 9, 9, 9]);

  await Deno.writeFile(inputFile, initialBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-readonly-input",
          async (checker) => {
            // Subprocess reads inputFile
            const cmd = new Deno.Command("cat", {
              args: [inputFile],
            });
            await cmd.output();

            // Simulate concurrent edit to inputFile outside the proof (bypassing proof interceptors)
            const f = await originalOpen(inputFile, { write: true, truncate: true });
            await f.write(concurrentBytes);
            f.close();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // inputFile must retain concurrentBytes (must NOT be rolled back to initialBytes)
    const currentBytes = await Deno.readFile(inputFile);
    assertEquals(Array.from(currentBytes), Array.from(concurrentBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: relative subprocess output without dot or slash restores prior bytes on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-no-ext-" });
  const artifactPath = `${rootDir}/artifact`;
  const originalBytes = new Uint8Array([7, 7, 7]);

  await Deno.writeFile(artifactPath, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-no-ext-output",
          async (checker) => {
            const cmd = new Deno.Command("sh", {
              args: ["-c", 'echo -n "changed" > artifact'],
              cwd: rootDir,
            });
            await cmd.output();

            checker.check("failing check", false, "fail after overwriting artifact");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after overwriting artifact",
    );

    // artifact must be restored to originalBytes
    const restored = await Deno.readFile(artifactPath);
    assertEquals(Array.from(restored), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: removing symlink does not overwrite concurrent edit to target on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-symlink-remove-" });
  const targetFile = `${dir}/target.txt`;
  const symlinkFile = `${dir}/link.txt`;

  const initialTargetBytes = new Uint8Array([1, 2, 3]);
  const concurrentTargetBytes = new Uint8Array([99, 98, 97]);

  await Deno.writeFile(targetFile, initialTargetBytes);
  await Deno.symlink(targetFile, symlinkFile);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-symlink-target-preserve",
          async (checker) => {
            // Remove the symlink (should only snapshot the link itself, not target)
            await Deno.remove(symlinkFile);

            // Simulate concurrent edit to target outside the proof
            const f = await originalOpen(targetFile, { write: true, truncate: true });
            await f.write(concurrentTargetBytes);
            f.close();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // Symlink must be restored pointing to target
    const lstat = await Deno.lstat(symlinkFile);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(symlinkFile), targetFile);

    // Target must retain concurrentTargetBytes (must NOT be overwritten with initialTargetBytes)
    const currentTarget = await Deno.readFile(targetFile);
    assertEquals(Array.from(currentTarget), Array.from(concurrentTargetBytes));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: newly created symlink is removed on proof failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-new-symlink-" });
  const targetFile = `${dir}/target.txt`;
  const linkFile = `${dir}/new-link.txt`;

  await Deno.writeTextFile(targetFile, "symlink target content");

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-new-symlink-rollback",
          async (checker) => {
            // Create a new symlink during proof
            await Deno.symlink(targetFile, linkFile);
            const lstat = await Deno.lstat(linkFile);
            assertEquals(lstat.isSymlink, true);

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // Newly created symlink must NOT exist on disk after failure
    let exists = true;
    try {
      await Deno.lstat(linkFile);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        exists = false;
      }
    }
    assertEquals(exists, false, "newly created symlink must be removed on failure");

    // Target file must remain intact
    assertEquals(await Deno.readTextFile(targetFile), "symlink target content");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: pre-existing dangling symlink is not deleted by mkdir ancestor tracking on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dangling-mkdir-" });
  const danglingLink = `${dir}/dangling_link`;
  const nonExistentTarget = `${dir}/does_not_exist`;

  // Create dangling symlink before proof starts
  await Deno.symlink(nonExistentTarget, danglingLink);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-dangling-mkdir",
          async (checker) => {
            // Attempt mkdir on an ancestor path that encounters or touches the dangling link
            try {
              await Deno.mkdir(danglingLink);
            } catch { /* expected */ }

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // Dangling symlink must still exist on disk (must not have been marked as null ancestor and deleted)
    const lstat = await Deno.lstat(danglingLink);
    assertEquals(lstat.isSymlink, true, "pre-existing dangling symlink must survive rollback");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: file modified via writable Deno.open is restored on proof failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-open-restore-" });
  const evidenceFile = `${rootDir}/evidence.png`;
  const originalBytes = new Uint8Array([10, 20, 30]);
  const newBytes = new Uint8Array([90, 80, 70]);

  await Deno.writeFile(evidenceFile, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-open-restore",
          async (checker) => {
            const f = await Deno.open(evidenceFile, { write: true, truncate: true });
            await f.write(newBytes);
            f.close();

            checker.check("failing check", false, "fail after write via open");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail after write via open",
    );

    // evidenceFile must be restored to originalBytes
    const restored = await Deno.readFile(evidenceFile);
    assertEquals(Array.from(restored), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: newly created directory containing untracked files is preserved on proof failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-new-dir-untracked-" });
  const newDir = `${rootDir}/created_directory`;
  const untrackedFile = `${newDir}/external.txt`;
  const untrackedBytes = new Uint8Array([55, 66, 77]);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-new-dir-preserve",
          async (checker) => {
            // Proof creates a new directory
            await Deno.mkdir(newDir);

            // Another actor creates an untracked file inside the newly created directory
            const f = await originalOpen(untrackedFile, { write: true, create: true });
            await f.write(untrackedBytes);
            f.close();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // The directory and the untracked file must both survive rollback
    const dirStat = await Deno.lstat(newDir);
    assertEquals(dirStat.isDirectory, true, "new directory with untracked children must survive");

    const content = await Deno.readFile(untrackedFile);
    assertEquals(Array.from(content), Array.from(untrackedBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: newly created directory with untracked file inside snapshotted parent is preserved on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-parent-untracked-" });
  const parentDir = `${rootDir}/existing_parent`;
  await Deno.mkdir(parentDir);

  const newChildDir = `${parentDir}/new_child`;
  const untrackedFile = `${newChildDir}/actor_file.txt`;
  const untrackedBytes = new Uint8Array([88, 99, 100]);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-parent-untracked",
          async (checker) => {
            // Touch existing parent (snapshots parent as a directory)
            await Deno.remove(parentDir, { recursive: true });
            await Deno.mkdir(parentDir);

            // Proof creates child directory inside parent
            await Deno.mkdir(newChildDir);

            // Another actor creates an untracked file inside newChildDir
            const f = await originalOpen(untrackedFile, { write: true, create: true });
            await f.write(untrackedBytes);
            f.close();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // newChildDir and untrackedFile must both survive rollback in step 2
    const dirStat = await Deno.lstat(newChildDir);
    assertEquals(dirStat.isDirectory, true);

    const content = await Deno.readFile(untrackedFile);
    assertEquals(Array.from(content), Array.from(untrackedBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: writing through already-snapshotted symlink snapshots and restores target on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-resnap-link-" });
  const targetFile = `${dir}/real-target.png`;
  const symlinkFile = `${dir}/alias-link.png`;

  const initialTargetBytes = new Uint8Array([1, 2, 3, 4]);
  const newWrittenBytes = new Uint8Array([9, 8, 7, 6]);

  await Deno.writeFile(targetFile, initialTargetBytes);
  await Deno.symlink(targetFile, symlinkFile);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-resnap-link",
          async (checker) => {
            // First: remove and recreate link during proof without writing target
            // (this snapshots symlinkFile without followSymlinkTarget)
            await Deno.remove(symlinkFile);
            await Deno.symlink(targetFile, symlinkFile);

            // Second: write through symlinkFile using writable open
            const f = await Deno.open(symlinkFile, { write: true, truncate: true });
            await f.write(newWrittenBytes);
            f.close();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // targetFile must be restored to initialTargetBytes on failure
    const currentTargetBytes = await Deno.readFile(targetFile);
    assertEquals(Array.from(currentTargetBytes), Array.from(initialTargetBytes));

    // symlinkFile must still be a symlink pointing to targetFile
    const lstat = await Deno.lstat(symlinkFile);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(symlinkFile), targetFile);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: writing through retargeted symlink snapshots and restores new target on failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-retarget-link-" });
  const target1 = `${dir}/target1.png`;
  const target2 = `${dir}/target2.png`;
  const linkFile = `${dir}/alias-link.png`;

  const bytes1 = new Uint8Array([1, 1, 1]);
  const bytes2 = new Uint8Array([2, 2, 2]);
  const newBytes = new Uint8Array([9, 9, 9]);

  await Deno.writeFile(target1, bytes1);
  await Deno.writeFile(target2, bytes2);
  await Deno.symlink(target1, linkFile);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-retarget-link",
          async (checker) => {
            // Remove link pointing to target1 and retarget link to target2
            await Deno.remove(linkFile);
            await Deno.symlink(target2, linkFile);

            // Write through the retargeted link (writes to target2)
            const f = await Deno.open(linkFile, { write: true, truncate: true });
            await f.write(newBytes);
            f.close();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // target2 must be restored to bytes2
    const currentTarget2 = await Deno.readFile(target2);
    assertEquals(Array.from(currentTarget2), Array.from(bytes2));

    // target1 must still have bytes1
    const currentTarget1 = await Deno.readFile(target1);
    assertEquals(Array.from(currentTarget1), Array.from(bytes1));

    // linkFile must be restored pointing to target1
    const lstat = await Deno.lstat(linkFile);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkFile), target1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: restoring original file preserves untracked child in replacement directory", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-file-untracked-child-" });
  const itemPath = `${rootDir}/item.txt`;
  const originalBytes = new Uint8Array([42, 42, 42]);
  const untrackedBytes = new Uint8Array([99, 99]);

  await Deno.writeFile(itemPath, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-file-untracked-child",
          async (checker) => {
            // Proof removes original file and creates a directory in its place
            await Deno.remove(itemPath);
            await Deno.mkdir(itemPath);

            // Another actor creates an untracked file inside itemPath directory
            const f = await originalOpen(`${itemPath}/external.txt`, { write: true, create: true });
            await f.write(untrackedBytes);
            f.close();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // itemPath must be restored as the original file with originalBytes
    const stat = await Deno.lstat(itemPath);
    assertEquals(stat.isFile, true);
    assertEquals(Array.from(await Deno.readFile(itemPath)), Array.from(originalBytes));

    // The untracked file must be preserved in the relocated directory
    let foundPreserved = false;
    for await (const entry of Deno.readDir(rootDir)) {
      if (entry.name.startsWith("item.txt.untracked-")) {
        const preservedBytes = await Deno.readFile(`${rootDir}/${entry.name}/external.txt`);
        assertEquals(Array.from(preservedBytes), Array.from(untrackedBytes));
        foundPreserved = true;
      }
    }
    assertEquals(
      foundPreserved,
      true,
      "untracked child in replacement directory must be preserved",
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: writing through retargeted directory symlink restores destination and preserves original target on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dir-symlink-" });
  const dirA = `${rootDir}/dirA`;
  const dirB = `${rootDir}/dirB`;
  const linkDir = `${rootDir}/linkDir`;

  await Deno.mkdir(dirA);
  await Deno.mkdir(dirB);

  const fileA = `${dirA}/file.txt`;
  const fileB = `${dirB}/file.txt`;
  const bytesA = new Uint8Array([1, 2, 3]);
  const bytesB = new Uint8Array([4, 5, 6]);
  const newBytes = new Uint8Array([99, 99, 99]);

  await Deno.writeFile(fileA, bytesA);
  await Deno.writeFile(fileB, bytesB);

  // linkDir initially points to dirA
  await Deno.symlink(dirA, linkDir);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-dir-symlink-retarget",
          async (checker) => {
            // Retarget linkDir from dirA to dirB
            await Deno.remove(linkDir);
            await Deno.symlink(dirB, linkDir);

            // Write through linkDir (writes to dirB/file.txt)
            await Deno.writeFile(`${linkDir}/file.txt`, newBytes);

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // linkDir must be restored pointing to dirA
    const lstat = await Deno.lstat(linkDir);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkDir), dirA);

    // dirB/file.txt must be restored to bytesB
    const currentB = await Deno.readFile(fileB);
    assertEquals(Array.from(currentB), Array.from(bytesB));

    // dirA/file.txt must still have bytesA (never overwritten)
    const currentA = await Deno.readFile(fileA);
    assertEquals(Array.from(currentA), Array.from(bytesA));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess write through retargeted directory symlink restores destination and preserves original target on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-cmd-dir-symlink-" });
  const dirA = `${rootDir}/dirA`;
  const dirB = `${rootDir}/dirB`;
  const linkDir = `${rootDir}/linkDir`;

  await Deno.mkdir(dirA);
  await Deno.mkdir(dirB);

  const fileA = `${dirA}/out.txt`;
  const fileB = `${dirB}/out.txt`;
  const bytesA = new Uint8Array([10, 20]);
  const bytesB = new Uint8Array([30, 40]);

  await Deno.writeFile(fileA, bytesA);
  await Deno.writeFile(fileB, bytesB);

  // linkDir initially points to dirA
  await Deno.symlink(dirA, linkDir);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-cmd-dir-symlink",
          async (checker) => {
            // Retarget linkDir from dirA to dirB
            await Deno.remove(linkDir);
            await Deno.symlink(dirB, linkDir);

            // Subprocess writes through linkDir (writes to dirB/out.txt)
            const cmd = new Deno.Command("sh", {
              args: ["-c", `echo -n "overwritten_in_dirB" > "${linkDir}/out.txt"`],
            });
            await cmd.output();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // linkDir must be restored pointing to dirA
    const lstat = await Deno.lstat(linkDir);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkDir), dirA);

    // dirB/out.txt must be restored to bytesB
    const currentB = await Deno.readFile(fileB);
    assertEquals(Array.from(currentB), Array.from(bytesB));

    // dirA/out.txt must still have bytesA (never overwritten)
    const currentA = await Deno.readFile(fileA);
    assertEquals(Array.from(currentA), Array.from(bytesA));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: rollback surfaces error when restoration fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-rollback-err-" });
  const symlinkFile = `${dir}/test-link`;
  const target = `${dir}/target.txt`;

  await Deno.writeTextFile(target, "content");
  await Deno.symlink(target, symlinkFile);

  // Mock Deno.symlink to fail during rollback
  const origSymlink = Deno.symlink;
  let failSymlink = false;
  Deno.symlink = async function (oldP, newP, opts) {
    if (failSymlink) {
      throw new Error("Simulated EPERM in symlink restore");
    }
    return await origSymlink(oldP, newP, opts);
  };

  try {
    const err = await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-rollback-err-surface",
          async (checker) => {
            await Deno.remove(symlinkFile);
            failSymlink = true;
            checker.check("failing check", false, "initial check failure");
          },
          { logger: () => {} },
        );
      },
      Error,
    );

    // The rollback failure should be attached as cause
    const cause = (err as Error).cause;
    assertStringIncludes(String(cause), "Simulated EPERM in symlink restore");
  } finally {
    Deno.symlink = origSymlink;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: removal through retargeted directory symlink restores destination and preserves original target on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-rm-dir-symlink-" });
  const dirA = `${rootDir}/dirA`;
  const dirB = `${rootDir}/dirB`;
  const linkDir = `${rootDir}/linkDir`;

  await Deno.mkdir(dirA);
  await Deno.mkdir(dirB);

  const fileA = `${dirA}/file.txt`;
  const fileB = `${dirB}/file.txt`;
  const bytesA = new Uint8Array([11, 22]);
  const bytesB = new Uint8Array([33, 44]);

  await Deno.writeFile(fileA, bytesA);
  await Deno.writeFile(fileB, bytesB);

  // linkDir initially points to dirA
  await Deno.symlink(dirA, linkDir);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-rm-dir-symlink",
          async (checker) => {
            // Retarget linkDir from dirA to dirB
            await Deno.remove(linkDir);
            await Deno.symlink(dirB, linkDir);

            // Remove through linkDir (removes dirB/file.txt)
            await Deno.remove(`${linkDir}/file.txt`);

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // linkDir must be restored pointing to dirA
    const lstat = await Deno.lstat(linkDir);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkDir), dirA);

    // dirB/file.txt must be restored to bytesB
    const currentB = await Deno.readFile(fileB);
    assertEquals(Array.from(currentB), Array.from(bytesB));

    // dirA/file.txt must still have bytesA (never overwritten or removed)
    const currentA = await Deno.readFile(fileA);
    assertEquals(Array.from(currentA), Array.from(bytesA));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: snapshot failure aborts mutation before overwriting file", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-snap-fail-" });
  const testFile = `${rootDir}/protected.txt`;
  const originalBytes = new Uint8Array([1, 2, 3, 4]);
  await Deno.writeFile(testFile, originalBytes);

  // Make testFile write-only (no read permission: mode 0o200)
  await Deno.chmod(testFile, 0o200);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-snap-fail",
          async (_checker) => {
            // WriteFile should attempt snapshot, fail with PermissionDenied, and abort before writing
            await Deno.writeFile(testFile, new Uint8Array([99, 99]));
          },
          { logger: () => {} },
        );
      },
      Deno.errors.PermissionDenied,
    );

    // Restore read permission to verify content
    await Deno.chmod(testFile, 0o644);
    const content = await Deno.readFile(testFile);
    assertEquals(Array.from(content), Array.from(originalBytes));
  } finally {
    await Deno.chmod(testFile, 0o644).catch(() => {});
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: rollback error aggregates when body error already has cause", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-2bfv-agg-cause-" });
  const symlinkFile = `${dir}/test-link`;
  const target = `${dir}/target.txt`;

  await Deno.writeTextFile(target, "content");
  await Deno.symlink(target, symlinkFile);

  const origSymlink = Deno.symlink;
  let failSymlink = false;
  Deno.symlink = async function (oldP, newP, opts) {
    if (failSymlink) {
      throw new Error("Simulated EPERM in symlink restore");
    }
    return await origSymlink(oldP, newP, opts);
  };

  try {
    const err = await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-agg-cause",
          async (_checker) => {
            await Deno.remove(symlinkFile);
            failSymlink = true;
            const primaryErr = new Error("Primary body error", {
              cause: new Error("Initial body cause"),
            });
            throw primaryErr;
          },
          { logger: () => {} },
        );
      },
      Error,
      "Primary body error",
    );

    const cause = (err as Error).cause;
    assertEquals(cause instanceof AggregateError, true);
    const agg = cause as AggregateError;
    assertEquals(agg.errors.length, 2);
    assertStringIncludes(String(agg.errors[0]), "Initial body cause");
    assertStringIncludes(String(agg.errors[1]), "Simulated EPERM in symlink restore");
  } finally {
    Deno.symlink = origSymlink;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: recursive removal with unreadable child aborts and does not delete un-snapshotted files", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-rm-unreadable-" });
  const subDir = `${rootDir}/subdir`;
  await Deno.mkdir(subDir);

  const file1 = `${subDir}/readable.txt`;
  const file2 = `${subDir}/unreadable.txt`;
  await Deno.writeFile(file1, new Uint8Array([1, 2, 3]));
  await Deno.writeFile(file2, new Uint8Array([4, 5, 6]));

  // Make file2 write-only (unreadable)
  await Deno.chmod(file2, 0o200);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-rm-unreadable",
          async (_checker) => {
            // Recursive removal should fail when trying to snapshot unreadable child
            await Deno.remove(subDir, { recursive: true });
          },
          { logger: () => {} },
        );
      },
      Deno.errors.PermissionDenied,
    );

    // subDir and its children must not have been deleted
    await Deno.chmod(file2, 0o644);
    const content1 = await Deno.readFile(file1);
    const content2 = await Deno.readFile(file2);
    assertEquals(Array.from(content1), [1, 2, 3]);
    assertEquals(Array.from(content2), [4, 5, 6]);
  } finally {
    await Deno.chmod(file2, 0o644).catch(() => {});
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess snapshot failure aborts execution and does not overwrite un-snapshotted file", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-cmd-snap-fail-" });
  const testFile = `${rootDir}/protected.txt`;
  const originalBytes = new Uint8Array([7, 8, 9]);
  await Deno.writeFile(testFile, originalBytes);

  // Make testFile write-only (unreadable)
  await Deno.chmod(testFile, 0o200);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-cmd-snap-fail",
          async (_checker) => {
            const cmd = new Deno.Command("sh", {
              args: ["-c", `echo -n "hacked" > "${testFile}"`],
            });
            await cmd.output();
          },
          { logger: () => {} },
        );
      },
      Deno.errors.PermissionDenied,
    );

    // Restore read permission to verify content was not overwritten
    await Deno.chmod(testFile, 0o644);
    const content = await Deno.readFile(testFile);
    assertEquals(Array.from(content), Array.from(originalBytes));
  } finally {
    await Deno.chmod(testFile, 0o644).catch(() => {});
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: rename through retargeted directory symlink restores destination and preserves original target on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-mv-dir-symlink-" });
  const dirA = `${rootDir}/dirA`;
  const dirB = `${rootDir}/dirB`;
  const linkDir = `${rootDir}/linkDir`;

  await Deno.mkdir(dirA);
  await Deno.mkdir(dirB);

  const fileA = `${dirA}/file.txt`;
  const fileB = `${dirB}/file.txt`;
  const bytesA = new Uint8Array([111, 112]);
  const bytesB = new Uint8Array([113, 114]);

  await Deno.writeFile(fileA, bytesA);
  await Deno.writeFile(fileB, bytesB);

  // linkDir initially points to dirA
  await Deno.symlink(dirA, linkDir);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-mv-dir-symlink",
          async (checker) => {
            // Retarget linkDir from dirA to dirB
            await Deno.remove(linkDir);
            await Deno.symlink(dirB, linkDir);

            // Rename through linkDir (renames dirB/file.txt to dirB/file_moved.txt)
            await Deno.rename(`${linkDir}/file.txt`, `${linkDir}/file_moved.txt`);

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // linkDir must be restored pointing to dirA
    const lstat = await Deno.lstat(linkDir);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkDir), dirA);

    // dirB/file.txt must be restored to bytesB
    const currentB = await Deno.readFile(fileB);
    assertEquals(Array.from(currentB), Array.from(bytesB));

    // dirB/file_moved.txt must be cleaned up
    const movedExists = await Deno.lstat(`${dirB}/file_moved.txt`).then(() => true).catch(() =>
      false
    );
    assertEquals(movedExists, false);

    // dirA/file.txt must still have bytesA (never overwritten)
    const currentA = await Deno.readFile(fileA);
    assertEquals(Array.from(currentA), Array.from(bytesA));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: shell positional variable redirect does not snapshot or remove unrelated literal $1 file", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-shell-var-" });
  const realTarget = `${rootDir}/real_target.txt`;
  const unrelatedDollarFile = `${rootDir}/$1`;

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-shell-var",
          async (checker) => {
            // Subprocess redirects to positional variable "$1"
            const cmd = new Deno.Command("sh", {
              args: ["-c", `echo -n "target_data" > "$1"`, "dummy_script_name", realTarget],
              cwd: rootDir,
            });
            await cmd.output();

            // An external process creates an unrelated literal file named "$1" in rootDir
            const touchCmd = new Deno.Command("touch", {
              args: [unrelatedDollarFile],
            });
            await touchCmd.output();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // real_target.txt was created during proof so it must be rolled back (removed)
    const targetStat = await Deno.lstat(realTarget).then(() => true).catch(() => false);
    assertEquals(targetStat, false);

    // The unrelated literal "$1" file must NOT have been removed on rollback
    const dollarStat = await Deno.lstat(unrelatedDollarFile).then(() => true).catch(() => false);
    assertEquals(dollarStat, true);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess tee with positional variable restores prior bytes on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-tee-var-" });
  const realTarget = `${rootDir}/target.txt`;
  const originalBytes = new Uint8Array([55, 66, 77]);
  await Deno.writeFile(realTarget, originalBytes);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-tee-var",
          async (checker) => {
            const cmd = new Deno.Command("sh", {
              args: ["-c", `echo "overwritten" | tee "$1"`, "dummy_script", realTarget],
              cwd: rootDir,
            });
            await cmd.output();

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // realTarget must be restored to originalBytes
    const restored = await Deno.readFile(realTarget);
    assertEquals(Array.from(restored), Array.from(originalBytes));
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: mkdir through retargeted directory symlink removes physical destination and preserves retargeted path on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-mkdir-symlink-" });
  const dirA = `${rootDir}/dirA`;
  const dirB = `${rootDir}/dirB`;
  const linkDir = `${rootDir}/linkDir`;

  await Deno.mkdir(dirA);
  await Deno.mkdir(dirB);

  // Pre-create B/new to simulate pre-existing or unrelated file/dir in B
  const preExistingBNew = `${dirB}/new`;
  await Deno.mkdir(preExistingBNew);

  // linkDir initially points to dirA
  await Deno.symlink(dirA, linkDir);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-mkdir-symlink",
          async (checker) => {
            // While linkDir points to dirA, create linkDir/new (creates dirA/new)
            await Deno.mkdir(`${linkDir}/new`);

            // Then retarget linkDir from dirA to dirB
            await Deno.remove(linkDir);
            await Deno.symlink(dirB, linkDir);

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // linkDir must be restored pointing to dirA
    const lstat = await Deno.lstat(linkDir);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkDir), dirA);

    // dirA/new was created in proof, so it must be rolled back (removed)
    const existsA = await Deno.lstat(`${dirA}/new`).then(() => true).catch(() => false);
    assertEquals(existsA, false);

    // dirB/new was pre-existing and unrelated, so it must NOT be removed
    const existsB = await Deno.lstat(`${dirB}/new`).then(() => true).catch(() => false);
    assertEquals(existsB, true);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: recursive mkdir through retargeted directory symlink removes physical destination and preserves retargeted path on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-mkdir-deep-symlink-" });
  const dirA = `${rootDir}/dirA`;
  const dirB = `${rootDir}/dirB`;
  const linkDir = `${rootDir}/linkDir`;

  await Deno.mkdir(dirA);
  await Deno.mkdir(dirB);

  // Pre-create B/new/deep to simulate pre-existing or unrelated file/dir in B
  const preExistingBDeep = `${dirB}/new/deep`;
  await Deno.mkdir(preExistingBDeep, { recursive: true });

  // linkDir initially points to dirA
  await Deno.symlink(dirA, linkDir);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-mkdir-deep-symlink",
          async (checker) => {
            // While linkDir points to dirA, recursively create linkDir/new/deep (creates dirA/new/deep)
            await Deno.mkdir(`${linkDir}/new/deep`, { recursive: true });

            // Then retarget linkDir from dirA to dirB
            await Deno.remove(linkDir);
            await Deno.symlink(dirB, linkDir);

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // linkDir must be restored pointing to dirA
    const lstat = await Deno.lstat(linkDir);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkDir), dirA);

    // dirA/new/deep and dirA/new were created during proof, so they must be rolled back (removed)
    const existsADeep = await Deno.lstat(`${dirA}/new/deep`).then(() => true).catch(() => false);
    assertEquals(existsADeep, false);
    const existsANew = await Deno.lstat(`${dirA}/new`).then(() => true).catch(() => false);
    assertEquals(existsANew, false);

    // dirB/new/deep was pre-existing and unrelated, so it must NOT be removed
    const existsBDeep = await Deno.lstat(`${dirB}/new/deep`).then(() => true).catch(() => false);
    assertEquals(existsBDeep, true);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: resolveWritePath resolves relative symlink target against physical parent", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-rel-symlink-" });
  const elsewhereDir = `${rootDir}/elsewhere/sub`;
  await Deno.mkdir(elsewhereDir, { recursive: true });

  const targetFile = `${rootDir}/elsewhere/target.txt`;
  const initialBytes = new Uint8Array([11, 22, 33]);
  await Deno.writeFile(targetFile, initialBytes);

  // /rootDir/link points to /rootDir/elsewhere/sub
  const linkDir = `${rootDir}/link`;
  await Deno.symlink(elsewhereDir, linkDir);

  // /rootDir/elsewhere/sub/file points to ../target.txt
  const fileLink = `${elsewhereDir}/file`;
  await Deno.symlink("../target.txt", fileLink);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-rel-symlink",
          async (checker) => {
            // Write to linkDir/file (which is /rootDir/link/file)
            // It should resolve physical parent /rootDir/elsewhere/sub, join ../target.txt -> /rootDir/elsewhere/target.txt
            await Deno.writeFile(`${linkDir}/file`, new Uint8Array([99, 99, 99]));

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // targetFile must be restored to initialBytes on failure
    const restored = await Deno.readFile(targetFile);
    assertEquals(Array.from(restored), Array.from(initialBytes));

    // A file named target.txt must NOT have been created under rootDir
    const wrongTarget = `${rootDir}/target.txt`;
    const wrongExists = await Deno.lstat(wrongTarget).then(() => true).catch(() => false);
    assertEquals(wrongExists, false);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: symlink creation through retargeted directory symlink removes physical destination and preserves retargeted path on failure", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-symlink-retarget-" });
  const dirA = `${rootDir}/dirA`;
  const dirB = `${rootDir}/dirB`;
  const linkDir = `${rootDir}/linkDir`;

  await Deno.mkdir(dirA);
  await Deno.mkdir(dirB);

  // Pre-create B/new-link to simulate pre-existing or unrelated link in B
  const preExistingBLink = `${dirB}/new-link`;
  await Deno.symlink(`${rootDir}/dummy`, preExistingBLink);

  // linkDir initially points to dirA
  await Deno.symlink(dirA, linkDir);

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-2bfv-symlink-retarget",
          async (checker) => {
            // While linkDir points to dirA, create symlink linkDir/new-link (creates dirA/new-link)
            await Deno.symlink(`${rootDir}/some_target`, `${linkDir}/new-link`);

            // Then retarget linkDir from dirA to dirB
            await Deno.remove(linkDir);
            await Deno.symlink(dirB, linkDir);

            checker.check("failing check", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // linkDir must be restored pointing to dirA
    const lstat = await Deno.lstat(linkDir);
    assertEquals(lstat.isSymlink, true);
    assertEquals(await Deno.readLink(linkDir), dirA);

    // dirA/new-link was created during proof, so it must be rolled back (removed)
    const existsALink = await Deno.lstat(`${dirA}/new-link`).then(() => true).catch(() => false);
    assertEquals(existsALink, false);

    // dirB/new-link was pre-existing and unrelated, so it must NOT be removed
    const existsBLink = await Deno.lstat(`${dirB}/new-link`).then(() => true).catch(() => false);
    assertEquals(existsBLink, true);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: createNew rejects writing through existing dangling symlink with AlreadyExists", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-createnew-dangling-" });
  const danglingLink = `${rootDir}/dangling_link`;
  const missingTarget = `${rootDir}/missing_target.txt`;

  // Create a dangling symlink pointing to missing_target.txt
  await Deno.symlink(missingTarget, danglingLink);

  try {
    await runProof(
      "test-2bfv-createnew-dangling",
      async (_checker) => {
        // Writing to danglingLink with createNew: true must fail with AlreadyExists
        await assertRejects(
          async () => {
            await Deno.writeFile(danglingLink, new Uint8Array([1, 2, 3]), {
              createNew: true,
            });
          },
          Deno.errors.AlreadyExists,
        );

        // Also test writeTextFile with createNew: true
        await assertRejects(
          async () => {
            await Deno.writeTextFile(danglingLink, "hello", {
              createNew: true,
            });
          },
          Deno.errors.AlreadyExists,
        );

        // Also test Deno.open with createNew: true
        await assertRejects(
          async () => {
            const f = await Deno.open(danglingLink, {
              write: true,
              createNew: true,
            });
            f.close();
          },
          Deno.errors.AlreadyExists,
        );
      },
      { logger: () => {} },
    );

    // missingTarget must NOT have been created
    const targetExists = await Deno.lstat(missingTarget).then(() => true).catch(() => false);
    assertEquals(targetExists, false);

    // danglingLink must still exist as a symlink
    const linkStat = await Deno.lstat(danglingLink);
    assertEquals(linkStat.isSymlink, true);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: concurrent proof rollback does not overwrite later committed write", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-concurrent-commit-" });
  const sharedFile = `${rootDir}/shared_evidence.txt`;
  const initialBytes = new Uint8Array([1, 1, 1]);
  const proofABytes = new Uint8Array([2, 2, 2]);
  const proofBBytes = new Uint8Array([3, 3, 3]);

  await Deno.writeFile(sharedFile, initialBytes);

  let proofBResolve!: () => void;
  const proofBStarted = new Promise<void>((r) => {
    proofBResolve = r;
  });

  let proofAFinishResolve!: () => void;
  const proofACanFinish = new Promise<void>((r) => {
    proofAFinishResolve = r;
  });

  // Proof A: starts, writes proofABytes to sharedFile, waits for proof B to commit, then fails
  const promiseA = assertRejects(
    async () => {
      await runProof(
        "test-2bfv-concurrent-A",
        async (checker) => {
          await Deno.writeFile(sharedFile, proofABytes);
          proofBResolve(); // Signal Proof B to run and commit
          await proofACanFinish; // Wait until Proof B has finished and committed
          checker.check("failing check", false, "deliberate failure in Proof A");
        },
        { logger: () => {} },
      );
    },
    Error,
    "deliberate failure in Proof A",
  );

  // Proof B: starts after Proof A wrote, writes proofBBytes to sharedFile, passes (commits)
  const promiseB = (async () => {
    await proofBStarted;
    await runProof(
      "test-2bfv-concurrent-B",
      async (checker) => {
        await Deno.writeFile(sharedFile, proofBBytes);
        checker.check("passing check", true);
      },
      { logger: () => {} },
    );
    proofAFinishResolve(); // Allow Proof A to proceed to failure and rollback
  })();

  await Promise.all([promiseA, promiseB]);

  // sharedFile MUST retain proofBBytes committed by Proof B, NOT initialBytes from Proof A's rollback!
  const finalContent = await Deno.readFile(sharedFile);
  assertEquals(Array.from(finalContent), Array.from(proofBBytes));

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: concurrent proof committing during another proof rollback does not get overwritten", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-interleave-commit-" });
  const file1 = `${rootDir}/file1.txt`;
  const file2 = `${rootDir}/file2.txt`;

  const initialBytes1 = new Uint8Array([1, 1]);
  const initialBytes2 = new Uint8Array([2, 2]);
  const proofABytes1 = new Uint8Array([10, 10]);
  const proofABytes2 = new Uint8Array([20, 20]);
  const proofBBytes2 = new Uint8Array([99, 99]);

  await Deno.writeFile(file1, initialBytes1);
  await Deno.writeFile(file2, initialBytes2);

  let triggerProofB!: () => void;
  const proofBTriggered = new Promise<void>((r) => {
    triggerProofB = r;
  });
  let finishProofB!: () => void;
  const proofBFinished = new Promise<void>((r) => {
    finishProofB = r;
  });

  let inRollback = false;
  const origLstat = Deno.lstat;
  Deno.lstat = async function (path) {
    if (inRollback && String(path).includes("file1.txt")) {
      triggerProofB();
      await proofBFinished;
    }
    return await origLstat(path);
  };

  try {
    // Proof A: modifies file1 and file2, then fails.
    const promiseA = assertRejects(
      async () => {
        await runProof(
          "test-2bfv-interleave-A",
          async (checker) => {
            await Deno.writeFile(file1, proofABytes1);
            await Deno.writeFile(file2, proofABytes2);
            checker.check("fail A", false, "deliberate fail A");
            inRollback = true;
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate fail A",
    );

    // Proof B: triggered while Proof A is in rollback restoring file1.
    // Writes and commits file2 before Proof A can reach file2!
    const promiseB = (async () => {
      await proofBTriggered;
      await runProof(
        "test-2bfv-interleave-B",
        async (checker) => {
          await Deno.writeFile(file2, proofBBytes2);
          checker.check("pass B", true);
        },
        { logger: () => {} },
      );
      finishProofB();
    })();

    await Promise.all([promiseA, promiseB]);

    // file1 was rolled back by Proof A to initialBytes1
    const content1 = await Deno.readFile(file1);
    assertEquals(Array.from(content1), Array.from(initialBytes1));

    // file2 RETAINS proofBBytes2 committed by Proof B during Proof A's rollback!
    const content2 = await Deno.readFile(file2);
    assertEquals(Array.from(content2), Array.from(proofBBytes2));
  } finally {
    Deno.lstat = origLstat;
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: pre-existing directory restoration does not delete child committed by later proof", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dir-restore-child-" });
  const subDir = `${rootDir}/sub`;
  await Deno.mkdir(subDir, { recursive: true });
  const newChild = `${subDir}/new.txt`;
  const committedBytes = new Uint8Array([77, 88, 99]);

  // Proof A: creates sub/new.txt (null entry), removes and recreates pre-existing sub directory, then fails
  // Before A enters rollback, Proof B writes and commits sub/new.txt
  await runProof(
    "test-2bfv-proof-A",
    async (checker) => {
      // 1. Create sub/new.txt (snapshotted as null in A)
      await Deno.writeFile(newChild, new Uint8Array([1, 2, 3]));
      // 2. Remove pre-existing subDir and recreate it (snapshotted as isDirectory in A)
      await Deno.remove(subDir, { recursive: true });
      await Deno.mkdir(subDir);

      // Now Proof B writes and commits sub/new.txt while Proof A is still active
      await runProof(
        "test-2bfv-proof-B",
        async (bChecker) => {
          await Deno.writeFile(newChild, committedBytes);
          bChecker.check("pass B", true);
        },
        { logger: () => {} },
      );

      // Proof A fails!
      checker.check("fail A", false, "deliberate fail A");
    },
    { logger: () => {} },
  ).catch(() => {});

  // Rollback of Proof A should skip deleting newChild in step 1 AND in step 2 (directory restore),
  // preserving Proof B's committed file!
  const finalContent = await Deno.readFile(newChild);
  assertEquals(Array.from(finalContent), Array.from(committedBytes));

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: synchronous write is excluded with Deno.errors.Busy while path is locked by conflicting rollback", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-sync-locked-" });
  const file1 = `${rootDir}/file1.txt`;
  await Deno.writeFile(file1, new Uint8Array([1]));

  let triggerSyncWrite!: () => void;
  const syncWriteTriggered = new Promise<void>((r) => {
    triggerSyncWrite = r;
  });
  let syncWriteDone!: () => void;
  const syncWriteFinished = new Promise<void>((r) => {
    syncWriteDone = r;
  });

  let inRollback = false;
  let caughtBusyError: unknown = null;
  const origLstat = Deno.lstat;
  Deno.lstat = async function (path) {
    if (inRollback && String(path).includes("file1.txt")) {
      triggerSyncWrite();
      await syncWriteFinished;
    }
    return await origLstat(path);
  };

  try {
    const promiseA = assertRejects(
      async () => {
        await runProof(
          "test-2bfv-sync-A",
          async (checker) => {
            await Deno.writeFile(file1, new Uint8Array([10]));
            checker.check("fail A", false, "deliberate fail A");
            inRollback = true;
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate fail A",
    );

    const promiseSync = (async () => {
      await syncWriteTriggered;
      // While Proof A holds the lock on file1 in rollback:
      // A synchronous write in another proof must throw Deno.errors.Busy!
      try {
        await runProof(
          "test-2bfv-sync-B",
          () => {
            Deno.writeFileSync(file1, new Uint8Array([99]));
          },
          { logger: () => {} },
        );
      } catch (err) {
        caughtBusyError = err;
      } finally {
        syncWriteDone();
      }
    })();

    await Promise.all([promiseA, promiseSync]);

    assertEquals(caughtBusyError instanceof Deno.errors.Busy, true);
    // file1 must be rolled back to original byte [1]
    const content = await Deno.readFile(file1);
    assertEquals(Array.from(content), [1]);
  } finally {
    Deno.lstat = origLstat;
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: rollback waits for in-flight write and preserves bytes committed after write pause", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-inflight-write-" });
  const file1 = `${rootDir}/file1.txt`;
  const initialBytes = new Uint8Array([1, 1]);
  const proofABytes = new Uint8Array([10, 10]);
  const proofBBytes = new Uint8Array([99, 99]);

  await Deno.writeFile(file1, initialBytes);

  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });

  // Proof B: writes file1, then pauses before finishing/committing
  const promiseB = runProof(
    "test-2bfv-pause-B",
    async (checker) => {
      await Deno.writeFile(file1, proofBBytes);
      signalProofBWrote();
      await proofBPaused;
      checker.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Wait until Proof B has performed the write and holds the lock on file1
  await proofBWrote;

  // Proof A: started earlier or attempts rollback of file1
  // Proof A fails and attempts rollback while Proof B is paused with in-flight write
  const promiseA = assertRejects(
    async () => {
      await runProof(
        "test-2bfv-pause-A",
        async (checker) => {
          // Record snapshot of file1
          await Deno.writeFile(file1, proofABytes);
          checker.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    },
    Error,
    "deliberate fail A",
  );

  // Give Proof A time to enter rollback and block on file1 lock
  await new Promise((r) => setTimeout(r, 50));

  // Now unpause Proof B, allowing it to finish and commit file1
  unpauseProofB();

  await Promise.all([promiseA, promiseB]);

  // file1 must retain proofBBytes committed by Proof B!
  const finalContent = await Deno.readFile(file1);
  assertEquals(Array.from(finalContent), Array.from(proofBBytes));

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: recursively snapshotted pre-existing empty directory is restored on failure after earlier commit", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-empty-dir-restore-" });
  const topDir = `${rootDir}/top`;
  const subDir = `${topDir}/sub`;

  // Proof B: creates and commits top/sub empty directory
  await runProof(
    "test-2bfv-empty-dir-B",
    async (checker) => {
      await Deno.mkdir(subDir, { recursive: true });
      checker.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Verify top/sub exists
  assertEquals((await Deno.lstat(subDir)).isDirectory, true);

  // Proof A: recursively removes top (which snapshots top and subDir), then fails
  await assertRejects(
    async () => {
      await runProof(
        "test-2bfv-empty-dir-A",
        async (checker) => {
          await Deno.remove(topDir, { recursive: true });
          checker.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    },
    Error,
    "deliberate fail A",
  );

  // On Proof A failure, subDir must be restored because Proof B committed it BEFORE Proof A ran
  const statSub = await Deno.lstat(subDir);
  assertEquals(statSub.isDirectory, true);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed proof overwriting previously committed file rolls back to committed baseline", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-committed-baseline-" });
  const file = `${rootDir}/file.txt`;
  await Deno.writeFile(file, new Uint8Array([1])); // initial

  await runProof(
    "test-2bfv-baseline-A",
    async (cA) => {
      await Deno.writeFile(file, new Uint8Array([10])); // A write 1

      // Proof B runs, writes, and commits file
      await runProof(
        "test-2bfv-baseline-B",
        async (cB) => {
          await Deno.writeFile(file, new Uint8Array([99])); // B write
          cB.check("pass B", true);
        },
        { logger: () => {} },
      );

      // A writes file AGAIN with new dirty bytes
      await Deno.writeFile(file, new Uint8Array([20])); // A write 2

      // A fails!
      cA.check("fail A", false, "deliberate fail A");
    },
    { logger: () => {} },
  ).catch(() => {});

  // Rollback of A must restore B's committed bytes [99], not leave A's dirty write 2 [20]!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), [99]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: concurrent failing proofs with crossed path dependencies avoid reciprocal deadlock", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-no-deadlock-" });
  const fileX = `${rootDir}/x.txt`;
  const fileY = `${rootDir}/y.txt`;
  await Deno.writeFile(fileX, new Uint8Array([1]));
  await Deno.writeFile(fileY, new Uint8Array([2]));

  let signalBWroteY!: () => void;
  const bWroteY = new Promise<void>((r) => {
    signalBWroteY = r;
  });
  let signalAWroteX!: () => void;
  const aWroteX = new Promise<void>((r) => {
    signalAWroteX = r;
  });
  let signalBWroteX!: () => void;
  const bWroteX = new Promise<void>((r) => {
    signalBWroteX = r;
  });

  // A writes x, B writes y, B writes x, then A writes y, and both fail
  const pA = runProof(
    "test-2bfv-deadlock-A",
    async (cA) => {
      await Deno.writeFile(fileX, new Uint8Array([10]));
      signalAWroteX();
      await bWroteY;
      await bWroteX;
      await Deno.writeFile(fileY, new Uint8Array([20]));
      cA.check("fail A", false, "deliberate fail A");
    },
    { logger: () => {} },
  ).catch(() => {});

  const pB = (async () => {
    await aWroteX;
    await runProof(
      "test-2bfv-deadlock-B",
      async (cB) => {
        await Deno.writeFile(fileY, new Uint8Array([30]));
        signalBWroteY();
        await Deno.writeFile(fileX, new Uint8Array([40]));
        signalBWroteX();
        cB.check("fail B", false, "deliberate fail B");
      },
      { logger: () => {} },
    ).catch(() => {});
  })();

  await Promise.all([pA, pB]);

  // Both files must be rolled back to their initial bytes [1] and [2]
  const finalX = await Deno.readFile(fileX);
  const finalY = await Deno.readFile(fileY);
  assertEquals(Array.from(finalX), [1]);
  assertEquals(Array.from(finalY), [2]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older failing proof does not erase younger proof committed write after pause", async () => {
  const rootDir = await Deno.makeTempDir({
    prefix: "evidence-2bfv-older-failing-younger-success-",
  });
  const file = `${rootDir}/file.txt`;
  const initialBytes = new Uint8Array([1, 1]);
  const proofABytes = new Uint8Array([10, 10]);
  const proofBBytes = new Uint8Array([99, 99]);

  await Deno.writeFile(file, initialBytes);

  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });

  // Proof A (older proof): writes file, waits for B to write, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-older-A",
        async (cA) => {
          await Deno.writeFile(file, proofABytes);
          signalProofAWrote();
          await proofBWrote;
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B (younger proof): starts after A writes, writes file, pauses before committing, then passes
  const promiseB = (async () => {
    await proofAWrote;
    await runProof(
      "proof-younger-B",
      async (cB) => {
        await Deno.writeFile(file, proofBBytes);
        signalProofBWrote();
        await proofBPaused; // younger proof B pauses before committing
        cB.check("pass B", true);
      },
      { logger: () => {} },
    );
  })();

  // Wait a moment for older proof A to enter rollback while younger proof B is paused
  await new Promise((r) => setTimeout(r, 50));
  unpauseProofB();

  await Promise.all([promiseA, promiseB]);

  // Younger proof B's committed bytes must be preserved on disk!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), Array.from(proofBBytes));

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: unawaited spawned child process is awaited before rollback and cleaned up", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-spawn-unawaited-" });
  const out = `${rootDir}/spawned_out.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "test-spawn-unawaited",
        (c) => {
          const cmd = new Deno.Command("sh", {
            args: ["-c", `sleep 0.05; echo hello > "${out}"`],
          });
          cmd.spawn(); // unawaited spawn!
          c.check("fail step", false, "deliberate fail");
        },
        { logger: () => {} },
      );
    },
    Error,
    "deliberate fail",
  );

  // Even after a small delay, the output file must NOT exist because runProof awaited
  // the spawned child before rollback and removed the output file
  await new Promise((r) => setTimeout(r, 100));
  const exists = await Deno.lstat(out).then(() => true).catch(() => false);
  assertEquals(exists, false);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: barrier-controlled crossed-path failing proofs restore clean baseline without dirty snapshots", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-barrier-crossed-" });
  const fileX = `${rootDir}/x.txt`;
  const fileY = `${rootDir}/y.txt`;
  await Deno.writeFile(fileX, new Uint8Array([1]));
  await Deno.writeFile(fileY, new Uint8Array([2]));

  let signalBWroteY!: () => void;
  const bWroteY = new Promise<void>((r) => {
    signalBWroteY = r;
  });
  let signalAWroteX!: () => void;
  const aWroteX = new Promise<void>((r) => {
    signalAWroteX = r;
  });
  let signalBWroteX!: () => void;
  const bWroteX = new Promise<void>((r) => {
    signalBWroteX = r;
  });
  let signalAWroteY!: () => void;
  const aWroteY = new Promise<void>((r) => {
    signalAWroteY = r;
  });

  // Rollback overlap barriers strictly gating the rollback phase
  let signalAInRollback!: () => void;
  const aInRollback = new Promise<void>((r) => {
    signalAInRollback = r;
  });
  let signalBInRollback!: () => void;
  const bInRollback = new Promise<void>((r) => {
    signalBInRollback = r;
  });
  let releaseRollbacks!: () => void;
  const rollbacksBarrier = new Promise<void>((r) => {
    releaseRollbacks = r;
  });

  try {
    // Proof A: writes x=10, awaits B, writes y=20, fails
    const pA = runProof(
      "proof-A",
      async (cA) => {
        await Deno.writeFile(fileX, new Uint8Array([10]));
        signalAWroteX();
        await bWroteY;
        await bWroteX;
        await Deno.writeFile(fileY, new Uint8Array([20]));
        signalAWroteY();
        cA.check("fail A", false, "fail A");
      },
      {
        logger: () => {},
        rollbackHook: async (phase) => {
          if (phase === "start") {
            signalAInRollback();
            await rollbacksBarrier;
          }
        },
      },
    ).catch(() => {});

    // Proof B: writes y=30, writes x=40 (reading A's dirty 10), awaits A, fails
    const pB = (async () => {
      await aWroteX;
      await runProof(
        "proof-B",
        async (cB) => {
          await Deno.writeFile(fileY, new Uint8Array([30]));
          signalBWroteY();
          await Deno.writeFile(fileX, new Uint8Array([40]));
          signalBWroteX();
          await aWroteY;
          cB.check("fail B", false, "fail B");
        },
        {
          logger: () => {},
          rollbackHook: async (phase) => {
            if (phase === "start") {
              signalBInRollback();
              await rollbacksBarrier;
            }
          },
        },
      ).catch(() => {});
    })();

    // Wait until both proofs have entered their rollback phase
    await Promise.all([aInRollback, bInRollback]);
    // Release both rollbacks to overlap
    releaseRollbacks();

    await Promise.all([pA, pB]);

    // Both files must be restored to their original clean committed baselines [1] and [2]
    const finalX = await Deno.readFile(fileX);
    const finalY = await Deno.readFile(fileY);
    assertEquals(Array.from(finalX), [1]);
    assertEquals(Array.from(finalY), [2]);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: older passing proof committed write is restored when younger overwriting proof fails", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-older-pass-younger-fail-" });
  const file = `${rootDir}/shared.txt`;
  const initialBytes = new Uint8Array([1, 1]);
  const proofABytes = new Uint8Array([10, 10]);
  const proofBBytes = new Uint8Array([99, 99]);

  await Deno.writeFile(file, initialBytes);

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A (older proof): writes shared file with proofABytes, waits for B to write, then passes
  const promiseA = (async () => {
    await runProof(
      "proof-older-A",
      async (cA) => {
        await Deno.writeFile(file, proofABytes);
        signalProofAWrote();
        // Wait for B to overwrite and pause
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): starts after A writes, overwrites shared file with proofBBytes, pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-B",
        async (cB) => {
          await Deno.writeFile(file, proofBBytes);
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Wait for Proof A to complete and commit its write
  await promiseA;

  // Unpause Proof B so it fails and enters rollback
  unpauseProofB();

  await promiseB;

  // Proof A's committed write must be restored, and Proof B's failed write must NOT remain on disk!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), Array.from(proofABytes));

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older passing proof append write is restored when younger overwriting proof fails", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-append-restore-" });
  const file = `${rootDir}/shared_append.txt`;
  // Start with X ([88])
  await Deno.writeFile(file, new Uint8Array([88]));

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A (older proof): appends Y ([89]), resulting in XY ([88, 89]), waits for B, passes
  const promiseA = (async () => {
    await runProof(
      "proof-older-A",
      async (cA) => {
        await Deno.writeFile(file, new Uint8Array([89]), { append: true });
        signalProofAWrote();
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): overwrites with Z ([90]), pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-B",
        async (cB) => {
          await Deno.writeFile(file, new Uint8Array([90]));
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // File must contain XY ([88, 89]), NOT just Y ([89]) and NOT Z ([90])!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), [88, 89]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: rejecting rollbackHook does not bypass rollback restoration", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-hook-reject-" });
  const file = `${rootDir}/test_hook.txt`;
  await Deno.writeFile(file, new Uint8Array([1, 2, 3]));

  await assertRejects(
    async () => {
      await runProof(
        "test-hook-reject",
        async (c) => {
          await Deno.writeFile(file, new Uint8Array([99, 99]));
          c.check("fail step", false, "deliberate fail");
        },
        {
          logger: () => {},
          rollbackHook: () => {
            throw new Error("Simulated rollbackHook rejection");
          },
        },
      );
    },
    Error,
    "deliberate fail",
  );

  // File must be rolled back to [1, 2, 3] despite the rejecting hook!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), [1, 2, 3]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older passing proof write through Deno.open handle is restored when younger overwriting proof fails", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-open-restore-" });
  const file = `${rootDir}/shared_open.txt`;
  await Deno.writeFile(file, new Uint8Array([1, 1]));

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A (older proof): opens file via Deno.open, writes [10, 10], closes handle, waits for B, passes
  const promiseA = (async () => {
    await runProof(
      "proof-older-open-A",
      async (cA) => {
        const handle = await Deno.open(file, { write: true });
        await handle.write(new Uint8Array([10, 10]));
        handle.close();
        signalProofAWrote();
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): overwrites with [99, 99], pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-B",
        async (cB) => {
          await Deno.writeFile(file, new Uint8Array([99, 99]));
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // File must contain [10, 10] written by Proof A's Deno.open handle, NOT Proof B's [99, 99]!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), [10, 10]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older passing proof write through subprocess command is restored when younger overwriting proof fails", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-subprocess-restore-" });
  const file = `${rootDir}/shared_cmd.txt`;
  await Deno.writeFile(file, new Uint8Array([1, 1]));

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A (older proof): writes to file via shell command redirect, waits for B, passes
  const promiseA = (async () => {
    await runProof(
      "proof-older-cmd-A",
      async (cA) => {
        const cmd = new Deno.Command("sh", {
          args: ["-c", `echo 'hello from A' > "${file}"`],
        });
        await cmd.output();
        signalProofAWrote();
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): overwrites with [99, 99], pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-B",
        async (cB) => {
          await Deno.writeFile(file, new Uint8Array([99, 99]));
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // File must contain "hello from A\n", NOT Proof B's [99, 99]!
  const finalContent = await Deno.readTextFile(file);
  assertEquals(finalContent.trim(), "hello from A");

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older passing proof renamed destination write is restored when younger overwriting proof fails", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-rename-restore-" });
  const fileSrc = `${rootDir}/src.txt`;
  const fileDest = `${rootDir}/shared_dest.txt`;
  await Deno.writeFile(fileDest, new Uint8Array([1, 1]));

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A (older proof): creates fileSrc with [10, 10], renames to fileDest, waits for B, passes
  const promiseA = (async () => {
    await runProof(
      "proof-older-rename-A",
      async (cA) => {
        await Deno.writeFile(fileSrc, new Uint8Array([10, 10]));
        await Deno.rename(fileSrc, fileDest);
        signalProofAWrote();
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): overwrites fileDest with [99, 99], pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-B",
        async (cB) => {
          await Deno.writeFile(fileDest, new Uint8Array([99, 99]));
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // fileDest must contain [10, 10] from Proof A's rename, NOT Proof B's [99, 99]!
  const finalContent = await Deno.readFile(fileDest);
  assertEquals(Array.from(finalContent), [10, 10]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older failing proof rollback waits for younger in-flight subprocess write without erasing it", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-subproc-inflight-" });
  const file = `${rootDir}/shared_sub.txt`;
  await Deno.writeFile(file, new Uint8Array([1, 1]));

  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });

  // Proof A (older proof): touches file, waits for B, then fails and enters rollback
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-older-A",
        async (cA) => {
          await Deno.writeFile(file, new Uint8Array([10, 10]));
          signalProofAWrote();
          await proofBWrote;
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B (younger proof): starts, spawns subprocess writing [77, 77] to file, pauses, passes
  const promiseB = (async () => {
    await proofAWrote;
    await runProof(
      "proof-younger-subproc-B",
      async (cB) => {
        const cmd = new Deno.Command("sh", {
          args: ["-c", `echo -n 'hello from younger subproc' > "${file}"`],
        });
        await cmd.output();
        signalProofBWrote();
        await proofBPaused; // wait for A to enter rollback and wait on in-flight write
        cB.check("pass B", true);
      },
      { logger: () => {} },
    );
  })();

  // Give older proof A time to enter rollback and block on Proof B's in-flight write
  await new Promise((r) => setTimeout(r, 50));
  unpauseProofB();

  await Promise.all([promiseA, promiseB]);

  // file must retain Proof B's subprocess output "hello from younger subproc"!
  const finalContent = await Deno.readTextFile(file);
  assertEquals(finalContent, "hello from younger subproc");

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older passing proof renamed directory children are restored when younger overwriting proof fails", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dir-rename-restore-" });
  const dirSrc = `${rootDir}/src_dir`;
  const dirDest = `${rootDir}/shared_dest_dir`;
  const childDest = `${dirDest}/child.txt`;

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A (older proof): creates dirSrc with child.txt [42, 42], renames to dirDest, waits for B, passes
  const promiseA = (async () => {
    await runProof(
      "proof-older-dir-rename-A",
      async (cA) => {
        await Deno.mkdir(dirSrc, { recursive: true });
        await Deno.writeFile(`${dirSrc}/child.txt`, new Uint8Array([42, 42]));
        await Deno.rename(dirSrc, dirDest);
        signalProofAWrote();
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): overwrites childDest with [99, 99], pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-B",
        async (cB) => {
          await Deno.writeFile(childDest, new Uint8Array([99, 99]));
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // childDest must contain [42, 42] from Proof A's renamed directory child, NOT Proof B's [99, 99]!
  const finalContent = await Deno.readFile(childDest);
  assertEquals(Array.from(finalContent), [42, 42]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: duplicate-name concurrent proofs isolate in-flight registrations by proofId", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dup-name-inflight-" });
  const file = `${rootDir}/shared_dup.txt`;
  await Deno.writeFile(file, new Uint8Array([1, 1]));

  let signalProof0Wrote!: () => void;
  const proof0Wrote = new Promise<void>((r) => {
    signalProof0Wrote = r;
  });
  let signalProof2Wrote!: () => void;
  const proof2Wrote = new Promise<void>((r) => {
    signalProof2Wrote = r;
  });
  let unpauseProof2!: () => void;
  const proof2Paused = new Promise<void>((r) => {
    unpauseProof2 = r;
  });

  // Proof 0 (older proof): touches file, then fails and enters rollback
  const promise0 = (async () => {
    try {
      await runProof(
        "proof-older-0",
        async (c0) => {
          await Deno.writeFile(file, new Uint8Array([10, 10]));
          signalProof0Wrote();
          await proof2Wrote;
          c0.check("fail 0", false, "deliberate fail 0");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof 1 and Proof 2 share the EXACT SAME proof name: "worker"
  // Proof 1 finishes quickly
  // Proof 2 registers in-flight write and pauses before passing
  const promiseWorkers = (async () => {
    await proof0Wrote;

    // Worker 1: same name "worker", finishes quickly
    await runProof(
      "worker",
      (c1) => {
        c1.check("pass 1", true);
      },
      { logger: () => {} },
    );

    // Worker 2: same name "worker", writes file and pauses
    await runProof(
      "worker",
      async (c2) => {
        await Deno.writeFile(file, new Uint8Array([88, 88]));
        signalProof2Wrote();
        await proof2Paused;
        c2.check("pass 2", true);
      },
      { logger: () => {} },
    );
  })();

  // Give older proof 0 time to enter rollback and block on Worker 2's in-flight write
  await new Promise((r) => setTimeout(r, 60));
  unpauseProof2();

  await Promise.all([promise0, promiseWorkers]);

  // file must retain Worker 2's committed write [88, 88]!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), [88, 88]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed proof recreating source child after directory rename rolls back and deletes child", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-src-child-del-" });
  const dirSrc = `${rootDir}/src_dir`;
  const dirDest = `${rootDir}/dest_dir`;
  const srcChild = `${dirSrc}/child.txt`;

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A (older proof): creates src_dir/child.txt [11, 11], renames to dest_dir, waits for B, passes
  const promiseA = (async () => {
    await runProof(
      "proof-older-rename-src-A",
      async (cA) => {
        await Deno.mkdir(dirSrc, { recursive: true });
        await Deno.writeFile(srcChild, new Uint8Array([11, 11]));
        await Deno.rename(dirSrc, dirDest);
        signalProofAWrote();
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): recreates src_dir/child.txt with [99, 99], pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-recreate-B",
        async (cB) => {
          await Deno.mkdir(dirSrc, { recursive: true });
          await Deno.writeFile(srcChild, new Uint8Array([99, 99]));
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // srcChild must be deleted on rollback, NOT preserved from Proof A's pre-rename state!
  let srcChildExists = false;
  try {
    await Deno.lstat(srcChild);
    srcChildExists = true;
  } catch {
    srcChildExists = false;
  }
  assertEquals(srcChildExists, false);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: concurrent child write waits for directory rename and capture lock", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "evidence-2bfv-dir-lock-child-" });
  const dirSrc = `${rootDir}/src_dir`;
  const dirDest = `${rootDir}/dest_dir`;
  const childDest = `${dirDest}/child.txt`;

  await Deno.mkdir(dirSrc, { recursive: true });
  await Deno.writeFile(`${dirSrc}/child.txt`, new Uint8Array([33, 33]));

  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A: renames dirSrc -> dirDest and passes
  const promiseA = (async () => {
    await runProof(
      "proof-A-rename-dir",
      async (cA) => {
        await Deno.rename(dirSrc, dirDest);
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B concurrently attempts to overwrite childDest during/after rename
  const promiseB = (async () => {
    try {
      await runProof(
        "proof-B-write-child",
        async (cB) => {
          await Deno.writeFile(childDest, new Uint8Array([77, 77]));
          await proofBPaused;
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // childDest must contain [33, 33] from Proof A, NOT Proof B's [77, 77]!
  const finalContent = await Deno.readFile(childDest);
  assertEquals(Array.from(finalContent), [33, 33]);

  await Deno.remove(rootDir, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed proof creating directory and child then recursively removing directory deletes child on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-create-rm-dir-" });
  const dir = `${root}/created_dir`;
  const file = `${dir}/created_child.txt`;

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-create-rm-dir-fail",
          async (c) => {
            await Deno.mkdir(dir, { recursive: true });
            await Deno.writeFile(file, new Uint8Array([1, 2, 3]));
            await Deno.remove(dir, { recursive: true });
            c.check("fail", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // Both dir and file must be completely absent after rollback
    let dirExists = false;
    try {
      await Deno.lstat(dir);
      dirExists = true;
    } catch {
      dirExists = false;
    }
    assertEquals(dirExists, false);

    let fileExists = false;
    try {
      await Deno.lstat(file);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    assertEquals(fileExists, false);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: failed proof creating directory and child then renaming directory deletes child on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-create-rename-dir-" });
  const dirSrc = `${root}/src_dir`;
  const dirDest = `${root}/renamed_dir`;
  const fileSrc = `${dirSrc}/child.txt`;
  const fileDest = `${dirDest}/child.txt`;

  try {
    await assertRejects(
      async () => {
        await runProof(
          "test-create-rename-dir-fail",
          async (c) => {
            await Deno.mkdir(dirSrc, { recursive: true });
            await Deno.writeFile(fileSrc, new Uint8Array([1, 2, 3]));
            await Deno.rename(dirSrc, dirDest);
            c.check("fail", false, "deliberate failure");
          },
          { logger: () => {} },
        );
      },
      Error,
      "deliberate failure",
    );

    // dirSrc, dirDest, fileSrc, and fileDest must all be absent after rollback
    for (const p of [dirSrc, dirDest, fileSrc, fileDest]) {
      let exists = false;
      try {
        await Deno.lstat(p);
        exists = true;
      } catch {
        exists = false;
      }
      assertEquals(exists, false, `Path ${p} should not exist after rollback`);
    }
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("proof-helper: audio-feed-2bfv: failed proof recreating child removed recursively by earlier proof deletes child on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-rm-recreate-child-" });
  const parent = `${root}/parent_dir`;
  const child = `${parent}/child.txt`;

  // Proof A: creates parent and child, then recursively removes parent, passes and commits
  await runProof(
    "proof-A-create-and-rm",
    async (cA) => {
      await Deno.mkdir(parent, { recursive: true });
      await Deno.writeFile(child, new Uint8Array([1, 2, 3]));
      await Deno.remove(parent, { recursive: true });
      cA.check("pass A", true);
    },
    { logger: () => {} },
  );

  // Later Proof B: recreates parent and child, but fails
  try {
    await runProof(
      "proof-B-recreate-fail",
      async (cB) => {
        await Deno.mkdir(parent, { recursive: true });
        await Deno.writeFile(child, new Uint8Array([99, 99]));
        cB.check("fail B", false, "deliberate failure B");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // child and parent must be deleted by Proof B's rollback, NOT restored to Proof A's [1, 2, 3]!
  let childExists = false;
  try {
    await Deno.lstat(child);
    childExists = true;
  } catch {
    childExists = false;
  }
  assertEquals(childExists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed non-recursive remove does not mark child deleted", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-rm-" });
  const parent = `${root}/parent_dir`;
  const child = `${parent}/child.txt`;

  let signalProofAWrote!: () => void;
  const proofAWrote = new Promise<void>((r) => {
    signalProofAWrote = r;
  });
  let signalProofBWrote!: () => void;
  const proofBWrote = new Promise<void>((r) => {
    signalProofBWrote = r;
  });
  let unpauseProofB!: () => void;
  const proofBPaused = new Promise<void>((r) => {
    unpauseProofB = r;
  });

  // Proof A: writes child [11, 22], attempts non-recursive remove on non-empty parent (which throws),
  // waits for B, then passes and commits
  const promiseA = (async () => {
    await runProof(
      "proof-A-failed-rm",
      async (cA) => {
        await Deno.mkdir(parent, { recursive: true });
        await Deno.writeFile(child, new Uint8Array([11, 22]));
        // Attempt non-recursive remove of non-empty parent (fails)
        await Deno.remove(parent).catch(() => {});
        signalProofAWrote();
        await proofBWrote;
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B (younger proof): overwrites child with [99, 99], pauses, then fails
  const promiseB = (async () => {
    await proofAWrote;
    try {
      await runProof(
        "proof-younger-B",
        async (cB) => {
          await Deno.writeFile(child, new Uint8Array([99, 99]));
          signalProofBWrote();
          await proofBPaused; // wait for A to pass and commit
          cB.check("fail B", false, "deliberate fail B");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  await promiseA;
  unpauseProofB();
  await promiseB;

  // child must contain [11, 22] from Proof A, NOT be missing or left as Proof B's [99, 99]!
  const finalContent = await Deno.readFile(child);
  assertEquals(Array.from(finalContent), [11, 22]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed proof copying file to evidence path restores prior bytes or deletes file on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-copyfile-" });
  const src = `${root}/src.png`;
  const destNew = `${root}/dest_new.png`;
  const destExisting = `${root}/dest_existing.png`;

  await Deno.writeFile(src, new Uint8Array([1, 2, 3]));
  await Deno.writeFile(destExisting, new Uint8Array([10, 20, 30]));

  // Test async copyFile rollback
  try {
    await runProof(
      "test-copyfile-fail",
      async (c) => {
        await Deno.copyFile(src, destNew);
        await Deno.copyFile(src, destExisting);
        c.check("fail", false, "deliberate failure");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // destNew must be deleted
  let newExists = false;
  try {
    await Deno.lstat(destNew);
    newExists = true;
  } catch {
    newExists = false;
  }
  assertEquals(newExists, false);

  // destExisting must be restored to [10, 20, 30]
  const existingContent = await Deno.readFile(destExisting);
  assertEquals(Array.from(existingContent), [10, 20, 30]);

  // Test sync copyFileSync rollback
  try {
    await runProof(
      "test-copyfilesync-fail",
      (c) => {
        Deno.copyFileSync(src, destNew);
        Deno.copyFileSync(src, destExisting);
        c.check("fail", false, "deliberate failure");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  let newExistsSync = false;
  try {
    await Deno.lstat(destNew);
    newExistsSync = true;
  } catch {
    newExistsSync = false;
  }
  assertEquals(newExistsSync, false);

  const existingContentSync = await Deno.readFile(destExisting);
  assertEquals(Array.from(existingContentSync), [10, 20, 30]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: older proof overwriting younger committed file restores committed file on failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-intervene-commit-" });
  const file = `${root}/intervene.txt`;

  let signalProofAStarted!: () => void;
  const proofAStarted = new Promise<void>((r) => {
    signalProofAStarted = r;
  });
  let unpauseProofA!: () => void;
  const proofAPaused = new Promise<void>((r) => {
    unpauseProofA = r;
  });

  // Proof A (older proof): touches file when non-existent (null snapshot), pauses,
  // then overwrites with [99, 99] and fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-older-intervene-A",
        async (cA) => {
          // 1. Initial snapshot of non-existent file -> null snapshot
          await Deno.writeFile(file, new Uint8Array([11, 11]));
          signalProofAStarted();
          await proofAPaused; // wait for younger proof B to commit [44, 44]
          // 2. Overwrite file with [99, 99]
          await Deno.writeFile(file, new Uint8Array([99, 99]));
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B (younger proof): starts after A's initial write, commits [44, 44]
  await proofAStarted;
  await runProof(
    "proof-younger-intervene-B",
    async (cB) => {
      await Deno.writeFile(file, new Uint8Array([44, 44]));
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to overwrite and fail
  unpauseProofA();
  await promiseA;

  // File must contain [44, 44] committed by Proof B, NOT be deleted or left as [99, 99]!
  const finalContent = await Deno.readFile(file);
  assertEquals(Array.from(finalContent), [44, 44]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: pending waiter does not block re-entrant child lock acquisition by parent holder", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-waiter-reentrant-" });
  const parentDir = `${root}/parent`;
  const childFile = `${parentDir}/child.txt`;
  await Deno.mkdir(parentDir, { recursive: true });
  await Deno.writeFile(childFile, new Uint8Array([10, 10]));

  let signalAHeldParent!: () => void;
  const aHeldParent = new Promise<void>((r) => {
    signalAHeldParent = r;
  });
  let signalBQueuedParent!: () => void;
  const bQueuedParent = new Promise<void>((r) => {
    signalBQueuedParent = r;
  });

  let childAcquiredByA = false;
  let bCompletedAfterA = false;

  // Proof A: holds parentDir lock, and while Proof B is queued waiting for parentDir,
  // Proof A acquires childFile lock
  const promiseA = (async () => {
    await runProof(
      "proof-A-holder",
      async (cA) => {
        await proofPathLocks.withLock(parentDir, async () => {
          signalAHeldParent();
          await bQueuedParent; // wait until B is queued for parentDir
          // Now A acquires child lock while B is queued for parent - must succeed without deadlock!
          await proofPathLocks.withLock(childFile, () => {
            childAcquiredByA = true;
          });
        });
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B: attempts to lock parentDir while A holds it
  const promiseB = (async () => {
    await aHeldParent;
    const bRun = runProof(
      "proof-B-waiter",
      async (cB) => {
        await proofPathLocks.withLock(parentDir, () => {
          bCompletedAfterA = childAcquiredByA;
        });
        cB.check("pass B", true);
      },
      { logger: () => {} },
    );
    signalBQueuedParent();
    await bRun;
  })();

  await Promise.all([promiseA, promiseB]);

  assertEquals(childAcquiredByA, true);
  assertEquals(bCompletedAfterA, true);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: nested same-path lock acquisitions by same owner remain locked until final release", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-nested-same-path-" });
  const testFile = `${root}/nested.txt`;

  let signalAOuterAcquired!: () => void;
  const aOuterAcquired = new Promise<void>((r) => {
    signalAOuterAcquired = r;
  });
  let signalBQueued!: () => void;
  const bQueued = new Promise<void>((r) => {
    signalBQueued = r;
  });

  let aInnerReleased = false;
  let aOuterFinished = false;
  let bAcquiredWhileAOuterActive = false;

  // Proof A: acquires testFile, reacquires testFile (nested same-path), releases inner,
  // then pauses while Proof B is queued. B must NOT be able to acquire testFile while
  // A's outer lock is still active!
  const promiseA = (async () => {
    await runProof(
      "proof-A-nested-holder",
      async (cA) => {
        await proofPathLocks.withLock(testFile, async () => {
          signalAOuterAcquired();
          await bQueued; // wait for B to queue for testFile

          // Nested acquisition of exact same path by same owner
          await proofPathLocks.withLock(testFile, () => {
            // Inner scope work
          });
          aInnerReleased = true;

          // Pause while outer lock is still held:
          // If inner release deleted the lock map entry, B would acquire now!
          await new Promise((r) => setTimeout(r, 50));
          aOuterFinished = true;
        });
        cA.check("pass A", true);
      },
      { logger: () => {} },
    );
  })();

  // Proof B: attempts to acquire testFile while A holds it
  const promiseB = (async () => {
    await aOuterAcquired;
    const bRun = runProof(
      "proof-B-same-path-waiter",
      async (cB) => {
        signalBQueued();
        await proofPathLocks.withLock(testFile, () => {
          if (!aOuterFinished) {
            bAcquiredWhileAOuterActive = true;
          }
        });
        cB.check("pass B", true);
      },
      { logger: () => {} },
    );
    await bRun;
  })();

  await Promise.all([promiseA, promiseB]);

  assertEquals(aInnerReleased, true);
  assertEquals(aOuterFinished, true);
  assertEquals(bAcquiredWhileAOuterActive, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed operation does not publish committed record for un-mutated snapshotted path", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-no-falsy-commit-" });
  const destFile = `${root}/dest.txt`;

  let signalAWritten!: () => void;
  const aWritten = new Promise<void>((r) => {
    signalAWritten = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates destFile with [11, 11], pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-creator",
        async (cA) => {
          await Deno.writeFile(destFile, new Uint8Array([11, 11]));
          signalAWritten();
          await aPaused; // wait for Proof B to run
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: attempts to rename non-existent source onto destFile, catches error, and passes
  await aWritten;
  await runProof(
    "proof-B-failed-op",
    async (cB) => {
      try {
        await Deno.rename(`${root}/nonexistent-source.txt`, destFile);
      } catch {
        // caught - Proof B never mutated destFile!
      }
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // destFile was created by Proof A which failed; Proof B never actually mutated it.
  // Proof A's rollback must clean up destFile, NOT treat B as having committed it!
  let exists = false;
  try {
    await Deno.lstat(destFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: handle write refreshes snapshot baseline and restores later committed write on proof failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-handle-refresh-" });
  const testFile = `${root}/handle.txt`;

  let signalAOpened!: () => void;
  const aOpened = new Promise<void>((r) => {
    signalAOpened = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: opens writable handle to testFile, pauses while B writes and commits,
  // then writes [99, 99] through open handle and fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-handle-holder",
        async (cA) => {
          const handle = await Deno.open(testFile, { write: true, create: true });
          signalAOpened();
          await aPaused; // wait for B to commit [42, 42]

          // A writes [99, 99] through open handle
          await handle.write(new Uint8Array([99, 99]));
          handle.close();

          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: starts after A opened handle, writes and commits [42, 42]
  await aOpened;
  await runProof(
    "proof-B-committer",
    async (cB) => {
      await Deno.writeFile(testFile, new Uint8Array([42, 42]));
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause A to write [99, 99] and fail
  unpauseA();
  await promiseA;

  // File must contain [42, 42] committed by B, NOT [99, 99] from failed A!
  const finalBytes = await Deno.readFile(testFile);
  assertEquals(Array.from(finalBytes), [42, 42]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed mkdir attempt does not falsely commit existing directory on proof failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-mkdir-" });
  const dir = `${root}/created-dir`;

  let signalACreated!: () => void;
  const aCreated = new Promise<void>((r) => {
    signalACreated = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates dir, pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-mkdir-creator",
        async (cA) => {
          await Deno.mkdir(dir);
          signalACreated();
          await aPaused; // wait for Proof B
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: attempts to create same dir, catches AlreadyExists, passes
  await aCreated;
  await runProof(
    "proof-B-mkdir-failed",
    async (cB) => {
      try {
        await Deno.mkdir(dir);
      } catch {
        // caught AlreadyExists - Proof B never created dir!
      }
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // dir must be deleted on Proof A rollback, NOT preserved because of B!
  let exists = false;
  try {
    await Deno.lstat(dir);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: unmodified open and close of writable handle does not falsely commit created file", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-open-close-unmodified-" });
  const file = `${root}/created-file.txt`;

  let signalACreated!: () => void;
  const aCreated = new Promise<void>((r) => {
    signalACreated = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates file, pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-file-creator",
        async (cA) => {
          await Deno.writeFile(file, new Uint8Array([11, 11]));
          signalACreated();
          await aPaused; // wait for Proof B
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: opens file { write: true } and immediately closes it without writing, passes
  await aCreated;
  await runProof(
    "proof-B-open-close",
    async (cB) => {
      const handle = await Deno.open(file, { write: true });
      handle.close();
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // file must be deleted on Proof A rollback, NOT preserved because of B!
  let exists = false;
  try {
    await Deno.lstat(file);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: no-op recursive mkdir on existing directory does not falsely commit directory on proof failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-noop-mkdir-" });
  const dir = `${root}/noop-dir`;

  let signalACreated!: () => void;
  const aCreated = new Promise<void>((r) => {
    signalACreated = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates dir, pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-mkdir-creator",
        async (cA) => {
          await Deno.mkdir(dir);
          signalACreated();
          await aPaused; // wait for Proof B
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: calls mkdir with recursive: true on already existing dir (successful no-op), passes
  await aCreated;
  await runProof(
    "proof-B-mkdir-noop",
    async (cB) => {
      await Deno.mkdir(dir, { recursive: true });
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // dir must be deleted on Proof A rollback, NOT preserved because of B's no-op call!
  let exists = false;
  try {
    await Deno.lstat(dir);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed non-recursive remove does not falsely commit existing directory on proof failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-remove-" });
  const dir = `${root}/non-empty-dir`;
  const child = `${dir}/child.txt`;

  let signalACreated!: () => void;
  const aCreated = new Promise<void>((r) => {
    signalACreated = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates dir and child, pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-creator",
        async (cA) => {
          await Deno.mkdir(dir);
          await Deno.writeFile(child, new Uint8Array([1, 2]));
          signalACreated();
          await aPaused; // wait for Proof B
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: attempts non-recursive remove of non-empty dir, catches error, passes
  await aCreated;
  await runProof(
    "proof-B-remove-failed",
    async (cB) => {
      try {
        await Deno.remove(dir);
      } catch {
        // caught error
      }
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // dir and child must be deleted on Proof A rollback, NOT preserved because of B!
  let exists = false;
  try {
    await Deno.lstat(dir);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failing subprocess command does not falsely commit pre-existing un-mutated destination", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-subprocess-failed-" });
  const dest = `${root}/cmd-dest.txt`;

  let signalACreated!: () => void;
  const aCreated = new Promise<void>((r) => {
    signalACreated = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates dest with [10, 20], pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-cmd-creator",
        async (cA) => {
          await Deno.writeFile(dest, new Uint8Array([10, 20]));
          signalACreated();
          await aPaused; // wait for Proof B
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: runs a command pointing to dest that fails without mutating dest
  await aCreated;
  await runProof(
    "proof-B-cmd-failed",
    async (cB) => {
      const cmd = new Deno.Command("cp", {
        args: [`${root}/missing-source.txt`, dest],
      });
      const output = await cmd.output();
      assertEquals(output.success, false);
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // dest was created by Proof A which failed; Proof B never mutated it.
  // dest must be cleanly deleted on Proof A rollback!
  let exists = false;
  try {
    await Deno.lstat(dest);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess overwriting output with same size and mtime records mutation and preserves write on older proof rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-subprocess-same-meta-" });
  const dest = `${root}/same-meta-dest.txt`;
  const src = `${root}/source.txt`;

  // Source has same size (2 bytes) but different content [88, 88]
  await Deno.writeFile(src, new Uint8Array([88, 88]));

  let signalACreated!: () => void;
  const aCreated = new Promise<void>((r) => {
    signalACreated = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates dest with [11, 11] (2 bytes), pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-same-meta-creator",
        async (cA) => {
          await Deno.writeFile(dest, new Uint8Array([11, 11]));
          signalACreated();
          await aPaused; // wait for Proof B
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: runs cp -p src dest (replaces [11, 11] with [88, 88] preserving mtime and same size), passes
  await aCreated;
  // Match mtime of src to dest so cp -p preserves mtime
  const destStat = await Deno.lstat(dest);
  if (destStat.mtime) {
    await Deno.utime(src, destStat.mtime, destStat.mtime);
  }

  await runProof(
    "proof-B-same-meta-cp",
    async (cB) => {
      const cmd = new Deno.Command("cp", {
        args: ["-p", src, dest],
      });
      const output = await cmd.output();
      assertEquals(output.success, true);
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // dest must retain Proof B's committed write [88, 88], NOT be deleted by Proof A's rollback!
  const finalBytes = await Deno.readFile(dest);
  assertEquals(Array.from(finalBytes), [88, 88]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: cp to existing directory records effective child destination and preserves write on older proof rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-cp-to-dir-" });
  const targetDir = `${root}/target-dir`;
  await Deno.mkdir(targetDir, { recursive: true });
  const childFile = `${targetDir}/copied.txt`;
  const src = `${root}/copied.txt`;
  await Deno.writeFile(src, new Uint8Array([55, 66]));

  let signalACreated!: () => void;
  const aCreated = new Promise<void>((r) => {
    signalACreated = r;
  });
  let unpauseA!: () => void;
  const aPaused = new Promise<void>((r) => {
    unpauseA = r;
  });

  // Proof A: creates target-dir/copied.txt with [11, 22], pauses, then fails
  const promiseA = (async () => {
    try {
      await runProof(
        "proof-A-dir-child-creator",
        async (cA) => {
          await Deno.writeFile(childFile, new Uint8Array([11, 22]));
          signalACreated();
          await aPaused; // wait for Proof B
          cA.check("fail A", false, "deliberate fail A");
        },
        { logger: () => {} },
      );
    } catch { /* expected */ }
  })();

  // Proof B: runs cp src targetDir (copies src into targetDir/copied.txt with [55, 66]), passes
  await aCreated;
  await runProof(
    "proof-B-cp-to-dir",
    async (cB) => {
      const cmd = new Deno.Command("cp", {
        args: [src, targetDir],
      });
      const output = await cmd.output();
      assertEquals(output.success, true);
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // childFile must retain Proof B's committed write [55, 66], NOT be deleted by Proof A's rollback!
  const finalBytes = await Deno.readFile(childFile);
  assertEquals(Array.from(finalBytes), [55, 66]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: cp -r to existing directory snapshots descendants and rolls back created directory tree on proof failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-cpr-rollback-" });
  const srcTree = `${root}/src-tree`;
  const srcSub = `${srcTree}/sub`;
  const srcFile = `${srcSub}/leaf.txt`;
  await Deno.mkdir(srcSub, { recursive: true });
  await Deno.writeFile(srcFile, new Uint8Array([1, 2, 3]));

  const destDir = `${root}/dest-dir`;
  await Deno.mkdir(destDir, { recursive: true });
  const copiedTree = `${destDir}/src-tree`;
  const copiedFile = `${copiedTree}/sub/leaf.txt`;

  try {
    await runProof(
      "proof-cpr-failure",
      async (c) => {
        const cmd = new Deno.Command("cp", {
          args: ["-r", srcTree, destDir],
        });
        const res = await cmd.output();
        assertEquals(res.success, true);

        // Verify copied tree exists during proof
        const leafContent = await Deno.readFile(copiedFile);
        assertEquals(Array.from(leafContent), [1, 2, 3]);

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, copiedTree and all descendants must be cleanly removed by rollback!
  let exists = false;
  try {
    await Deno.lstat(copiedTree);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: cp -t dest source excludes dest operand from sources and does not snapshot dest/dest", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-cpt-exclude-" });
  const destDir = `${root}/dest`;
  await Deno.mkdir(destDir, { recursive: true });
  const srcFile = `${root}/item.txt`;
  await Deno.writeFile(srcFile, new Uint8Array([9, 9]));

  // Create an unrelated file with the same name as dest inside dest: dest/dest
  const unrelatedChild = `${destDir}/dest`;
  await Deno.writeFile(unrelatedChild, new Uint8Array([1, 1, 1]));

  try {
    await runProof(
      "proof-cpt-isolation",
      async (c) => {
        const cmd = new Deno.Command("cp", {
          args: ["-t", destDir, srcFile],
        });
        const res = await cmd.output();
        assertEquals(res.success, true);

        // Modify unrelatedChild directly during proof
        await Deno.writeFile(unrelatedChild, new Uint8Array([2, 2, 2]));

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // unrelatedChild was snapshotted by the writeFile, not erroneously treated as a cp destination of itself
  const unrelatedContent = await Deno.readFile(unrelatedChild);
  assertEquals(Array.from(unrelatedContent), [1, 1, 1]);

  // item.txt was copied into destDir/item.txt, which was created during proof and must be removed on failure
  let itemExists = false;
  try {
    await Deno.lstat(`${destDir}/item.txt`);
    itemExists = true;
  } catch {
    itemExists = false;
  }
  assertEquals(itemExists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: cp -r to existing destination tree does not overwrite concurrent external edits to unrelated destination children", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-cpr-external-" });
  const destDir = `${root}/existing-dest`;
  await Deno.mkdir(destDir, { recursive: true });
  const unrelatedFile = `${destDir}/unrelated.txt`;
  await Deno.writeFile(unrelatedFile, new Uint8Array([10, 20]));

  const srcTree = `${root}/src-tree`;
  await Deno.mkdir(srcTree, { recursive: true });
  const srcFile = `${srcTree}/leaf.txt`;
  await Deno.writeFile(srcFile, new Uint8Array([1, 2, 3]));

  try {
    await runProof(
      "proof-cpr-external",
      async (c) => {
        const cmd = new Deno.Command("cp", {
          args: ["-r", srcTree, destDir],
        });
        const res = await cmd.output();
        assertEquals(res.success, true);

        // Verify that unrelatedFile was NOT snapshotted by cp -r
        const active = getActiveProof();
        assertEquals(active?.snapshots.has(unrelatedFile), false);

        // Simulate external edit to unrelated file in destDir while proof is running
        await originalWriteFile(unrelatedFile, new Uint8Array([99, 99]));

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, unrelatedFile must retain the external edit [99, 99], NOT be overwritten by rollback!
  const finalUnrelated = await Deno.readFile(unrelatedFile);
  assertEquals(Array.from(finalUnrelated), [99, 99]);

  // Copied tree leaf must be cleaned up
  let copiedExists = false;
  try {
    await Deno.lstat(`${destDir}/src-tree/leaf.txt`);
    copiedExists = true;
  } catch {
    copiedExists = false;
  }
  assertEquals(copiedExists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: cp -rT copies source contents directly and restores overwritten leaf on failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-cprt-overwritten-" });
  const destDir = `${root}/dest-dir`;
  await Deno.mkdir(destDir, { recursive: true });
  const destLeaf = `${destDir}/leaf.txt`;
  await Deno.writeFile(destLeaf, new Uint8Array([1, 1, 1]));

  const srcDir = `${root}/src-dir`;
  await Deno.mkdir(srcDir, { recursive: true });
  const srcLeaf = `${srcDir}/leaf.txt`;
  await Deno.writeFile(srcLeaf, new Uint8Array([2, 2, 2]));

  try {
    await runProof(
      "proof-cprt-failure",
      async (c) => {
        const cmd = new Deno.Command("cp", {
          args: ["-rT", srcDir, destDir],
        });
        const res = await cmd.output();
        assertEquals(res.success, true);

        const currentLeaf = await Deno.readFile(destLeaf);
        assertEquals(Array.from(currentLeaf), [2, 2, 2]);

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, destLeaf must be restored to its pre-proof bytes [1, 1, 1]!
  const restoredLeaf = await Deno.readFile(destLeaf);
  assertEquals(Array.from(restoredLeaf), [1, 1, 1]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed non-recursive remove does not snapshot descendants and preserves concurrent external edits on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-remove-" });
  const parentDir = `${root}/non-empty-dir`;
  await Deno.mkdir(parentDir, { recursive: true });
  const childFile = `${parentDir}/child.txt`;
  await Deno.writeFile(childFile, new Uint8Array([1, 2, 3]));

  try {
    await runProof(
      "proof-failed-remove-external",
      async (c) => {
        // Attempt non-recursive remove of non-empty directory; must fail/throw
        let threw = false;
        try {
          await Deno.remove(parentDir);
        } catch {
          threw = true;
        }
        assertEquals(threw, true);

        // Verify childFile was NOT snapshotted
        const active = getActiveProof();
        assertEquals(active?.snapshots.has(childFile), false);

        // Simulate external edit to childFile while proof is running
        await originalWriteFile(childFile, new Uint8Array([99, 99]));

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, childFile must retain the external edit [99, 99], NOT be rolled back to [1, 2, 3]!
  const finalBytes = await Deno.readFile(childFile);
  assertEquals(Array.from(finalBytes), [99, 99]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: partial recursive remove retains snapshots for deleted children and restores them on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-partial-remove-" });
  const tree = `${root}/tree`;
  await Deno.mkdir(tree, { recursive: true });

  // child1 is directly in tree and will be unlinked first
  const child1 = `${tree}/child1.txt`;
  await Deno.writeFile(child1, new Uint8Array([11, 22]));

  // protected dir has child2; making protected dir read-only prevents unlinking child2
  const protectedDir = `${tree}/protected`;
  await Deno.mkdir(protectedDir, { recursive: true });
  const child2 = `${protectedDir}/child2.txt`;
  await Deno.writeFile(child2, new Uint8Array([33, 44]));
  await Deno.chmod(protectedDir, 0o555);

  try {
    await runProof(
      "proof-partial-remove",
      async (c) => {
        // Attempt recursive removal; on Linux, unlinking inside read-only directory throws PermissionDenied
        let threw = false;
        try {
          await Deno.remove(tree, { recursive: true });
        } catch {
          threw = true;
        }
        assertEquals(threw, true);

        // child1 was actually removed before the failure occurred
        let child1ExistsDuringProof = false;
        try {
          await Deno.lstat(child1);
          child1ExistsDuringProof = true;
        } catch {
          child1ExistsDuringProof = false;
        }
        assertEquals(child1ExistsDuringProof, false);

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch {
    /* expected */
  } finally {
    // Restore permissions so cleanup succeeds
    await Deno.chmod(protectedDir, 0o755).catch(() => {});
  }

  // On proof failure, child1 must be restored by rollback to its original bytes [11, 22]!
  const restoredBytes1 = await Deno.readFile(child1);
  assertEquals(Array.from(restoredBytes1), [11, 22]);

  // child2 and protectedDir also still exist
  const remainingBytes2 = await Deno.readFile(child2);
  assertEquals(Array.from(remainingBytes2), [33, 44]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: recursive remove records absence for all snapshotted descendants and preserves committed deletion on older proof rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-recursive-del-" });
  const tree = `${root}/tree`;
  await Deno.mkdir(tree, { recursive: true });
  const child = `${tree}/child.txt`;
  await Deno.writeFile(child, new Uint8Array([10, 20]));

  let unpauseA: () => void = () => {};
  const pausePromiseA = new Promise<void>((resolve) => {
    unpauseA = resolve;
  });
  let aStarted: () => void = () => {};
  const aStartedPromise = new Promise<void>((resolve) => {
    aStarted = resolve;
  });

  // Proof A writes to child and pauses before finishing
  const promiseA = assertRejects(
    async () => {
      await runProof(
        "proof-a-write-child",
        async (cA) => {
          await Deno.writeFile(child, new Uint8Array([55, 66]));
          aStarted();
          await pausePromiseA;
          cA.check("fail deliberate A", false, "force rollback A");
        },
        { logger: () => {} },
      );
    },
    Error,
    "force rollback A",
  );

  await aStartedPromise;

  // Proof B (younger) recursively removes tree without having modified child beforehand, and passes
  await runProof(
    "proof-b-remove-tree",
    async (cB) => {
      await Deno.remove(tree, { recursive: true });
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // Proof B's committed recursive removal of child must be preserved! child must NOT be restored by Proof A!
  let childExists = false;
  try {
    await Deno.lstat(child);
    childExists = true;
  } catch {
    childExists = false;
  }
  assertEquals(childExists, false);

  let treeExists = false;
  try {
    await Deno.lstat(tree);
    treeExists = true;
  } catch {
    treeExists = false;
  }
  assertEquals(treeExists, false);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: directory rename records absence for all snapshotted source descendants and preserves committed move on older proof rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-rename-del-" });
  const oldTree = `${root}/old-tree`;
  await Deno.mkdir(oldTree, { recursive: true });
  const child = `${oldTree}/child.txt`;
  await Deno.writeFile(child, new Uint8Array([10, 20]));
  const newTree = `${root}/new-tree`;
  const movedChild = `${newTree}/child.txt`;

  let unpauseA: () => void = () => {};
  const pausePromiseA = new Promise<void>((resolve) => {
    unpauseA = resolve;
  });
  let aStarted: () => void = () => {};
  const aStartedPromise = new Promise<void>((resolve) => {
    aStarted = resolve;
  });

  // Proof A writes to child and pauses before finishing
  const promiseA = assertRejects(
    async () => {
      await runProof(
        "proof-a-write-child-rename",
        async (cA) => {
          await Deno.writeFile(child, new Uint8Array([55, 66]));
          aStarted();
          await pausePromiseA;
          cA.check("fail deliberate A", false, "force rollback A");
        },
        { logger: () => {} },
      );
    },
    Error,
    "force rollback A",
  );

  await aStartedPromise;

  // Proof B (younger) renames oldTree to newTree without modifying child beforehand, and passes
  await runProof(
    "proof-b-rename-tree",
    async (cB) => {
      await Deno.rename(oldTree, newTree);
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // Proof B's committed rename must be preserved! child under oldTree must NOT be restored by Proof A!
  let oldChildExists = false;
  try {
    await Deno.lstat(child);
    oldChildExists = true;
  } catch {
    oldChildExists = false;
  }
  assertEquals(oldChildExists, false);

  let oldTreeExists = false;
  try {
    await Deno.lstat(oldTree);
    oldTreeExists = true;
  } catch {
    oldTreeExists = false;
  }
  assertEquals(oldTreeExists, false);

  // newTree/child.txt must exist with the moved bytes [55, 66]
  const movedBytes = await Deno.readFile(movedChild);
  assertEquals(Array.from(movedBytes), [55, 66]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed removal of already absent path does not publish false deletion (async and sync)", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-absent-" });

  // 1. Async Deno.remove
  const fileAsync = `${root}/async.txt`;
  await Deno.writeFile(fileAsync, new Uint8Array([1, 2, 3]));

  let unpauseA: () => void = () => {};
  const pausePromiseA = new Promise<void>((resolve) => {
    unpauseA = resolve;
  });
  let aStarted: () => void = () => {};
  const aStartedPromise = new Promise<void>((resolve) => {
    aStarted = resolve;
  });

  const promiseA = assertRejects(
    async () => {
      await runProof(
        "proof-a-remove-pause",
        async (cA) => {
          await Deno.remove(fileAsync);
          aStarted();
          await pausePromiseA;
          cA.check("fail deliberate A", false, "force rollback A");
        },
        { logger: () => {} },
      );
    },
    Error,
    "force rollback A",
  );

  await aStartedPromise;

  // Proof B (younger) attempts to remove already absent file, catches NotFound, and passes
  await runProof(
    "proof-b-catch-notfound",
    async (cB) => {
      let caught = false;
      try {
        await Deno.remove(fileAsync);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) caught = true;
      }
      assertEquals(caught, true);
      cB.check("pass B", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof A to fail and roll back
  unpauseA();
  await promiseA;

  // Proof A's rollback must restore fileAsync, NOT skip it due to a false deletion by Proof B!
  const restoredAsync = await Deno.readFile(fileAsync);
  assertEquals(Array.from(restoredAsync), [1, 2, 3]);

  // 2. Sync Deno.removeSync
  const fileSync = `${root}/sync.txt`;
  await Deno.writeFile(fileSync, new Uint8Array([4, 5, 6]));

  let unpauseC: () => void = () => {};
  const pausePromiseC = new Promise<void>((resolve) => {
    unpauseC = resolve;
  });
  let cStarted: () => void = () => {};
  const cStartedPromise = new Promise<void>((resolve) => {
    cStarted = resolve;
  });

  const promiseC = assertRejects(
    async () => {
      await runProof(
        "proof-c-remove-pause",
        async (cC) => {
          Deno.removeSync(fileSync);
          cStarted();
          await pausePromiseC;
          cC.check("fail deliberate C", false, "force rollback C");
        },
        { logger: () => {} },
      );
    },
    Error,
    "force rollback C",
  );

  await cStartedPromise;

  // Proof D (younger) attempts to remove already absent file via removeSync, catches NotFound, and passes
  await runProof(
    "proof-d-catch-notfound",
    async (cD) => {
      await Promise.resolve();
      let caught = false;
      try {
        Deno.removeSync(fileSync);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) caught = true;
      }
      assertEquals(caught, true);
      cD.check("pass D", true);
    },
    { logger: () => {} },
  );

  // Unpause Proof C to fail and roll back
  unpauseC();
  await promiseC;

  // Proof C's rollback must restore fileSync, NOT skip it due to a false deletion by Proof D!
  const restoredSync = await Deno.readFile(fileSync);
  assertEquals(Array.from(restoredSync), [4, 5, 6]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed rename discards snapshots and preserves concurrent external edits on rollback (async and sync)", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-rename-" });

  const destAsync = `${root}/dest-async.txt`;
  await Deno.writeFile(destAsync, new Uint8Array([1, 2, 3]));
  const absentSourceAsync = `${root}/absent-source-async.txt`;

  const destSync = `${root}/dest-sync.txt`;
  await Deno.writeFile(destSync, new Uint8Array([4, 5, 6]));
  const absentSourceSync = `${root}/absent-source-sync.txt`;

  try {
    await runProof(
      "proof-failed-rename-external",
      async (c) => {
        // 1. Async failed rename
        let asyncThrew = false;
        try {
          await Deno.rename(absentSourceAsync, destAsync);
        } catch {
          asyncThrew = true;
        }
        assertEquals(asyncThrew, true);

        // Verify destAsync snapshot was discarded
        const active = getActiveProof();
        assertEquals(active?.snapshots.has(destAsync), false);

        // Simulate external edit to destAsync
        await originalWriteFile(destAsync, new Uint8Array([99, 99]));

        // 2. Sync failed rename
        let syncThrew = false;
        try {
          Deno.renameSync(absentSourceSync, destSync);
        } catch {
          syncThrew = true;
        }
        assertEquals(syncThrew, true);

        // Verify destSync snapshot was discarded
        assertEquals(active?.snapshots.has(destSync), false);

        // Simulate external edit to destSync
        await originalWriteFile(destSync, new Uint8Array([88, 88]));

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, rollback must NOT overwrite the external edits with stale snapshots!
  const finalAsync = await Deno.readFile(destAsync);
  assertEquals(Array.from(finalAsync), [99, 99]);

  const finalSync = await Deno.readFile(destSync);
  assertEquals(Array.from(finalSync), [88, 88]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed copyFile and copyFileSync discard snapshots and preserve concurrent external edits on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-copy-" });

  // 1. Async Deno.copyFile
  const destAsync = `${root}/dest-async.txt`;
  await Deno.writeFile(destAsync, new Uint8Array([1, 2, 3]));
  const absentSourceAsync = `${root}/absent-source-async.txt`;

  // 2. Sync Deno.copyFileSync
  const destSync = `${root}/dest-sync.txt`;
  await Deno.writeFile(destSync, new Uint8Array([4, 5, 6]));
  const absentSourceSync = `${root}/absent-source-sync.txt`;

  try {
    await runProof(
      "proof-failed-copy-external",
      async (c) => {
        // Attempt async copy from nonexistent source to existing destination; must fail/throw
        let asyncThrew = false;
        try {
          await Deno.copyFile(absentSourceAsync, destAsync);
        } catch {
          asyncThrew = true;
        }
        assertEquals(asyncThrew, true);

        // Verify destAsync snapshot was discarded
        const active = getActiveProof();
        assertEquals(active?.snapshots.has(destAsync), false);

        // Simulate external edit to destAsync
        await originalWriteFile(destAsync, new Uint8Array([99, 99]));

        // Attempt sync copy from nonexistent source to existing destination; must fail/throw
        let syncThrew = false;
        try {
          Deno.copyFileSync(absentSourceSync, destSync);
        } catch {
          syncThrew = true;
        }
        assertEquals(syncThrew, true);

        // Verify destSync snapshot was discarded
        assertEquals(active?.snapshots.has(destSync), false);

        // Simulate external edit to destSync
        await originalWriteFile(destSync, new Uint8Array([88, 88]));

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, destinations must retain external edits [99, 99] and [88, 88]!
  const finalAsync = await Deno.readFile(destAsync);
  assertEquals(Array.from(finalAsync), [99, 99]);

  const finalSync = await Deno.readFile(destSync);
  assertEquals(Array.from(finalSync), [88, 88]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed cp command discards destination snapshot and preserves concurrent external edits on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-failed-cp-" });
  const dest = `${root}/dest.txt`;
  await Deno.writeFile(dest, new Uint8Array([1, 2, 3]));
  const absentSource = `${root}/absent-source.txt`;

  try {
    await runProof(
      "proof-failed-cp-external",
      async (c) => {
        // Run cp from nonexistent source to existing destination; command fails
        const cmd = new Deno.Command("cp", {
          args: [absentSource, dest],
        });
        const out = await cmd.output();
        assertEquals(out.code !== 0, true);

        // Verify dest snapshot was discarded because destination was not mutated
        const active = getActiveProof();
        assertEquals(active?.snapshots.has(dest), false);

        // Simulate concurrent external edit to dest
        await originalWriteFile(dest, new Uint8Array([77, 77, 77]));

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, destination must retain external edit [77, 77, 77] and NOT be overwritten!
  const finalBytes = await Deno.readFile(dest);
  assertEquals(Array.from(finalBytes), [77, 77, 77]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: copy error with partially modified destination retains snapshot and restores original bytes on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-partial-copy-" });
  const destAsync = `${root}/dest-async.txt`;
  await Deno.writeFile(destAsync, new Uint8Array([1, 2, 3]));
  const srcAsync = `${root}/src-async.txt`;
  await Deno.writeFile(srcAsync, new Uint8Array([9, 9, 9]));

  const destSync = `${root}/dest-sync.txt`;
  await Deno.writeFile(destSync, new Uint8Array([4, 5, 6]));
  const srcSync = `${root}/src-sync.txt`;
  await Deno.writeFile(srcSync, new Uint8Array([8, 8, 8]));

  // Mock originalCopyFile to write dirty bytes to dest before throwing
  const prevCopyFile = originalCopyFile;
  const prevCopyFileSync = originalCopyFileSync;

  try {
    setOriginalCopyFileForTesting(async (_from, to) => {
      // Simulate partial write before error
      await originalWriteFile(String(to), new Uint8Array([9, 9, 9, 9]));
      throw new Error("Simulated I/O error during copyFile");
    });
    setOriginalCopyFileSyncForTesting((_from, to) => {
      // Simulate partial write before error
      Deno.writeFileSync(String(to), new Uint8Array([8, 8, 8, 8]));
      throw new Error("Simulated I/O error during copyFileSync");
    });

    await runProof(
      "proof-partial-copy-retained",
      async (c) => {
        let asyncThrew = false;
        try {
          await Deno.copyFile(srcAsync, destAsync);
        } catch {
          asyncThrew = true;
        }
        assertEquals(asyncThrew, true);

        // Verify destAsync snapshot was RETAINED because destination was modified
        const active = getActiveProof();
        assertEquals(active?.snapshots.has(destAsync), true);

        let syncThrew = false;
        try {
          Deno.copyFileSync(srcSync, destSync);
        } catch {
          syncThrew = true;
        }
        assertEquals(syncThrew, true);

        // Verify destSync snapshot was RETAINED because destination was modified
        assertEquals(active?.snapshots.has(destSync), true);

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch {
    /* expected */
  } finally {
    setOriginalCopyFileForTesting(prevCopyFile);
    setOriginalCopyFileSyncForTesting(prevCopyFileSync);
  }

  // Rollback must restore original bytes [1, 2, 3] and [4, 5, 6], cleaning up the dirty partial writes!
  const finalAsync = await Deno.readFile(destAsync);
  assertEquals(Array.from(finalAsync), [1, 2, 3]);

  const finalSync = await Deno.readFile(destSync);
  assertEquals(Array.from(finalSync), [4, 5, 6]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: repeated Deno.Command execution preserves snapshot and restores original bytes on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-repeat-cmd-" });
  const dest = `${root}/dest.txt`;
  await Deno.writeFile(dest, new Uint8Array([1, 2, 3]));
  const src = `${root}/src.txt`;
  await Deno.writeFile(src, new Uint8Array([9, 9, 9]));

  try {
    await runProof(
      "proof-repeated-command-rollback",
      async (c) => {
        // Instantiate single Command instance
        const cmd = new Deno.Command("cp", {
          args: [src, dest],
        });

        // First run: mutates dest to [9, 9, 9]
        const out1 = await cmd.output();
        assertEquals(out1.code, 0);
        assertEquals(Array.from(await Deno.readFile(dest)), [9, 9, 9]);

        // Second run with the EXACT SAME command instance: copies identical bytes
        const out2 = await cmd.output();
        assertEquals(out2.code, 0);
        assertEquals(Array.from(await Deno.readFile(dest)), [9, 9, 9]);

        // Verify snapshot for dest was NOT discarded by the second run
        const active = getActiveProof();
        assertEquals(active?.snapshots.has(dest), true);

        c.check("fail deliberate", false, "force rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, rollback must restore dest to original bytes [1, 2, 3]!
  const finalBytes = await Deno.readFile(dest);
  assertEquals(Array.from(finalBytes), [1, 2, 3]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: parent directory rollback and multi-step child writer do not deadlock", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-parent-rollback-multi-" });
  const parentDir = `${root}/parent`;
  const child1 = `${parentDir}/child1.txt`;
  const child2 = `${parentDir}/child2.txt`;

  // Pre-seed parent directory with initial state
  await Deno.mkdir(parentDir, { recursive: true });

  const proofBWroteChild1 = Promise.withResolvers<void>();
  const proofARollbackHoldingParent = Promise.withResolvers<void>();

  // Proof B: writes child1, waits for Proof A to enter directory rollback, then writes child2 and passes
  const proofBPromise = runProof(
    "proof-b-multi-writer",
    async (c) => {
      // Step 1: Write child1 (registered in inFlightProofWrites)
      await Deno.writeFile(child1, new Uint8Array([1, 1, 1]));
      proofBWroteChild1.resolve();

      // Wait until Proof A's rollback has acquired the lock on parentDir
      await proofARollbackHoldingParent.promise;

      // Step 2: Write child2 under parent while Proof A's parentDir lock was acquired
      await Deno.writeFile(child2, new Uint8Array([2, 2, 2]));
      c.check("proof B completed", true);
    },
    { logger: () => {} },
  );

  // Wait until Proof B has written child1
  await proofBWroteChild1.promise;

  // Proof A: touches parentDir in its own transaction, fails, and triggers rollback
  const proofAPromise = (async () => {
    try {
      await runProof(
        "proof-a-parent-restore",
        async (c) => {
          // Proof A snapshots parentDir by touching it
          await Deno.remove(parentDir, { recursive: true });
          await Deno.mkdir(parentDir);
          c.check("fail deliberate", false, "trigger rollback");
        },
        {
          logger: () => {},
          rollbackHook: async (phase, path) => {
            if (phase === "lock-acquired" && path === parentDir) {
              // Signal Proof B that Proof A is actively holding the lock on parentDir!
              proofARollbackHoldingParent.resolve();
              // Pause inside parentDir lock to guarantee Proof B attempts write while lock is held
              await new Promise((r) => setTimeout(r, 40));
            }
          },
        },
      );
    } catch { /* expected fail A */ }
  })();

  // Both must complete cleanly without deadlocking!
  await Promise.all([proofAPromise, proofBPromise]);

  // child1 and child2 retain Proof B's committed writes
  const c1 = await Deno.readFile(child1);
  assertEquals(Array.from(c1), [1, 1, 1]);
  const c2 = await Deno.readFile(child2);
  assertEquals(Array.from(c2), [2, 2, 2]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: subprocess write through shell environment variable target restores original bytes on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-shell-env-var-" });
  const file1 = `${root}/file1.txt`;
  await Deno.writeFile(file1, new Uint8Array([1, 2, 3]));

  const file2 = `${root}/file2.txt`;
  await Deno.writeFile(file2, new Uint8Array([4, 5, 6]));

  try {
    await runProof(
      "proof-shell-env-var-rollback",
      async (c) => {
        // 1. Redirect to "$OUT1" with options.env
        const cmd1 = new Deno.Command("sh", {
          args: ["-c", 'printf "dirty1" > "$OUT1"'],
          env: { OUT1: file1 },
        });
        const out1 = await cmd1.output();
        assertEquals(out1.code, 0);
        assertEquals(new TextDecoder().decode(await Deno.readFile(file1)), "dirty1");

        // 2. Redirect to "${OUT2}" via process env
        // audio-feed-lnnjd audit: the mutated name is invented for this test and
        // its ONLY reader is the child this test spawns (grep: EVIDENCE_TEST_OUT2
        // appears nowhere else in src/, scripts/, tests/), so no concurrently
        // running module can observe the set/delete window. The env read by the
        // child is the behavior under test, so no seam applies.
        Deno.env.set("EVIDENCE_TEST_OUT2", file2);
        try {
          const cmd2 = new Deno.Command("sh", {
            args: ["-c", 'printf "dirty2" > "${EVIDENCE_TEST_OUT2}"'],
          });
          const out2 = await cmd2.output();
          assertEquals(out2.code, 0);
          assertEquals(new TextDecoder().decode(await Deno.readFile(file2)), "dirty2");
        } finally {
          Deno.env.delete("EVIDENCE_TEST_OUT2");
        }

        c.check("fail deliberate", false, "trigger rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, rollback must restore file1 and file2 to original bytes!
  const final1 = await Deno.readFile(file1);
  assertEquals(Array.from(final1), [1, 2, 3]);

  const final2 = await Deno.readFile(file2);
  assertEquals(Array.from(final2), [4, 5, 6]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell single quotes preserve literal target without expanding variable", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-shell-single-quote-" });
  const envFile = `${root}/env-target.txt`;
  await Deno.writeFile(envFile, new Uint8Array([10, 20, 30]));

  const literalFile = `${root}/$OUT`;
  await Deno.writeFile(literalFile, new Uint8Array([7, 8, 9]));

  try {
    await runProof(
      "proof-shell-single-quote-literal",
      async (c) => {
        // sh -c with single quotes: > '$OUT' writes to literal file $OUT in cwd
        const cmd = new Deno.Command("sh", {
          args: ["-c", "printf dirty > '$OUT'"],
          cwd: root,
          env: { OUT: envFile },
        });
        const out = await cmd.output();
        assertEquals(out.code, 0);
        // Literal file $OUT has "dirty"
        assertEquals(new TextDecoder().decode(await Deno.readFile(literalFile)), "dirty");
        // envFile is untouched
        assertEquals(Array.from(await Deno.readFile(envFile)), [10, 20, 30]);

        c.check("fail deliberate", false, "trigger rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, literal file $OUT must be restored to [7, 8, 9]
  const finalLiteral = await Deno.readFile(literalFile);
  assertEquals(Array.from(finalLiteral), [7, 8, 9]);

  // envFile must remain untouched
  const finalEnv = await Deno.readFile(envFile);
  assertEquals(Array.from(finalEnv), [10, 20, 30]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: direct command arguments do not perform shell variable expansion", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-direct-args-no-expand-" });
  const envFile = `${root}/env-target.txt`;
  await Deno.writeFile(envFile, new Uint8Array([10, 20, 30]));

  const literalFile = `${root}/$OUT`;
  await Deno.writeFile(literalFile, new Uint8Array([7, 8, 9]));

  try {
    await runProof(
      "proof-direct-args-no-expand",
      async (c) => {
        // Direct command (e.g. cp) with literal "$OUT" argument and cwd: root
        const cmd = new Deno.Command("cp", {
          args: [envFile, "$OUT"],
          cwd: root,
          env: { OUT: envFile },
        });
        const out = await cmd.output();
        assertEquals(out.code, 0);

        // Literal file $OUT received the copy
        assertEquals(Array.from(await Deno.readFile(literalFile)), [10, 20, 30]);

        c.check("fail deliberate", false, "trigger rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On rollback, literalFile is restored
  const finalLiteral = await Deno.readFile(literalFile);
  assertEquals(Array.from(finalLiteral), [7, 8, 9]);

  // envFile must remain untouched
  const finalEnv = await Deno.readFile(envFile);
  assertEquals(Array.from(finalEnv), [10, 20, 30]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: mixed literal and variable shell redirect target restores original bytes on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-mixed-shell-var-" });
  const subDir = `${root}/subdir`;
  await Deno.mkdir(subDir, { recursive: true });
  const targetFile = `${subDir}/evidence.txt`;
  await Deno.writeFile(targetFile, new Uint8Array([100, 101, 102]));

  try {
    await runProof(
      "proof-mixed-shell-var-rollback",
      async (c) => {
        const cmd = new Deno.Command("sh", {
          args: ["-c", 'printf "dirty-mixed" > "$DIR/evidence.txt"'],
          env: { DIR: subDir },
        });
        const out = await cmd.output();
        assertEquals(out.code, 0);
        assertEquals(new TextDecoder().decode(await Deno.readFile(targetFile)), "dirty-mixed");

        c.check("fail deliberate", false, "trigger rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, targetFile must be restored to original bytes!
  const finalContent = await Deno.readFile(targetFile);
  assertEquals(Array.from(finalContent), [100, 101, 102]);

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell redirect across quoted and unquoted segments cleans up newly created file on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-quoted-unquoted-new-" });
  const subDir = `${root}/subdir`;
  await Deno.mkdir(subDir, { recursive: true });
  const newFile = `${subDir}/new.txt`;

  try {
    await runProof(
      "proof-quoted-unquoted-new-rollback",
      async (c) => {
        // Redirect: > "$DIR"/new.txt with quoted $DIR followed by unquoted /new.txt
        const cmd = new Deno.Command("sh", {
          args: ["-c", 'printf "created-data" > "$DIR"/new.txt'],
          env: { DIR: subDir },
        });
        const out = await cmd.output();
        assertEquals(out.code, 0);
        assertEquals(new TextDecoder().decode(await Deno.readFile(newFile)), "created-data");

        c.check("fail deliberate", false, "trigger rollback");
      },
      { logger: () => {} },
    );
  } catch { /* expected */ }

  // On proof failure, newFile must be completely cleaned up (removed)!
  let exists = false;
  try {
    await Deno.lstat(newFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false, "newly created file at '$DIR'/new.txt must be removed on rollback");

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell redirect with unset environment variable treats variable as empty and cleans up on rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-unset-var-" });
  const newFile = `${root}/new_from_unset.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "proof-unset-var-rollback",
        async (c) => {
          // Redirect: > "$UNSET_VAR_TEST"new_from_unset.txt where UNSET_VAR_TEST is unset in env
          const cmd = new Deno.Command("sh", {
            args: ["-c", 'printf "created-unset" > "$UNSET_VAR_TEST"new_from_unset.txt'],
            cwd: root,
          });
          const out = await cmd.output();
          assertEquals(out.code, 0);
          assertEquals(new TextDecoder().decode(await Deno.readFile(newFile)), "created-unset");

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  let exists = false;
  try {
    await Deno.lstat(newFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(
    exists,
    false,
    "newly created file at '$UNSET'new_from_unset.txt must be removed on rollback",
  );

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell redirect in double quotes preserves backslash before ordinary characters", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-slash-preserve-" });
  const newFile = `${root}/a\\q.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "proof-slash-preserve-rollback",
        async (c) => {
          // Redirect: > "a\q.txt" in shell double quotes preserves \q as literal \q
          const cmd = new Deno.Command("sh", {
            args: ["-c", 'printf "created-slash" > "a\\q.txt"'],
            cwd: root,
          });
          const out = await cmd.output();
          assertEquals(out.code, 0);
          assertEquals(new TextDecoder().decode(await Deno.readFile(newFile)), "created-slash");

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  let exists = false;
  try {
    await Deno.lstat(newFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false, "newly created file at 'a\\q.txt' must be removed on rollback");

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell redirect in double quotes removes backslash followed by newline", async () => {
  const root = await Deno.makeTempDir({ prefix: "evidence-2bfv-slash-nl-remove-" });
  const newFile = `${root}/newfile.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "proof-slash-nl-remove-rollback",
        async (c) => {
          // Redirect: > "new\\\nfile.txt" in shell double quotes removes backslash-newline
          const cmd = new Deno.Command("sh", {
            args: ["-c", 'printf "created-cont" > "new\\\nfile.txt"'],
            cwd: root,
          });
          const out = await cmd.output();
          assertEquals(out.code, 0);
          assertEquals(new TextDecoder().decode(await Deno.readFile(newFile)), "created-cont");

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  let exists = false;
  try {
    await Deno.lstat(newFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false, "newly created file at 'newfile.txt' must be removed on rollback");

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed write to existing directory discards child snapshots and preserves external child edit on rollback", async () => {
  const root = await Deno.makeTempDir({
    prefix: "evidence-2bfv-failed-write-dir-",
  });
  const subDir = `${root}/subdir`;
  await Deno.mkdir(subDir);
  const childFile = `${subDir}/child.txt`;
  await originalWriteFile(childFile, new Uint8Array([1, 2, 3]));

  await assertRejects(
    async () => {
      await runProof(
        "proof-failed-write-dir-rollback",
        async (c) => {
          // Attempting to write to an existing directory throws IsADirectory
          await assertRejects(
            async () => {
              await Deno.writeFile(subDir, new Uint8Array([9, 9, 9]));
            },
            Deno.errors.IsADirectory,
          );

          // Verify childFile snapshot added during failed write was discarded
          const active = getActiveProof();
          assertEquals(active?.snapshots.has(childFile), false);

          // External actor edits child.txt
          await originalWriteFile(childFile, new Uint8Array([4, 5, 6]));

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  const finalBytes = await Deno.readFile(childFile);
  assertEquals(
    Array.from(finalBytes),
    [4, 5, 6],
    "external edit to child of directory targeted by failed write must not be rolled back",
  );

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell redirect with POSIX default-value expansion tracks target and cleans up on rollback", async () => {
  const root = await Deno.makeTempDir({
    prefix: "evidence-2bfv-shell-def-val-",
  });
  const fallbackFile = `${root}/fallback.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "proof-shell-def-val-rollback",
        async (c) => {
          // Redirect: > "${UNSET_OUT:-fallback.txt}" when UNSET_OUT is unset
          const cmd = new Deno.Command("sh", {
            args: ["-c", 'printf "created-def" > "${UNSET_OUT:-fallback.txt}"'],
            cwd: root,
          });
          const out = await cmd.output();
          assertEquals(out.code, 0);
          assertEquals(
            new TextDecoder().decode(await Deno.readFile(fallbackFile)),
            "created-def",
          );

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  let exists = false;
  try {
    await Deno.lstat(fallbackFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(
    exists,
    false,
    "newly created file at 'fallback.txt' must be removed on rollback",
  );

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed write to parent directory does not discard concurrent successful child write snapshot on rollback", async () => {
  const root = await Deno.makeTempDir({
    prefix: "evidence-2bfv-concurrent-parent-child-",
  });
  const parentDir = `${root}/parent`;
  await Deno.mkdir(parentDir);
  const childFile = `${parentDir}/child_new.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "proof-concurrent-parent-child-rollback",
        async (c) => {
          // Concurrently execute successful child write and failing parent directory write
          let parentThrew = false;
          await Promise.all([
            (async () => {
              await Deno.writeFile(childFile, new Uint8Array([11, 22, 33]));
            })(),
            (async () => {
              try {
                await Deno.writeFile(parentDir, new Uint8Array([99]));
              } catch {
                parentThrew = true;
              }
            })(),
          ]);
          assertEquals(parentThrew, true, "writing to directory must throw");
          assertEquals(
            Array.from(await Deno.readFile(childFile)),
            [11, 22, 33],
          );

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  let exists = false;
  try {
    await Deno.lstat(childFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(
    exists,
    false,
    "newly created child file must be removed on rollback even when parent write failed",
  );

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell redirect with expanded fallback variable tracks target and cleans up on rollback", async () => {
  const root = await Deno.makeTempDir({
    prefix: "evidence-2bfv-shell-fallback-var-",
  });
  const subDir = `${root}/subdir`;
  await Deno.mkdir(subDir);
  const targetFile = `${subDir}/result.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "proof-shell-fallback-var-rollback",
        async (c) => {
          // Redirect: > "${UNSET_OUT:-$FALLBACK_DIR/result.txt}" where UNSET_OUT is unset and FALLBACK_DIR is set
          const cmd = new Deno.Command("sh", {
            args: [
              "-c",
              'printf "created-nested-fallback" > "${UNSET_OUT:-$FALLBACK_DIR/result.txt}"',
            ],
            env: { FALLBACK_DIR: subDir },
            cwd: root,
          });
          const out = await cmd.output();
          assertEquals(out.code, 0);
          assertEquals(
            new TextDecoder().decode(await Deno.readFile(targetFile)),
            "created-nested-fallback",
          );

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  let exists = false;
  try {
    await Deno.lstat(targetFile);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(
    exists,
    false,
    "newly created file at '${FALLBACK_DIR}/result.txt' must be removed on rollback",
  );

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: failed write to absent path discards null snapshot and preserves subsequent external creation on rollback", async () => {
  const root = await Deno.makeTempDir({
    prefix: "evidence-2bfv-failed-write-absent-",
  });
  const absentFile = `${root}/absent_failed.txt`;

  await assertRejects(
    async () => {
      await runProof(
        "proof-failed-write-absent-rollback",
        async (c) => {
          // Writing to absent file with create: false throws NotFound
          await assertRejects(
            async () => {
              await Deno.writeFile(absentFile, new Uint8Array([1, 2, 3]), {
                create: false,
              });
            },
            Deno.errors.NotFound,
          );

          // Verify absentFile null snapshot added during failed write was discarded
          const active = getActiveProof();
          assertEquals(active?.snapshots.has(absentFile), false);

          // External actor subsequently creates the file
          await originalWriteFile(absentFile, new Uint8Array([55, 66, 77]));

          c.check("fail deliberate", false, "trigger rollback");
        },
        { logger: () => {} },
      );
    },
    Error,
    "fail deliberate",
  );

  const finalBytes = await Deno.readFile(absentFile);
  assertEquals(
    Array.from(finalBytes),
    [55, 66, 77],
    "subsequently created file must not be deleted by rollback when failed write left it absent",
  );

  await Deno.remove(root, { recursive: true }).catch(() => {});
});

Deno.test("proof-helper: audio-feed-2bfv: shell redirect honors clearEnv and tracks fallback target on rollback", async () => {
  const root = await Deno.makeTempDir({
    prefix: "evidence-2bfv-shell-clearenv-",
  });
  const subDir = `${root}/subdir_clearenv`;
  await Deno.mkdir(subDir);
  const targetFile = `${subDir}/result_clearenv.txt`;

  // audio-feed-lnnjd audit: same shape as EVIDENCE_TEST_OUT2 above — an
  // invented, uniquely-named variable whose only consumer is the child this
  // test spawns with clearEnv; the parent-side set/delete window is
  // unobservable to any other module.
  Deno.env.set("OUT_CLEARENV_TEST", "parent_out.txt");
  try {
    await assertRejects(
      async () => {
        await runProof(
          "proof-shell-clearenv-rollback",
          async (c) => {
            // clearEnv: true clears parent OUT_CLEARENV_TEST; shell uses fallback
            const cmd = new Deno.Command("sh", {
              args: [
                "-c",
                'printf "created-clearenv" > "${OUT_CLEARENV_TEST:-$FALLBACK_DIR/result_clearenv.txt}"',
              ],
              clearEnv: true,
              env: { FALLBACK_DIR: subDir },
              cwd: root,
            });
            const out = await cmd.output();
            assertEquals(out.code, 0);
            assertEquals(
              new TextDecoder().decode(await Deno.readFile(targetFile)),
              "created-clearenv",
            );

            c.check("fail deliberate", false, "trigger rollback");
          },
          { logger: () => {} },
        );
      },
      Error,
      "fail deliberate",
    );

    let exists = false;
    try {
      await Deno.lstat(targetFile);
      exists = true;
    } catch {
      exists = false;
    }
    assertEquals(
      exists,
      false,
      "newly created file at '${FALLBACK_DIR}/result_clearenv.txt' under clearEnv must be removed on rollback",
    );
  } finally {
    Deno.env.delete("OUT_CLEARENV_TEST");
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name:
    "proof-helper: a live Chrome is still a leftover - the detector is scoped, not weaker (audio-feed-ubjt1)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  fn: async () => {
    const chrome = await launchChrome();
    const { profileDir, process } = chrome;
    try {
      // FALSE-NEGATIVE side: a real child carrying --user-data-dir=<profile> must be REPORTED as a leftover.
      assertEquals(
        await waitForChromeProfileUnused(profileDir, { timeoutMs: 600 }),
        false,
        `a live Chrome carrying --user-data-dir=${profileDir} must still be reported as a leftover`,
      );
      await killChromeAndWait(process);
      assertEquals(await waitForChromeProfileUnused(profileDir), true);
    } finally {
      await killChromeAndWait(process);
      await removeDirWhenQuiet(profileDir);
    }
  },
});

Deno.test({
  name: "proof-helper: our own command line does not make a profile look used (audio-feed-ubjt1)",
  fn: async () => {
    // FALSE-POSITIVE side: this process's own argv carries this file's path, as a RELATIVE path, exactly as the test
    // runner was invoked (`deno test ... tests/proof_helper_test.ts`). The detector used to match the bare path, so it
    // counted ITSELF and a correct run looked leaky. Verified against the old implementation: it fails this assertion.
    const ownArgvPath = "tests/proof_helper_test.ts";
    assertEquals(
      await waitForChromeProfileUnused(ownArgvPath, { timeoutMs: 300 }),
      true,
      `a path that appears only on our own command line (${ownArgvPath}) must not be reported as a leftover`,
    );
  },
});

Deno.test({
  name: "proof-helper: a child of this run that is NOT the browser still counts (audio-feed-ubjt1)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  fn: async () => {
    // The interesting middle: a process descended from THIS run, carrying the flag, but not the browser under test.
    // Excluding ancestors only must not silence it - an exclusion that walked the whole tree would.
    const otherProfile = `/tmp/audiofeed-ubjt1-middle-${crypto.randomUUID()}`;
    const child = new Deno.Command("sh", {
      args: ["-c", "sleep 30", `--user-data-dir=${otherProfile}`],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      let reported = true;
      for (let attempt = 1; attempt <= 20 && reported; attempt++) {
        reported = await waitForChromeProfileUnused(otherProfile, { timeoutMs: 50 });
        if (reported) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(
        reported,
        false,
        `a child of this run carrying --user-data-dir=${otherProfile} must count as a leftover (ancestors are excluded, descendants are not)`,
      );
    } finally {
      // Reap on our own failure path: a test that leaks what it spawns is the defect it is testing for.
      await killChromeAndWait(child);
    }
  },
});

Deno.test({
  name:
    "proof-helper: a profile that is a PREFIX of another must not be reported as used (audio-feed-pclwg)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  fn: async () => {
    // The ubjt1 reviewer's repro: a child uses `--user-data-dir=<base>-other`. The base profile is NOT in use, so it
    // must read unused, while the -other profile must read used. Before the fix, `includes()` matched the prefix and
    // reported the base as used.
    const base = `/tmp/audiofeed-pclwg-${crypto.randomUUID()}`;
    const other = `${base}-other`;
    const child = new Deno.Command("sh", {
      args: ["-c", "sleep 2", `--user-data-dir=${other}`],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      let settled = false;
      for (let attempt = 1; attempt <= 20 && !settled; attempt++) {
        settled = (await waitForChromeProfileUnused(other, { timeoutMs: 50 })) === false;
        if (!settled) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(settled, true, `the profile in use (${other}) must be reported as used`);
      assertEquals(
        await waitForChromeProfileUnused(base, { timeoutMs: 200 }),
        true,
        `the PREFIX profile ${base} is not in use and must not be reported as a collision`,
      );
    } finally {
      await killChromeAndWait(child);
    }
  },
});

Deno.test(
  "proof-helper: writeEvidenceReadme MERGES into a marker-delimited README - prose survives, region is replaced, a second run is a no-op (audio-feed-i98g1)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-readme-merge-" });
    try {
      const readmePath = `${dir}/README.md`;
      await Deno.writeTextFile(
        readmePath,
        [
          GENERATED_BEGIN,
          "# Stale generated title",
          "",
          "- Asserts: stale generated assert",
          GENERATED_END,
          "",
          "- Debt: admitted (audio-feed-test)",
          "",
          "## Feature",
          "",
          "Human prose that must survive every regeneration.",
          "",
        ].join("\n"),
      );
      const options = {
        dir,
        title: "Browser Proof: merge (audio-feed-test)",
        script: "scripts/test-browser-proof.ts",
        asserts: ["fresh assert one", "fresh assert two"],
        allowOutsideProof: true,
      };
      await writeEvidenceReadme(options);
      const afterFirst = await Deno.readTextFile(readmePath);
      // Everything OUTSIDE the region survives byte-for-byte - the audio-feed-i98g1 hazard: one run
      // used to delete 26 lines of hand-written prose from docs/evidence/audio-feed-kzi/README.md.
      assertStringIncludes(afterFirst, "- Debt: admitted (audio-feed-test)");
      assertStringIncludes(afterFirst, "## Feature");
      assertStringIncludes(afterFirst, "Human prose that must survive every regeneration.");
      // Everything INSIDE the region is the generator's to state: stale generated content is gone.
      assert(!afterFirst.includes("Stale generated title"));
      assert(!afterFirst.includes("- Asserts: stale generated assert"));
      assertStringIncludes(afterFirst, "- Asserts: fresh assert one; fresh assert two");
      // IDEMPOTENCE: the second run must not dirty the file.
      await writeEvidenceReadme(options);
      assertEquals(
        await Deno.readTextFile(readmePath),
        afterFirst,
        "a second run must leave the README byte-identical",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "proof-helper: writeEvidenceReadme still OVERWRITES a README that was not migrated to markers (audio-feed-i98g1)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-readme-overwrite-" });
    try {
      const readmePath = `${dir}/README.md`;
      await Deno.writeTextFile(readmePath, "# Old prose without markers\n");
      const options = {
        dir,
        title: "Browser Proof: overwrite (audio-feed-test)",
        script: "scripts/test-browser-proof.ts",
        asserts: ["an assert"],
        allowOutsideProof: true,
      };
      await writeEvidenceReadme(options);
      const content = await Deno.readTextFile(readmePath);
      // Migration is a deliberate per-file decision, so an un-migrated README keeps the historical
      // whole-file overwrite: the generated content IS the file, prose and markers alike gone.
      assertEquals(content, await formatEvidenceReadme(options));
      assert(!content.includes("Old prose without markers"));
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "proof-helper: writeEvidenceReadme REFUSES a migrated-but-malformed README instead of silently stripping it (audio-feed-i98g1)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "evidence-readme-malformed-" });
    try {
      const readmePath = `${dir}/README.md`;
      const malformed = [
        GENERATED_BEGIN,
        "# A begin marker with no end marker",
        "",
        "- Debt: admitted (audio-feed-test)",
        "",
      ].join("\n");
      await Deno.writeTextFile(readmePath, malformed);
      // The worst response to a malformed region is the pre-i98g1 behaviour: fall back to a
      // whole-file overwrite and delete the prose the markers failed to protect. Refuse instead.
      await assertRejects(
        () =>
          writeEvidenceReadme({
            dir,
            title: "Browser Proof: malformed (audio-feed-test)",
            script: "scripts/test-browser-proof.ts",
            asserts: ["an assert"],
            allowOutsideProof: true,
          }),
        Error,
        "marker line is missing",
      );
      assertEquals(
        await Deno.readTextFile(readmePath),
        malformed,
        "a rejected write must leave the file untouched",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);
