/**
 * audio-feed-ng60 / audio-feed-fgay / audio-feed-4iae / audio-feed-p2la:
 * verify pre-push hook prevents pushing non-gated trees, prevents publishing
 * origin/main or origin/main's tree onto fleet/* branches, checks record sha,
 * and can be installed into git hooks.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ROOT = new URL("..", import.meta.url).pathname;
const HOOK_PATH = `${ROOT}/scripts/hooks/pre-push`;
const INSTALL_PATH = `${ROOT}/scripts/hooks/install-hooks.sh`;

async function runHook(
  input: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cleanEnv = { ...Deno.env.toObject(), ...env };
  cleanEnv.FLEET_LANE = env.FLEET_LANE ?? ""; // clear FLEET_LANE unless explicitly set

  const cmd = new Deno.Command(HOOK_PATH, {
    args: ["origin", "git@github.com:PaulKinlan/audio-feed.git"],
    cwd: ROOT,
    env: cleanEnv,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test("audio-feed-ng60: pre-push hook refuses pushing origin/main sha onto a fleet/* branch", async () => {
  const mainShaOut = await new Deno.Command("git", {
    args: ["rev-parse", "origin/main"],
    cwd: ROOT,
  }).output();
  const mainSha = new TextDecoder().decode(mainShaOut.stdout).trim();
  assert(mainSha.length === 40, `Failed to resolve origin/main: ${mainSha}`);

  const line =
    `refs/heads/fleet/test-feature ${mainSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
  const result = await runHook(line);

  assertEquals(result.code, 1, "Hook must exit non-zero when pushing main onto fleet/*");
  assertStringIncludes(
    result.stderr,
    "Publishing a copy of main onto a feature branch is forbidden (audio-feed-ng60)",
  );
});

Deno.test("audio-feed-fgay: pre-push hook refuses pushing commit matching origin/main's TREE onto fleet/*", async () => {
  const mainTreeOut = await new Deno.Command("git", {
    args: ["rev-parse", "origin/main^{tree}"],
    cwd: ROOT,
  }).output();
  const mainTree = new TextDecoder().decode(mainTreeOut.stdout).trim();

  // Create a synthetic commit with main's tree but different commit SHA
  const commitOut = await new Deno.Command("git", {
    args: ["commit-tree", mainTree, "-m", "synthetic commit with main tree"],
    cwd: ROOT,
  }).output();
  const syntheticSha = new TextDecoder().decode(commitOut.stdout).trim();
  assert(syntheticSha.length === 40, `Failed to create synthetic commit: ${syntheticSha}`);

  const line =
    `refs/heads/fleet/test-feature ${syntheticSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
  const result = await runHook(line);

  assertEquals(
    result.code,
    1,
    "Hook must exit non-zero when pushing commit with main's tree onto fleet/*",
  );
  assertStringIncludes(
    result.stderr,
    "local tree",
  );
  assertStringIncludes(
    result.stderr,
    "matches origin/main^{tree}",
  );
});

Deno.test("audio-feed-ng60: pre-push hook permits pushing distinct feature commit onto fleet/* branch", async () => {
  const headShaOut = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: ROOT,
  }).output();
  const headSha = new TextDecoder().decode(headShaOut.stdout).trim();

  const line =
    `refs/heads/fleet/test-feature ${headSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
  const result = await runHook(line, { FLEET_REQUIRE_GATED_PUSH: "0" });

  assertEquals(result.code, 0, `Feature push should be permitted: ${result.stderr}`);
});

Deno.test("audio-feed-4iae: pre-push hook refuses push if check record is for a DIFFERENT commit sha", async () => {
  const headShaOut = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: ROOT,
  }).output();
  const headSha = new TextDecoder().decode(headShaOut.stdout).trim();

  const headTreeOut = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD^{tree}"],
    cwd: ROOT,
  }).output();
  const headTree = new TextDecoder().decode(headTreeOut.stdout).trim();

  const tmpHome = await Deno.makeTempDir();
  try {
    const checksDir = `${tmpHome}/.fleet/checks`;
    await Deno.mkdir(checksDir, { recursive: true });
    // Write record with same tree but completely DIFFERENT sha
    await Deno.writeTextFile(
      `${checksDir}/${headTree}.fast.json`,
      JSON.stringify({ state: "PASS", tree: headTree, sha: "deadbeef" }),
    );

    const line =
      `refs/heads/fleet/test-feature ${headSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const result = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });

    assertEquals(
      result.code,
      1,
      "Hook must refuse push when check record sha does not match commit",
    );
    assertStringIncludes(result.stderr, "has no passing fleet-check record for this commit");
  } finally {
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("audio-feed-ng60 / audio-feed-4iae: pre-push hook permits pushing gated tree matching sha", async () => {
  const headShaOut = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: ROOT,
  }).output();
  const headSha = new TextDecoder().decode(headShaOut.stdout).trim();

  const headTreeOut = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD^{tree}"],
    cwd: ROOT,
  }).output();
  const headTree = new TextDecoder().decode(headTreeOut.stdout).trim();

  const tmpHome = await Deno.makeTempDir();
  try {
    const checksDir = `${tmpHome}/.fleet/checks`;
    await Deno.mkdir(checksDir, { recursive: true });
    await Deno.writeTextFile(
      `${checksDir}/${headTree}.fast.json`,
      JSON.stringify({ state: "PASS", tree: headTree, sha: headSha.slice(0, 7) }),
    );

    const line =
      `refs/heads/fleet/test-feature ${headSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const result = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });

    assertEquals(result.code, 0, `Gated push should succeed: ${result.stderr}`);
  } finally {
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("audio-feed-p2la: install-hooks.sh correctly installs chaining wrapper into git hooks dir", async () => {
  const tmpRepo = await Deno.makeTempDir();
  try {
    const hooksDir = `${tmpRepo}/hooks`;
    await Deno.mkdir(hooksDir, { recursive: true });
    await Deno.writeTextFile(`${hooksDir}/pre-push`, "#!/bin/sh\n# Existing hook\n");

    const cmd = new Deno.Command(INSTALL_PATH, {
      cwd: ROOT,
      env: {
        ...Deno.env.toObject(),
        GIT_DIR: tmpRepo,
      },
    });
    const out = await cmd.output();
    assertEquals(out.code, 0, "Installer must exit 0");

    const hookContent = await Deno.readTextFile(`${hooksDir}/pre-push`);
    assertStringIncludes(hookContent, "audio-feed-p2la: chain repo pre-push hook");
    assertStringIncludes(hookContent, "scripts/hooks/pre-push");
  } finally {
    await Deno.remove(tmpRepo, { recursive: true });
  }
});
