/**
 * audio-feed-9ara — the closed-[modern-web] premise-verdict check.
 *
 * The unit cases pin what counts as "recorded" (comment OR substantive close reason), and the
 * CLI cases drive the real script with a fake `bd` so the subprocess path is exercised.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  hasRecordedVerdict,
  isModernWebBead,
  verdictViolations,
} from "../scripts/check-modern-web-verdicts.ts";
import type { BeadRow } from "../scripts/check-modern-web-verdicts.ts";

function row(over: Partial<BeadRow> = {}): BeadRow {
  return {
    id: "audio-feed-x",
    title: "[modern-web] Something (some-guide-id)",
    status: "closed",
    close_reason: "Closed",
    comment_count: 0,
    ...over,
  };
}

Deno.test("9ara: the default reason with no comments is the violation this check exists for", () => {
  assertEquals(verdictViolations([row()]).map((r) => r.id), ["audio-feed-x"]);
});

Deno.test("9ara: a comment records the verdict", () => {
  assertEquals(verdictViolations([row({ comment_count: 1 })]), []);
  assertEquals(hasRecordedVerdict(row({ comment_count: 2 })), true);
});

Deno.test("9ara: a substantive close reason records the verdict", () => {
  assertEquals(
    verdictViolations([row({ close_reason: "Audited codebase: no custom JS tooltips exist." })]),
    [],
  );
  // bd's placeholder reason records nothing, whatever its case.
  assertEquals(hasRecordedVerdict(row({ close_reason: "closed" })), false);
  assertEquals(hasRecordedVerdict(row({ close_reason: "  " })), false);
});

Deno.test("9ara: only closed modern-web beads are in scope", () => {
  assertEquals(verdictViolations([row({ status: "open" })]), []);
  assertEquals(verdictViolations([row({ status: "in_progress" })]), []);
  assertEquals(verdictViolations([row({ title: "A plain secret-scan finding" })]), []);
  assertEquals(isModernWebBead(row()), true);
  assertEquals(isModernWebBead(row({ title: "[factory:modern-web] x (id)" })), false);
});

/** A fake `bd` that answers `list` with a fixture and nothing else. */
async function fakeBd(dir: string, rows: BeadRow[]): Promise<string> {
  const path = `${dir}/bd`;
  await Deno.writeTextFile(
    path,
    `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(rows)}\nJSON\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

function runChecker(bdBin: string): { code: number; stdout: string; stderr: string } {
  const res = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "scripts/check-modern-web-verdicts.ts", "--bd-bin", bdBin],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return {
    code: res.code,
    stdout: new TextDecoder().decode(res.stdout),
    stderr: new TextDecoder().decode(res.stderr),
  };
}

Deno.test("9ara: the CLI passes when every closed bead records a verdict", async () => {
  const dir = await Deno.makeTempDir({ prefix: "af-9ara-" });
  try {
    const bd = await fakeBd(dir, [
      row({ id: "audio-feed-a", close_reason: "Landed at commit abc123" }),
      row({ id: "audio-feed-b", comment_count: 1 }),
      row({ id: "audio-feed-c", status: "open" }),
    ]);
    const res = runChecker(bd);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "every closed [modern-web] bead records a premise verdict");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("9ara: the CLI fails and names the bead when a verdict is missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "af-9ara-" });
  try {
    const bd = await fakeBd(dir, [
      row({ id: "audio-feed-a", close_reason: "Landed at commit abc123" }),
      row({ id: "audio-feed-silent", title: "[modern-web] Silent one (anchor-positioning)" }),
    ]);
    const res = runChecker(bd);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "audio-feed-silent");
    assertStringIncludes(res.stderr, "premise verdict");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("9ara: the CLI fails closed (exit 1) when bd itself fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "af-9ara-" });
  try {
    const path = `${dir}/bd`;
    await Deno.writeTextFile(path, "#!/usr/bin/env bash\necho 'bd is unavailable' >&2\nexit 2\n");
    await Deno.chmod(path, 0o755);
    const res = runChecker(path);
    assertEquals(res.code, 1);
    assertStringIncludes(res.stderr, "check could not run");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
