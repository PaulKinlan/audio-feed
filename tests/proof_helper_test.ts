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
  createChecker,
  createTempChromeProfile,
  isVisible,
  newestChrome,
  spawnHarness,
  startInProcessServer,
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

Deno.test("proof-helper: createChecker records failures and finish() throws naming each failure", () => {
  const checker = createChecker();
  checker.check("passing check", true);
  checker.check("failing check alpha", false, "reason A");
  checker.check("failing check beta", false, "reason B");

  assertEquals(checker.failures.length, 2);
  assertEquals(checker.failures[0]?.name, "failing check alpha");
  assertEquals(checker.failures[0]?.detail, "reason A");
  assertEquals(checker.failures[1]?.name, "failing check beta");
  assertEquals(checker.failures[1]?.detail, "reason B");

  const err = assertThrows(
    () => checker.finish(),
    Error,
    "Checker failed 2 check(s)",
  );
  assertStringIncludes(err.message, "failing check alpha (reason A)");
  assertStringIncludes(err.message, "failing check beta (reason B)");
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
