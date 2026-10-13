/**
 * audio-feed-ng60: verify pre-push hook prevents pushing non-gated trees
 * and prevents accidentally publishing origin/main onto a fleet/* feature branch.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ROOT = new URL("..", import.meta.url).pathname;
const HOOK_PATH = `${ROOT}/scripts/hooks/pre-push`;

async function runHook(
  input: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(HOOK_PATH, {
    args: ["origin", "git@github.com:PaulKinlan/audio-feed.git"],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      ...env,
    },
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

Deno.test("audio-feed-ng60: pre-push hook refuses pushing origin/main onto a fleet/* branch", async () => {
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

Deno.test("audio-feed-ng60: pre-push hook permits pushing feature commits onto fleet/* branch", async () => {
  const headShaOut = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: ROOT,
  }).output();
  const headSha = new TextDecoder().decode(headShaOut.stdout).trim();

  // If HEAD is not equal to origin/main, test with HEAD; otherwise dummy SHA
  const mainShaOut = await new Deno.Command("git", {
    args: ["rev-parse", "origin/main"],
    cwd: ROOT,
  }).output();
  const mainSha = new TextDecoder().decode(mainShaOut.stdout).trim();

  const testSha = headSha !== mainSha ? headSha : "1111111111111111111111111111111111111111";
  const line =
    `refs/heads/fleet/test-feature ${testSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
  const result = await runHook(line, { FLEET_REQUIRE_GATED_PUSH: "0" });

  assertEquals(result.code, 0, `Feature push should be permitted: ${result.stderr}`);
});

Deno.test("audio-feed-ng60: pre-push hook refuses pushing non-gated tree under FLEET_REQUIRE_GATED_PUSH=1", async () => {
  const headShaOut = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: ROOT,
  }).output();
  const headSha = new TextDecoder().decode(headShaOut.stdout).trim();

  // Use a synthetic tree with no check record by overriding HOME
  const tmpHome = await Deno.makeTempDir();
  try {
    const line =
      `refs/heads/fleet/test-feature ${headSha} refs/heads/fleet/test-feature 0000000000000000000000000000000000000000\n`;
    const result = await runHook(line, {
      HOME: tmpHome,
      FLEET_REQUIRE_GATED_PUSH: "1",
    });

    assertEquals(result.code, 1, "Hook must refuse ungated tree when FLEET_REQUIRE_GATED_PUSH=1");
    assertStringIncludes(result.stderr, "has no passing fleet-check record");
  } finally {
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("audio-feed-ng60: pre-push hook permits pushing gated tree under FLEET_REQUIRE_GATED_PUSH=1", async () => {
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
      JSON.stringify({ state: "PASS", tree: headTree }),
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
