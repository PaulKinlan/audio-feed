/**
 * audio-feed-ng60 / audio-feed-fgay / audio-feed-4iae / audio-feed-p2la:
 * verify pre-push hook prevents pushing non-gated trees, prevents publishing
 * origin/main or origin/main's tree onto fleet/* branches, checks record sha,
 * and can be installed into git hooks.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { prepushGuardStatus } from "../scripts/fast-check.ts";

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

Deno.test("audio-feed-bfkm / audio-feed-shan: pre-push hook permits amended or rebased commit whose tree matches the gated commit", async () => {
  const featureTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  // Pre-amend / pre-rebase commit with featureTree
  const origCommitOut = await new Deno.Command("git", {
    args: ["commit-tree", featureTree, "-m", "original gated commit"],
    cwd: ROOT,
  }).output();
  const origSha = new TextDecoder().decode(origCommitOut.stdout).trim();

  // Amended / rebased commit with the exact same featureTree
  const amendedCommitOut = await new Deno.Command("git", {
    args: ["commit-tree", featureTree, "-m", "amended commit message (bfkm / shan)"],
    cwd: ROOT,
  }).output();
  const amendedSha = new TextDecoder().decode(amendedCommitOut.stdout).trim();
  assert(origSha !== amendedSha, "Original and amended commit SHAs must differ");

  const tmpHome = await Deno.makeTempDir();
  try {
    const checksDir = `${tmpHome}/.fleet/checks`;
    await Deno.mkdir(checksDir, { recursive: true });
    // Check record was written before the amend/rebase, so .sha is origSha.slice(0, 7)
    // and .tree is featureTree.
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.json`,
      JSON.stringify({
        state: "PASS",
        tree: featureTree,
        sha: origSha.slice(0, 7),
      }),
    );

    const line =
      `refs/heads/fleet/test-feature ${amendedSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const result = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });

    assertEquals(
      result.code,
      0,
      `Tree-preserving amend/rebase should be permitted: ${result.stderr}`,
    );

    // Also verify .shas array matching (shan) when record stores multiple shas
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.json`,
      JSON.stringify({
        state: "PASS",
        tree: featureTree,
        sha: "0000000",
        shas: [origSha.slice(0, 7), amendedSha.slice(0, 7)],
      }),
    );
    const shasResult = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });
    assertEquals(
      shasResult.code,
      0,
      `Commit listed in .shas array should be permitted: ${shasResult.stderr}`,
    );

    // Negative control: if rec_sha is a valid commit in git with a DIFFERENT tree, hook must refuse
    const mainShaOut = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd: ROOT,
    }).output();
    const headSha = new TextDecoder().decode(mainShaOut.stdout).trim();
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.json`,
      JSON.stringify({
        state: "PASS",
        tree: featureTree,
        sha: headSha.slice(0, 7),
      }),
    );
    const mismatchResult = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });
    assertEquals(
      mismatchResult.code,
      1,
      "Hook must refuse when rec_sha resolves to a commit with a different tree",
    );
  } finally {
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("audio-feed-zpm2: pre-push hook refuses commit whose gate record is still RUNNING", async () => {
  const featureTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commitOut = await new Deno.Command("git", {
    args: ["commit-tree", featureTree, "-m", "commit with running gate"],
    cwd: ROOT,
  }).output();
  const featureSha = new TextDecoder().decode(commitOut.stdout).trim();

  const tmpHome = await Deno.makeTempDir();
  try {
    const checksDir = `${tmpHome}/.fleet/checks`;
    await Deno.mkdir(checksDir, { recursive: true });

    // Case 1: standalone RUNNING record
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.fast.json`,
      JSON.stringify({
        state: "RUNNING",
        tree: featureTree,
        sha: featureSha.slice(0, 7),
      }),
    );

    const line =
      `refs/heads/fleet/test-feature ${featureSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const standaloneResult = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });
    assertEquals(
      standaloneResult.code,
      1,
      "Hook must refuse push when gate record is RUNNING",
    );
    assertStringIncludes(
      standaloneResult.stderr,
      "gate still RUNNING",
    );

    // Case 2: RUNNING full-gate record alongside an older PASS fast-gate record for the same tree
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.fast.json`,
      JSON.stringify({
        state: "PASS",
        tree: featureTree,
        sha: featureSha.slice(0, 7),
      }),
    );
    await Deno.writeTextFile(
      `${checksDir}/${featureTree}.json`,
      JSON.stringify({
        state: "RUNNING",
        tree: featureTree,
        sha: featureSha.slice(0, 7),
      }),
    );

    const mixedResult = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });
    assertEquals(
      mixedResult.code,
      1,
      "Hook must refuse push when any gate record for the tree is still RUNNING, even if an older PASS exists",
    );
    assertStringIncludes(
      mixedResult.stderr,
      "gate still RUNNING",
    );
  } finally {
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("audio-feed-0l3a: pre-push hook refuses synthetic PASS check record", async () => {
  const featureTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commitOut = await new Deno.Command("git", {
    args: ["commit-tree", featureTree, "-m", "synthetic record commit"],
    cwd: ROOT,
  }).output();
  const featureSha = new TextDecoder().decode(commitOut.stdout).trim();

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
        synthetic: true,
      }),
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
      "Hook must refuse push when check record has synthetic: true",
    );
  } finally {
    await Deno.remove(tmpHome, { recursive: true });
  }
});

/**
 * audio-feed-p2la — the guard's INSTALLATION is what these tests drive, because the defect this
 * bead closes was not in the guard's rules (tests above drive those) but in the fact that a clone
 * with no installed guard gated green and said nothing.
 *
 * The installing command is the one both gate tasks run as their first step, `deno task
 * hooks:install`. Everything here works on scratch clones under makeTempDir(), never on this
 * worktree's git directory, so no test depends on another lane's installation or on this machine's
 * state.
 */
async function gitIn(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code: out.code, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

/** `deno task hooks:install` against `gitDir`, which is the command both gate tasks run first. */
async function armClone(gitDir: string, home: string) {
  const out = await new Deno.Command("deno", {
    args: ["task", "hooks:install"],
    cwd: ROOT,
    env: { ...Deno.env.toObject(), GIT_DIR: gitDir, HOME: home },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    log: decoder.decode(out.stdout) + decoder.decode(out.stderr),
  };
}

Deno.test("audio-feed-p2la: `deno task hooks:install` arms a scratch clone, the armed clone REFUSES a real forbidden push, and removing the installed guard stops it refusing", async () => {
  const scratch = await Deno.makeTempDir();
  const remotes = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    const bare = `${remotes}/remote.git`;
    assertEquals((await gitIn(scratch, ["init", "-q", "-b", "main"])).code, 0);
    await gitIn(scratch, ["config", "user.email", "guard@example.com"]);
    await gitIn(scratch, ["config", "user.name", "Guard Test"]);
    await Deno.writeTextFile(`${scratch}/base.txt`, "base\n");
    await gitIn(scratch, ["add", "base.txt"]);
    await gitIn(scratch, ["commit", "-q", "-m", "base"]);
    const base = (await gitIn(scratch, ["rev-parse", "HEAD"])).stdout.trim();
    assert(base.length === 40, `the scratch clone must have a commit, got '${base}'`);
    await gitIn(scratch, ["update-ref", "refs/remotes/origin/main", base]);
    await gitIn(scratch, ["branch", "fleet/bad", base]);
    assertEquals((await gitIn(scratch, ["init", "-q", "--bare", bare])).code, 0);

    // ARM, exactly as `deno task test:fast` and `deno task gate` do.
    const armed = await armClone(`${scratch}/.git`, home);
    assertEquals(armed.code, 0, `hooks:install must arm a clone: ${armed.log}`);
    assertStringIncludes(armed.log, "pre-push guard armed");

    // "Armed" is a claim about the files git will execute: read them back.
    const hookPath = `${scratch}/.git/hooks/pre-push`;
    const standalonePath = `${scratch}/.git/hooks/audio-feed-pre-push`;
    assertStringIncludes(
      await Deno.readTextFile(hookPath),
      "audio-feed-p2la: chain repo pre-push hook",
    );
    const standalone = await Deno.stat(standalonePath);
    assert(standalone.isFile, "the guard the chain block executes must exist");
    assert(
      ((standalone.mode ?? 0) & 0o111) !== 0,
      "the chain block only executes an executable guard",
    );

    // DRIVE IT: a real push, of a real forbidden ref (a copy of origin/main onto a fleet/* branch).
    const pushEnv = { FLEET_LANE: "", FLEET_REQUIRE_GATED_PUSH: "", HOME: home };
    const forbidden = await gitIn(scratch, [
      "push",
      bare,
      "fleet/bad:refs/heads/fleet/bad",
    ], pushEnv);
    assert(
      forbidden.code !== 0,
      `an armed clone must REFUSE a copy of origin/main onto fleet/*: ${forbidden.stdout}${forbidden.stderr}`,
    );
    assertStringIncludes(forbidden.stderr, "equals origin/main");

    // NEGATIVE CONTROL: remove the installed guard and the SAME push goes through, which is what
    // makes the refusal above evidence about the installation rather than about git or the remote.
    await Deno.remove(hookPath);
    await Deno.remove(standalonePath);
    const unguarded = await gitIn(scratch, [
      "push",
      bare,
      "fleet/bad:refs/heads/fleet/bad",
    ], pushEnv);
    assertEquals(
      unguarded.code,
      0,
      `with no installed guard the push must go through (or the refusal above proved nothing): ${unguarded.stderr}`,
    );
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(remotes, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-p2la: the installer fails CLOSED (non-zero, by name) when it cannot install the guard", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const gitDir = `${tmp}/gitdir`;
    await Deno.mkdir(gitDir, { recursive: true });
    // A FILE where the hooks directory has to go: nothing can be installed there, and the only
    // acceptable outcome is a named failure — never exit 0, which is what "not installed silently"
    // used to look like.
    await Deno.writeTextFile(`${gitDir}/hooks`, "not a directory\n");
    const out = await new Deno.Command("bash", {
      args: [INSTALL_PATH],
      cwd: ROOT,
      env: { ...Deno.env.toObject(), GIT_DIR: gitDir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.code !== 0, `an installer that cannot install must not exit 0: ${stderr}`);
    assertStringIncludes(stderr, "pre-push guard installation FAILED (audio-feed-p2la)");
    assertStringIncludes(stderr, "The guard is NOT armed");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-p2la: the gate's guard check MEASURES the clone instead of trusting the installer's claim", async () => {
  const scratch = await Deno.makeTempDir();
  const nonRepo = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    assertEquals((await gitIn(scratch, ["init", "-q", "-b", "main"])).code, 0);

    const fresh = await prepushGuardStatus(scratch);
    assertEquals(fresh.state, "not-armed", "a clone with no installed guard is not armed");
    if (fresh.state === "not-armed") assertStringIncludes(fresh.detail, "chain block");

    // A directory that is not a worktree is the STATED LIMIT (nothing can push from it), never a
    // silent "armed".
    assertEquals((await prepushGuardStatus(nonRepo)).state, "not-a-worktree");

    const armed = await armClone(`${scratch}/.git`, home);
    assertEquals(armed.code, 0, `hooks:install must arm the scratch clone: ${armed.log}`);
    assertEquals((await prepushGuardStatus(scratch)).state, "armed");

    // The "installed hook was removed" mutation, detected by name: the chained hook file is left
    // intact, and only the guard it executes is gone.
    await Deno.remove(`${scratch}/.git/hooks/audio-feed-pre-push`);
    const stripped = await prepushGuardStatus(scratch);
    assertEquals(stripped.state, "not-armed");
    if (stripped.state === "not-armed") {
      assertStringIncludes(stripped.detail, "audio-feed-pre-push");
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(nonRepo, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-p2la: both gate tasks arm the pre-push guard as their FIRST step", async () => {
  // The gate's own assertion (above) catches a missing guard, and this pins the wiring that makes
  // the assertion satisfiable: `deno task test:fast` and `deno task gate` must arm the guard before
  // they run anything. It is a shape assertion rather than a behavioural one because running a gate
  // from inside a gate is recursive; the behavioural half is the scratch-clone tests above plus
  // scripts/fast-check.ts's own check, which exits non-zero when this step has gone missing.
  const denoJson = JSON.parse(
    (await Deno.readTextFile(`${ROOT}/deno.json`))
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n"),
  ) as { tasks?: Record<string, string> };
  const tasks = denoJson.tasks ?? {};

  const installer = tasks["hooks:install"];
  assert(installer, "the hooks:install task exists");
  assertStringIncludes(installer, "install-hooks.sh");

  for (const task of ["test:fast", "gate"]) {
    const command = tasks[task];
    assert(command, `the ${task} task exists`);
    assert(
      command.startsWith("deno task hooks:install && "),
      `the ${task} task must arm the pre-push guard BEFORE it runs anything: ${command} (audio-feed-p2la)`,
    );
  }
});
