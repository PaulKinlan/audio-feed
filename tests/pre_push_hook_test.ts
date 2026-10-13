/**
 * audio-feed-ng60 / audio-feed-fgay / audio-feed-4iae / audio-feed-p2la:
 * verify pre-push hook prevents pushing non-gated trees, prevents publishing
 * origin/main or origin/main's tree onto fleet/* branches, checks record sha,
 * and can be installed into git hooks.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

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
  const commitOut = await new Deno.Command("git", {
    args: [
      "commit-tree",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "-m",
      "distinct feature",
    ],
    cwd: ROOT,
  }).output();
  const featureSha = new TextDecoder().decode(commitOut.stdout).trim();

  const line =
    `refs/heads/fleet/test-feature ${featureSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
  const result = await runHook(line, { FLEET_REQUIRE_GATED_PUSH: "0" });

  assertEquals(
    result.code,
    0,
    `Feature push should be permitted: ${result.stderr}`,
  );
});

Deno.test("audio-feed-4iae: pre-push hook refuses push if check record is for a DIFFERENT commit sha", async () => {
  const commitOut = await new Deno.Command("git", {
    args: [
      "commit-tree",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "-m",
      "feature 4iae",
    ],
    cwd: ROOT,
  }).output();
  const featureSha = new TextDecoder().decode(commitOut.stdout).trim();
  const featureTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  const tmpHome = await Deno.makeTempDir();
  try {
    const checksDir = `${tmpHome}/.fleet/checks`;
    await Deno.mkdir(checksDir, { recursive: true });
    // Write record with same tree but completely DIFFERENT sha
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.fast.json`,
      JSON.stringify({ state: "PASS", tree: featureTree, sha: "deadbeef" }),
    );

    const line =
      `refs/heads/fleet/test-feature ${featureSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const result = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });

    assertEquals(
      result.code,
      1,
      "Hook must refuse push when check record sha does not match commit",
    );
    assertStringIncludes(
      result.stderr,
      "has no passing fleet-check record for this commit",
    );
  } finally {
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("audio-feed-ng60 / audio-feed-4iae: pre-push hook permits pushing gated tree matching sha", async () => {
  const commitOut = await new Deno.Command("git", {
    args: [
      "commit-tree",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "-m",
      "gated feature",
    ],
    cwd: ROOT,
  }).output();
  const featureSha = new TextDecoder().decode(commitOut.stdout).trim();
  const featureTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  const tmpHome = await Deno.makeTempDir();
  try {
    const checksDir = `${tmpHome}/.fleet/checks`;
    await Deno.mkdir(checksDir, { recursive: true });
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.fast.json`,
      JSON.stringify({
        state: "PASS",
        tree: featureTree,
        sha: featureSha.slice(0, 7),
      }),
    );

    const line =
      `refs/heads/fleet/test-feature ${featureSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
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
    assertStringIncludes(hookContent, "audio-feed-pre-push");

    // audio-feed-25hc: standalone copy must exist and be executable
    const standalone = `${hooksDir}/audio-feed-pre-push`;
    const st = await Deno.stat(standalone);
    assert(st.isFile, "Standalone hook copy must be created");
  } finally {
    await Deno.remove(tmpRepo, { recursive: true });
  }
});

Deno.test("audio-feed-f5c0: install-hooks.sh places chain shebang-adjacent so pre-existing early exit does not skip guards", async () => {
  const tmpRepo = await Deno.makeTempDir();
  try {
    const hooksDir = `${tmpRepo}/hooks`;
    await Deno.mkdir(hooksDir, { recursive: true });
    // Pre-existing hook that exits immediately
    await Deno.writeTextFile(
      `${hooksDir}/pre-push`,
      "#!/usr/bin/env bash\nexit 0\n",
    );

    const installCmd = new Deno.Command(INSTALL_PATH, {
      cwd: ROOT,
      env: {
        ...Deno.env.toObject(),
        GIT_DIR: tmpRepo,
      },
    });
    const installOut = await installCmd.output();
    assertEquals(installOut.code, 0, "Installer must exit 0");

    const hookContent = await Deno.readTextFile(`${hooksDir}/pre-push`);
    const lines = hookContent.trim().split("\n");
    assertEquals(lines[0], "#!/usr/bin/env bash", "Shebang preserved");
    // Assert chain block appears BEFORE exit 0
    const chainIdx = hookContent.indexOf("audio-feed-p2la");
    const exitIdx = hookContent.indexOf("exit 0");
    assert(chainIdx !== -1, "Chain block must be present");
    assert(exitIdx !== -1, "exit 0 must be present");
    assert(
      chainIdx < exitIdx,
      "Chain block must appear before existing hook's exit 0",
    );

    // Drive the installed hook with forbidden push (publishing main onto fleet/*)
    const mainShaOut = await new Deno.Command("git", {
      args: ["rev-parse", "origin/main"],
      cwd: ROOT,
    }).output();
    const mainSha = new TextDecoder().decode(mainShaOut.stdout).trim();

    const pushLine =
      `refs/heads/fleet/test-feature ${mainSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const hookCmd = new Deno.Command(`${hooksDir}/pre-push`, {
      args: ["origin", "git@github.com:PaulKinlan/audio-feed.git"],
      cwd: ROOT,
      env: {
        ...Deno.env.toObject(),
        FLEET_LANE: "",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = hookCmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(pushLine));
    await writer.close();
    const hookOut = await child.output();

    assertEquals(
      hookOut.code,
      1,
      "Hook with pre-existing exit 0 must still refuse forbidden push",
    );
    assertStringIncludes(
      new TextDecoder().decode(hookOut.stderr),
      "Publishing a copy of main onto a feature branch is forbidden",
    );
  } finally {
    await Deno.remove(tmpRepo, { recursive: true });
  }
});

Deno.test("audio-feed-25hc / audio-feed-iewo: chained hook executes standalone copy even when pushing worktree has no scripts/hooks/pre-push", async () => {
  const scratchRepo = await Deno.makeTempDir();
  const scratchWorktree = await Deno.makeTempDir();
  try {
    // Initialize an isolated scratch git repository
    await new Deno.Command("git", {
      args: ["init", "-q", scratchRepo],
    }).output();
    await new Deno.Command("git", {
      args: ["config", "user.name", "Test User"],
      cwd: scratchRepo,
    }).output();
    await new Deno.Command("git", {
      args: ["config", "user.email", "test@example.com"],
      cwd: scratchRepo,
    }).output();
    await new Deno.Command("git", {
      args: ["commit", "--allow-empty", "-q", "-m", "initial commit"],
      cwd: scratchRepo,
    }).output();

    const mainShaOut = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd: scratchRepo,
    }).output();
    const mainSha = new TextDecoder().decode(mainShaOut.stdout).trim();

    await new Deno.Command("git", {
      args: ["update-ref", "refs/remotes/origin/main", mainSha],
      cwd: scratchRepo,
    }).output();

    // Install hooks into scratchRepo/.git
    const installCmd = new Deno.Command(INSTALL_PATH, {
      cwd: ROOT,
      env: {
        ...Deno.env.toObject(),
        GIT_DIR: path.join(scratchRepo, ".git"),
      },
    });
    const installOut = await installCmd.output();
    assertEquals(installOut.code, 0, "Installer must exit 0");

    // Add a detached worktree from scratchRepo (does not contain scripts/hooks/pre-push)
    const addOut = await new Deno.Command("git", {
      args: ["worktree", "add", "--detach", "-q", scratchWorktree, "HEAD"],
      cwd: scratchRepo,
    }).output();
    assertEquals(addOut.code, 0, "Must create test worktree");

    const hookPath = path.join(scratchRepo, ".git", "hooks", "pre-push");
    const pushLine =
      `refs/heads/fleet/test-feature ${mainSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const hookCmd = new Deno.Command(hookPath, {
      args: ["origin", "git@github.com:PaulKinlan/audio-feed.git"],
      cwd: scratchWorktree,
      env: {
        ...Deno.env.toObject(),
        FLEET_LANE: "",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = hookCmd.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(pushLine));
    await writer.close();
    const hookOut = await child.output();

    assertEquals(
      hookOut.code,
      1,
      "Standalone hook copy must execute and refuse forbidden push from worktree without scripts/hooks/pre-push",
    );
    assertStringIncludes(
      new TextDecoder().decode(hookOut.stderr),
      "Publishing a copy of main onto a feature branch is forbidden",
    );
  } finally {
    await new Deno.Command("git", {
      args: ["worktree", "remove", "--force", scratchWorktree],
      cwd: scratchRepo,
    }).output().catch(() => {});
    await Deno.remove(scratchRepo, { recursive: true }).catch(() => {});
    await Deno.remove(scratchWorktree, { recursive: true }).catch(() => {});
  }
});
