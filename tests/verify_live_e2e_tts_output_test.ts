/**
 * audio-feed-v20a: verify live E2E TTS proof preserves committed evidence by default,
 * routing runtime verification evidence to uncommitted var/ by default and only writing
 * to docs/evidence/audio-feed-9vns/ when explicitly requested via --write-committed-evidence.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { resolveEvidenceOutputDir } from "../scripts/verify_live_e2e_tts.ts";

Deno.test("audio-feed-v20a: default run routes evidence to uncommitted var/ to protect committed docs", () => {
  const result = resolveEvidenceOutputDir([]);
  assertEquals(result.dir, "var/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, false);
});

Deno.test("audio-feed-v20a: explicit out-dir override is respected and marked uncommitted", () => {
  const result = resolveEvidenceOutputDir(["--out-dir=/tmp/custom-run"]);
  assertEquals(result.dir, "/tmp/custom-run");
  assertEquals(result.isCommitted, false);
});

Deno.test("audio-feed-v20a: --write-committed-evidence routes to committed evidence directory", () => {
  const result = resolveEvidenceOutputDir(["--write-committed-evidence"]);
  assertEquals(result.dir, "docs/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, true);
});

Deno.test("audio-feed-v20a: --update-evidence routes to committed evidence directory", () => {
  const result = resolveEvidenceOutputDir(["--update-evidence"]);
  assertEquals(result.dir, "docs/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, true);
});

Deno.test("audio-feed-ulab: --out-dir targeting committed directory without --write-committed-evidence throws error", () => {
  assertThrows(
    () => resolveEvidenceOutputDir(["--out-dir=docs/evidence/audio-feed-9vns"]),
    Error,
    "Refusing to overwrite committed evidence",
  );
  assertThrows(
    () => resolveEvidenceOutputDir(["--out-dir=docs/evidence/audio-feed-9vns/../audio-feed-9vns"]),
    Error,
    "Refusing to overwrite committed evidence",
  );
});

Deno.test("audio-feed-ulab: --out-dir targeting committed directory WITH --write-committed-evidence succeeds and is marked committed", () => {
  const result = resolveEvidenceOutputDir([
    "--out-dir=docs/evidence/audio-feed-9vns",
    "--write-committed-evidence",
  ]);
  assertEquals(result.dir, "docs/evidence/audio-feed-9vns");
  assertEquals(result.isCommitted, true);
});
