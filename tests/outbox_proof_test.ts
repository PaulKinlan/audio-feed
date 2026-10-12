/**
 * Anti-tests for outbox-proof console.log capture hook (audio-feed-qqxp).
 *
 * Verifies:
 * 1. An app-authored log line starting with "PASS " carrying subscriber capability URL
 *    is captured by the capture hook (provenance-based, not prefix-filtered) and causes
 *    outbox-proof to exit non-zero naming the leak surface.
 * 2. An app-authored log line starting with "PASS " containing no secret does not fail.
 *
 * Both tests copy scripts/outbox-proof.ts to a temporary file, inject the log line
 * immediately before the live scan, and execute the copy as a subprocess so that the
 * real capture hook is exercised without polluting the shipped script with mutation flags.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";

async function runProofWithInjectedLine(injectedLine: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
}> {
  const originalScriptPath = new URL("../scripts/outbox-proof.ts", import.meta.url).pathname;
  const originalSource = await Deno.readTextFile(originalScriptPath);

  const marker =
    "// Live scan: inspect real outbox payloads, captured server logs, and persisted run history";
  if (!originalSource.includes(marker)) {
    throw new Error(`Marker '${marker}' not found in scripts/outbox-proof.ts`);
  }

  const tempEvidenceDir = await Deno.makeTempDir({ prefix: "outbox-proof-test-evidence-" });
  // Ensure OUT points to the temporary evidence directory so that tests don't overwrite the committed README
  const modifiedSource = originalSource
    .replace(
      'const OUT = new URL("../docs/evidence/audio-feed-np5/", import.meta.url).pathname;',
      `const OUT = ${
        JSON.stringify(tempEvidenceDir.endsWith("/") ? tempEvidenceDir : tempEvidenceDir + "/")
      };`,
    )
    .replace(
      marker,
      `${injectedLine}\n    ${marker}`,
    );

  const scriptsDir = new URL("../scripts/", import.meta.url).pathname;
  const tempScriptPath = await Deno.makeTempFile({
    dir: scriptsDir,
    prefix: ".outbox-proof-test-",
    suffix: ".ts",
  });

  try {
    await Deno.writeTextFile(tempScriptPath, modifiedSource);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--unstable-kv", tempScriptPath],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    return {
      code: output.code,
      stdout,
      stderr,
      combined: `${stdout}\n${stderr}`,
    };
  } finally {
    try {
      await Deno.remove(tempScriptPath);
    } catch {
      // ignore
    }
    try {
      await Deno.remove(tempEvidenceDir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

Deno.test("outbox-proof: capture hook scans PASS-leading console.log line and exits non-zero on secret leak (audio-feed-qqxp)", async () => {
  const result = await runProofWithInjectedLine(
    "console.log(`PASS capability printed in server log: playerUrl=${n1.playerUrl}`);",
  );

  assertEquals(
    result.code,
    1,
    "proof must exit non-zero when capability URL appears in PASS-leading log line",
  );

  assertStringIncludes(
    result.combined,
    "no credentials, tokens, or admin secrets are echoed into server logs, run history, or notifications beyond subscriber player URL",
    "must name the failing check",
  );
  assertStringIncludes(
    result.combined,
    "capturedLog contains subscriber capability URL / token: PASS capability printed in server log: playerUrl=",
    "must name the leak surface and content",
  );
});

Deno.test("outbox-proof: capture hook permits PASS-leading console.log line with no secret and exits 0 (audio-feed-qqxp)", async () => {
  const result = await runProofWithInjectedLine(
    'console.log("PASS safe log line with no secrets");',
  );

  assertEquals(
    result.code,
    0,
    "proof must exit 0 when PASS-leading log line has no secret",
  );
  assertStringIncludes(result.stdout, "PASS safe log line with no secrets");
});
