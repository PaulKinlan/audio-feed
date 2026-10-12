/**
 * Tests for proof-helper port and profile hygiene (audio-feed-9se).
 *
 * Verifies:
 * - Temporary Chrome profiles are uniquely allocated via mkdtemp and removed by cleanup()
 * - Harness processes bind ephemeral port 0 and report assigned port
 * - Output (stdout and stderr) is retained rather than discarded
 * - Premature harness exit before /health is detected and fails fast
 */

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertVisibleExpression,
  CheckFailureError,
  ChromeHandle,
  createChecker,
  createTempChromeProfile,
  isVisible,
  launchChrome,
  newestChrome,
  resolveChromeBinary,
  runProof,
  spawnHarness,
  startInProcessServer,
  withChrome,
  writeEvidenceReadme,
} from "../scripts/proof-helper.ts";

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

Deno.test("proof-helper: createTempChromeProfile creates and cleanly removes temp dir", async () => {
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-test-profile-");
  const stat = await Deno.stat(profileDir);
  assertEquals(stat.isDirectory, true);

  await cleanup();
  await assertRejects(
    async () => await Deno.stat(profileDir),
    Deno.errors.NotFound,
  );
});

Deno.test({
  name: "proof-helper: spawnHarness binds ephemeral port 0 and answers health check",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const harness = await spawnHarness("scripts/account-harness.ts");
    try {
      assertEquals(harness.port > 0, true, `assigned port ${harness.port} must be > 0`);
      const health = await fetch(`${harness.base}/health`);
      assertEquals(health.ok, true);

      const logs = harness.getLogs();
      assertStringIncludes(logs.stdout, `READY port=${harness.port}`);
    } finally {
      harness.kill();
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
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-test-idempotent-");
  await cleanup();
  await cleanup(); // second call must not throw
  await assertRejects(
    async () => await Deno.stat(profileDir),
    Deno.errors.NotFound,
  );
});

Deno.test("proof-helper: createTempChromeProfile throws descriptive error if profile directory cannot be removed", async () => {
  const { profileDir, cleanup } = await createTempChromeProfile("audiofeed-test-fail-");
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
  assertEquals(found.inViewport, true);

  const notFound = syntheticEval({ querySelector: () => null }, mockWin);
  assertEquals(notFound.found, false);
  assertEquals(notFound.inViewport, false);
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

Deno.test("proof-helper: writeEvidenceReadme generates valid README passing evidence declaration regexes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-test-" });
  try {
    const readmePath = await writeEvidenceReadme({
      dir,
      title: "Browser Proof: Audio Feed Verification (audio-feed-test)",
      script: "scripts/test-browser-proof.ts",
      asserts: ["audio route serves audio/wav", "web player renders playback bar"],
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
    assertStringIncludes(content, "## Verified Features");

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

Deno.test("proof-helper: writeEvidenceReadme handles capture declarations and enforces reason", async () => {
  const dir = await Deno.makeTempDir({ prefix: "evidence-readme-capture-" });
  try {
    const readmePath = await writeEvidenceReadme({
      dir,
      title: "Capture: Snapshot of Storage",
      script: "scripts/capture-storage.ts",
      capture: true,
      captureReason: "no assertions; state observation only",
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
  assertEquals(resolveChromeBinary("/custom/chrome"), "/custom/chrome");
  const originalEnv = Deno.env.get("AUDIOFEED_CHROME_BIN");
  try {
    Deno.env.set("AUDIOFEED_CHROME_BIN", "/env/chrome");
    assertEquals(resolveChromeBinary(), "/env/chrome");
    assertEquals(resolveChromeBinary("/override/chrome"), "/override/chrome");
  } finally {
    if (originalEnv !== undefined) {
      Deno.env.set("AUDIOFEED_CHROME_BIN", originalEnv);
    } else {
      Deno.env.delete("AUDIOFEED_CHROME_BIN");
    }
  }
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
  const originalEnv = Deno.env.get("AUDIOFEED_CHROME_BIN");
  try {
    Deno.env.set("AUDIOFEED_CHROME_BIN", "/bin/true");
    await assertRejects(
      async () => {
        await withChrome(
          async () => {},
          { prefix: "audiofeed-stub-env-" },
        );
      },
      Error,
      "exited prematurely with code 0 before writing DevToolsActivePort",
    );

    const leftovers = [...Deno.readDirSync("/tmp")]
      .filter((e) => e.name.startsWith("audiofeed-stub-env-"));
    assertEquals(leftovers.length, 0);
  } finally {
    if (originalEnv !== undefined) {
      Deno.env.set("AUDIOFEED_CHROME_BIN", originalEnv);
    } else {
      Deno.env.delete("AUDIOFEED_CHROME_BIN");
    }
  }
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
  const origBin = Deno.env.get("AUDIOFEED_CHROME_BIN");
  const origHome = Deno.env.get("HOME");
  const testPrefix = "audiofeed-disc-fail-inproc-";
  const fakeHome = "/tmp/nonexistent-audiofeed-inproc-home";
  try {
    Deno.env.delete("AUDIOFEED_CHROME_BIN");
    Deno.env.set("HOME", fakeHome);

    const err = await assertRejects(
      async () => {
        await launchChrome({ prefix: testPrefix });
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
    if (origBin !== undefined) {
      Deno.env.set("AUDIOFEED_CHROME_BIN", origBin);
    } else {
      Deno.env.delete("AUDIOFEED_CHROME_BIN");
    }
    if (origHome !== undefined) {
      Deno.env.set("HOME", origHome);
    } else {
      Deno.env.delete("HOME");
    }
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
