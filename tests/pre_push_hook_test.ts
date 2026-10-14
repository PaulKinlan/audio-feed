/**
 * audio-feed-ng60 / audio-feed-fgay / audio-feed-4iae / audio-feed-p2la:
 * verify pre-push hook prevents pushing non-gated trees, prevents publishing
 * origin/main or origin/main's tree onto fleet/* branches, checks record sha,
 * and can be installed into git hooks.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { prepushGuardStatus } from "../scripts/hooks/guard-status.ts";
import { parseJsonc, readJsonc } from "./jsonc.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// audio-feed-p2la: literal `new URL(...)` forms rather than templates over ROOT, so the fast gate's
// DERIVED read relation can see that this suite executes both hook files. While they were templates
// over a pathname constant, a change to either was reported as an unmapped path with no coverage -
// which is how this suite came to be running them while being invisible to the relation.
const HOOK_PATH = new URL("../scripts/hooks/pre-push", import.meta.url).pathname;
const INSTALL_PATH = new URL("../scripts/hooks/install-hooks.sh", import.meta.url).pathname;
const GUARD_STATUS_PATH = new URL("../scripts/hooks/guard-status.ts", import.meta.url).pathname;

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
    const bare = path.join(remotes, "remote.git");
    assertEquals((await gitIn(scratch, ["init", "-q", "-b", "main"])).code, 0);
    await gitIn(scratch, ["config", "user.email", "guard@example.com"]);
    await gitIn(scratch, ["config", "user.name", "Guard Test"]);
    const baseFile = path.join(scratch, "base.txt");
    await Deno.writeTextFile(baseFile, "base\n");
    await gitIn(scratch, ["add", "base.txt"]);
    await gitIn(scratch, ["commit", "-q", "-m", "base"]);
    const base = (await gitIn(scratch, ["rev-parse", "HEAD"])).stdout.trim();
    assert(base.length === 40, `the scratch clone must have a commit, got '${base}'`);
    await gitIn(scratch, ["update-ref", "refs/remotes/origin/main", base]);
    await gitIn(scratch, ["branch", "fleet/bad", base]);
    assertEquals((await gitIn(scratch, ["init", "-q", "--bare", bare])).code, 0);

    // ARM, exactly as `deno task test:fast` and `deno task gate` do.
    const armed = await armClone(path.join(scratch, ".git"), home);
    assertEquals(armed.code, 0, `hooks:install must arm a clone: ${armed.log}`);
    assertStringIncludes(armed.log, "pre-push guard armed");

    // "Armed" is a claim about the files git will execute: read them back. Built with path.join over
    // runtime variables, the idiom the 25hc test above uses: these paths are in a temp clone, and a
    // template that LOOKS like a repo path (`<tmp>/.git/hooks/...`) is an unresolvable read hint to
    // the fast gate's DERIVED relation, which then cannot call any file inert (audio-feed-q0ky).
    const scratchHooks = path.join(scratch, ".git", "hooks");
    const hookPath = path.join(scratchHooks, "pre-push");
    const standalonePath = path.join(scratchHooks, "audio-feed-pre-push");
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
    // audio-feed-qqs6: and it must NOT claim a state it did not measure. This assertion used to
    // require the text "The guard is NOT armed" here, which was a false claim in the concurrency
    // races (the guard WAS armed, and verify said so while the installer said otherwise): a message
    // that contradicts the state it describes teaches readers to ignore the real alarms too.
    assert(
      !stderr.includes("The guard is NOT armed"),
      `a failed install must not claim the guard is unarmed: ${stderr}`,
    );
    assertStringIncludes(stderr, "hooks:verify");
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

    const armed = await armClone(path.join(scratch, ".git"), home);
    assertEquals(armed.code, 0, `hooks:install must arm the scratch clone: ${armed.log}`);
    assertEquals((await prepushGuardStatus(scratch)).state, "armed");

    // The "installed hook was removed" mutation, detected by name: the chained hook file is left
    // intact, and only the guard it executes is gone.
    await Deno.remove(path.join(scratch, ".git", "hooks", "audio-feed-pre-push"));
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

Deno.test("audio-feed-p2la: the verify STEP runs with the shipped permissions and fails closed in a clone with no installed guard", async () => {
  // The requirement this test exists for (audio-feed-p2la, reviewer fact 4): the installed hook path
  // must be exercised under the permissions the SHIPPED step runs with, not this test process's
  // unrestricted ones. `deno task hooks:verify` is
  // `deno run --allow-read --allow-run=git scripts/hooks/guard-status.ts` - fewer permissions than the
  // gate that hosts it - so the child below is spawned with exactly those flags, in a scratch clone
  // that has no installed guard. A previous attempt was green because it ran the INSTALLER directly
  // with unrestricted permissions: it proved the installer works, not that the gate is guarded.
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    assertEquals((await gitIn(scratch, ["init", "-q", "-b", "main"])).code, 0);
    // The verify script locates the clone it guards from ITS OWN path, so the clone gets its own copy
    // and the child below runs THAT one — running the repo's copy against cwd=clone would measure the
    // repo, which is exactly the mistake this test would then fail to catch.
    const scriptInClone = path.join(scratch, "scripts", "hooks", "guard-status.ts");
    await Deno.mkdir(path.join(scratch, "scripts", "hooks"), { recursive: true });
    await Deno.copyFile(GUARD_STATUS_PATH, scriptInClone);
    const flags = ["run", "--allow-read", "--allow-run=git", scriptInClone];
    const env = { ...Deno.env.toObject() };
    delete env.GIT_DIR; // the scratch clone must be discovered, not overridden
    const verify = async () =>
      await new Deno.Command("deno", {
        args: flags,
        cwd: scratch,
        env,
        stdout: "piped",
        stderr: "piped",
      })
        .output();

    const unarmed = await verify();
    const unarmedOut = new TextDecoder().decode(unarmed.stderr);
    assertEquals(
      unarmed.code,
      1,
      `a clone with no installed guard must FAIL the verify step: ${unarmedOut}`,
    );
    assertStringIncludes(unarmedOut, "pre-push guard is NOT armed (audio-feed-p2la)");
    assertStringIncludes(unarmedOut, "does not carry the chain block");

    const arm = await armClone(path.join(scratch, ".git"), home);
    assertEquals(arm.code, 0, `arming the scratch clone must succeed: ${arm.log}`);
    const armed = await verify();
    const armedOut = new TextDecoder().decode(armed.stdout);
    assertEquals(armed.code, 0, `the verify step must pass in an armed clone: ${armedOut}`);
    assertStringIncludes(armedOut, "pre-push guard verified");

    // The "installed hook was removed" mutation is caught by the shipped step itself.
    await Deno.remove(path.join(scratch, ".git", "hooks", "audio-feed-pre-push"));
    const stripped = await verify();
    const strippedOut = new TextDecoder().decode(stripped.stderr);
    assertEquals(stripped.code, 1, "a removed guard must fail the verify step");
    assertStringIncludes(strippedOut, "audio-feed-pre-push");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

/**
 * audio-feed-qqs6: run the INSTALLER directly in a scratch clone, the way both gate tasks' first
 * step does, so a test can overlap two of them. GIT_DIR is removed from the environment on purpose:
 * the clone under test must be the one discovered by `git rev-parse`, not one the suite pointed at.
 */
async function runInstaller(
  cwd: string,
  home: string,
  env: Record<string, string> = {},
): Promise<{ code: number; log: string }> {
  const inherited = { ...Deno.env.toObject() };
  delete inherited.GIT_DIR;
  const out = await new Deno.Command("bash", {
    args: ["scripts/hooks/install-hooks.sh"],
    cwd,
    env: { ...inherited, HOME: home, ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code: out.code, log: decoder.decode(out.stdout) + decoder.decode(out.stderr) };
}

/** A one-commit seed repository holding the two hook files, so a scratch clone can be armed. */
async function seedRepo(scratch: string): Promise<{ seed: string; clone: string }> {
  const seed = path.join(scratch, "seed");
  await Deno.mkdir(path.join(seed, "scripts", "hooks"), { recursive: true });
  await Deno.copyFile(HOOK_PATH, path.join(seed, "scripts", "hooks", "pre-push"));
  await Deno.copyFile(INSTALL_PATH, path.join(seed, "scripts", "hooks", "install-hooks.sh"));
  assertEquals((await gitIn(seed, ["init", "-q", "-b", "main"])).code, 0);
  await gitIn(seed, ["config", "user.email", "guard@example.com"]);
  await gitIn(seed, ["config", "user.name", "Guard Test"]);
  await Deno.writeTextFile(path.join(seed, "base.txt"), "base\n");
  await gitIn(seed, ["add", "-A"]);
  await gitIn(seed, ["commit", "-q", "-m", "base"]);
  const clone = path.join(scratch, "clone");
  assertEquals((await gitIn(scratch, ["clone", "-q", seed, clone])).code, 0);
  return { seed, clone };
}

Deno.test("audio-feed-qqs6: overlapping installs from two worktrees of ONE clone never report a named failure, and leave the guard armed", async () => {
  // The reviewer's repro shape, bounded: two installs at once, repeatedly. A linked worktree resolves
  // `--git-common-dir` to the same .git as the clone, which is where the guard AND the lock live, so
  // this is exactly the contention two lanes gating on this VM produce. Before the fix this ran
  // ~35% named failures (measured on d43c263c: 83/240), each with a message claiming the guard was
  // NOT armed while the guard was in fact armed.
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    const { clone } = await seedRepo(scratch);
    const wt = path.join(scratch, "wt");
    assertEquals(
      (await gitIn(clone, ["worktree", "add", "-q", "--detach", wt, "main"])).code,
      0,
    );
    // A DIFFERENT guard in the second worktree, which is the variant that failed hardest before the
    // fix (the reviewer measured 141/240 with one added comment line): the two installs then want
    // different bytes in one shared file.
    await Deno.writeTextFile(
      path.join(wt, "scripts", "hooks", "pre-push"),
      (await Deno.readTextFile(path.join(wt, "scripts", "hooks", "pre-push"))) +
        "# a different worktree\n",
    );

    for (let round = 0; round < 10; round++) {
      const [a, b] = await Promise.all([
        runInstaller(clone, home),
        runInstaller(wt, home),
      ]);
      for (const [who, run] of [["clone", a], ["worktree", b]] as const) {
        assert(
          !run.log.includes("FAILED"),
          `overlapping installs must not produce a named failure (round ${round}, ${who}): ${run.log}`,
        );
        assert(
          /guard (already )?armed/.test(run.log),
          `every invocation must report an armed guard, so "no failure" cannot be a silent no-op (round ${round}, ${who}): ${run.log}`,
        );
        assertEquals(run.code, 0, `installer exit code (round ${round}, ${who}): ${run.log}`);
      }
    }

    assertEquals(
      (await prepushGuardStatus(clone)).state,
      "armed",
      "after overlapping installs the shared clone must still measure armed",
    );
    assertEquals(
      (await prepushGuardStatus(wt)).state,
      "armed",
      "and so must the linked worktree that shares its hooks directory",
    );
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-qqs6: the installer serialises on a lock, steals a DEAD holder, and fails closed by name while a live holder is in flight", async () => {
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    const { clone } = await seedRepo(scratch);
    const lockDir = path.join(clone, ".git", "audio-feed-p2la.lock");
    const lockPid = path.join(lockDir, "pid");

    // (1) A DEAD HOLDER IS NOT A LOCK. A killed install must not wedge every later gate on this VM,
    // so the installer removes a lock whose recorded pid is gone and installs.
    const finished = new Deno.Command("bash", { args: ["-c", "exit 0"] }).spawn();
    const deadPid = finished.pid;
    await finished.status;
    await Deno.mkdir(lockDir, { recursive: true });
    await Deno.writeTextFile(lockPid, `${deadPid}\n`);
    const stole = await runInstaller(clone, home, { AF_INSTALL_LOCK_WAIT_STEPS: "40" });
    assertEquals(stole.code, 0, `a dead holder must not block an install: ${stole.log}`);
    assertStringIncludes(stole.log, "guard armed");
    assert(
      !(await Deno.stat(lockDir).then(() => true).catch(() => false)),
      "the installer must release the lock",
    );

    // (2) A LIVE HOLDER IS RESPECTED, AND THE RESULT IS A NAMED FAILURE, not a green run: the install
    // waits, gives up, and says what it measured. It does not skip its checks to produce a pass, and
    // it does not claim the guard is unarmed - which is the false message two findings named.
    await Deno.mkdir(lockDir, { recursive: true });
    await Deno.writeTextFile(lockPid, `${Deno.pid}\n`);
    const blocked = await runInstaller(clone, home, { AF_INSTALL_LOCK_WAIT_STEPS: "2" });
    assertEquals(blocked.code, 1, `a live holder must produce a failure: ${blocked.log}`);
    assertStringIncludes(blocked.log, "has held the lock");
    // The message names the holder it MEASURED, so a reader can tell this state from a lock that records
    // nobody at all (audio-feed-pvjg).
    assertStringIncludes(blocked.log, `(pid ${Deno.pid})`);
    assertStringIncludes(blocked.log, "hooks:verify");
    assert(
      !blocked.log.includes("The guard is NOT armed"),
      `the installer must not report a state it did not measure: ${blocked.log}`,
    );
    assertEquals(
      (await prepushGuardStatus(clone)).state,
      "armed",
      "the install armed in (1) is untouched: the blocked installer wrote nothing",
    );

    // (3) Releasing the lock lets the very next install proceed.
    await Deno.remove(lockDir, { recursive: true });
    const after = await runInstaller(clone, home);
    assertEquals(
      after.code,
      0,
      `the same install must proceed once the lock is free: ${after.log}`,
    );
    assert(/guard (already )?armed/.test(after.log));
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-p2la: a second install is a verified no-op, and a failure names the cause instead of claiming a state it did not measure", async () => {
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    const { clone } = await seedRepo(scratch);

    const first = await runInstaller(clone, home);
    assertEquals(first.code, 0, first.log);
    assertStringIncludes(first.log, "guard armed");

    // Idempotent: same tree, already byte-identical, so there is nothing to write and the install says
    // exactly that rather than rewriting the hook or claiming a fresh install.
    const second = await runInstaller(clone, home);
    assertEquals(second.code, 0, second.log);
    assertStringIncludes(second.log, "already armed");
    assertEquals((await prepushGuardStatus(clone)).state, "armed");

    // The failure message must describe only what was measured. Here the tree's guard script is gone
    // while the INSTALLED guard is still in place and still fires: the old text ("The guard is NOT
    // armed") was therefore false at the very moment it was printed, which is the class of claim
    // audio-feed-qqs6 and the installer's own finding both named.
    await Deno.rename(
      path.join(clone, "scripts", "hooks", "pre-push"),
      path.join(clone, "scripts", "hooks", "pre-push.away"),
    );
    const missing = await runInstaller(clone, home);
    assertEquals(missing.code, 1, `a missing guard script must fail: ${missing.log}`);
    assertStringIncludes(missing.log, "the guard itself is missing");
    assertStringIncludes(missing.log, "hooks:verify");
    assert(
      !missing.log.includes("The guard is NOT armed"),
      `the installer must not report a state it did not measure: ${missing.log}`,
    );
    assertEquals(
      (await prepushGuardStatus(clone)).state,
      "armed",
      "and the measurement disagrees with the old message on purpose: the installed guard is intact",
    );
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-elnk: the shared reader accepts every comment placement Deno accepts, so an inline comment cannot redden the gate", () => {
  const inline = `{
  // whole-line
  "tasks": { "a": "bash x" }, // inline, which the old whole-line strip left in place
  "fmt": { "include": ["src"] }
}`;
  const parsed = parseJsonc<{ tasks?: Record<string, string>; fmt?: { include?: string[] } }>(
    inline,
  );
  assertEquals(parsed.tasks?.a, "bash x");
  assertEquals(parsed.fmt?.include, ["src"]);

  // A `//` inside a VALUE is not a comment, and a block comment is removed.
  const tricky = `{
  "tasks": { "u": "echo https://example.com/x" }, /* block */
  "fmt": { "include": [] }
}`;
  assertEquals(
    parseJsonc<{ tasks: Record<string, string> }>(tricky).tasks.u,
    "echo https://example.com/x",
  );

  const trailing = `{"tasks": {"b": "y"}}// no newline at end`;
  assertEquals(parseJsonc<{ tasks: Record<string, string> }>(trailing).tasks.b, "y");
});

Deno.test("audio-feed-pvjg: a lock directory with NO recorded holder is stolen after the bounded wait instead of naming a holder that does not exist", async () => {
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    const { clone } = await seedRepo(scratch);
    const lockDir = path.join(clone, ".git", "audio-feed-p2la.lock");
    // The state a kill leaves behind: `mkdir` and the pid write are two syscalls, so a creator killed in
    // between leaves a lock directory that names nobody. Before this fix that directory wedged every
    // later install on this VM for good (& the reviewer showed it never self-healed), and each one failed
    // with "another install has held the lock" - naming a holder the installer never measured. A live
    // creator records its pid within microseconds, so the absence of one after a full bounded wait IS the
    // evidence, and the lock is stolen.
    await Deno.mkdir(lockDir, { recursive: true });
    const stolen = await runInstaller(clone, home, { AF_INSTALL_LOCK_WAIT_STEPS: "4" });
    assertEquals(
      stolen.code,
      0,
      `a lock with no recorded holder must be stolen, not wedge the install: ${stolen.log}`,
    );
    assertStringIncludes(stolen.log, "guard armed");
    assert(
      !stolen.log.includes("has held the lock"),
      `the message must not name a holder it did not measure: ${stolen.log}`,
    );
    const lockLeft = await Deno.stat(lockDir).then(() => true).catch(() => false);
    assert(!lockLeft, "the stolen lock directory must not be left behind");
    assertEquals((await prepushGuardStatus(clone)).state, "armed");

    // Self-healed: the very next install is an ordinary no-op on an armed clone.
    const again = await runInstaller(clone, home, { AF_INSTALL_LOCK_WAIT_STEPS: "4" });
    assertEquals(again.code, 0, `the lock must be gone for good: ${again.log}`);
    assertStringIncludes(again.log, "already armed");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-pvjg: a holderless lock that CANNOT be stolen fails by name without inventing a holder", async () => {
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  try {
    const { clone } = await seedRepo(scratch);
    const gitDir = path.join(clone, ".git");
    await Deno.mkdir(path.join(gitDir, "audio-feed-p2la.lock"), { recursive: true });
    // Make the steal impossible without making the state ambiguous: a read-only .git still supports the
    // reads the installer does, and nothing can be unlinked from it, so the one steal attempt fails.
    await Deno.chmod(gitDir, 0o500);
    try {
      const blocked = await runInstaller(clone, home, { AF_INSTALL_LOCK_WAIT_STEPS: "2" });
      assertEquals(blocked.code, 1, `the install must fail closed: ${blocked.log}`);
      assertStringIncludes(blocked.log, "NO recorded holder");
      assert(
        !blocked.log.includes("has held the lock"),
        `the message must not invent a holder: ${blocked.log}`,
      );
      assertStringIncludes(blocked.log, "hooks:verify");
    } finally {
      await Deno.chmod(gitDir, 0o755);
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("audio-feed-elnk: the shipped deno.json reads through the shared JSONC reader", async () => {
  const parsed = await readJsonc<{ tasks?: Record<string, string> }>(path.join(ROOT, "deno.json"));
  assertEquals(typeof parsed.tasks?.["hooks:install"], "string");
});

Deno.test("audio-feed-p2la: both gate tasks ARM and VERIFY the pre-push guard as their FIRST two steps", async () => {
  // The gate's own assertion (above) catches a missing guard, and this pins the wiring that makes
  // the assertion satisfiable: `deno task test:fast` and `deno task gate` must arm the guard before
  // they run anything. It is a shape assertion rather than a behavioural one because running a gate
  // from inside a gate is recursive; the behavioural half is the scratch-clone tests above plus
  // scripts/fast-check.ts's own check, which exits non-zero when this step has gone missing.
  // The file is read through the shared JSONC reader so a comment placement Deno accepts cannot make
  // this assertion throw instead of naming what is wrong (audio-feed-elnk).
  const denoJson = await readJsonc<{ tasks?: Record<string, string> }>(
    path.join(ROOT, "deno.json"),
  );
  const tasks = denoJson.tasks ?? {};

  const installer = tasks["hooks:install"];
  assert(installer, "the hooks:install task exists");
  assertStringIncludes(installer, "install-hooks.sh");

  const verifier = tasks["hooks:verify"];
  assert(verifier, "the hooks:verify task exists");
  assertStringIncludes(verifier, "scripts/hooks/guard-status.ts");

  for (const task of ["test:fast", "gate"]) {
    const command = tasks[task];
    assert(command, `the ${task} task exists`);
    assert(
      command.startsWith("deno task hooks:install && deno task hooks:verify && "),
      `the ${task} task must arm AND verify the pre-push guard BEFORE it runs anything: ${command} (audio-feed-p2la)`,
    );
  }
});
