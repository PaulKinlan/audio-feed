import { assert, assertEquals } from "@std/assert";

const CONTRACTS_PATH = new URL("./contracts.json", import.meta.url).pathname;

interface ContractMapping {
  [pattern: string]: string[];
}

function loadContracts(): ContractMapping {
  const content = Deno.readTextFileSync(CONTRACTS_PATH);
  return JSON.parse(content) as ContractMapping;
}

Deno.test("contracts.json is valid and targets real suites", () => {
  const contracts = loadContracts();
  assert(Object.keys(contracts).length > 0, "contracts.json must not be empty");

  for (const [pattern, suites] of Object.entries(contracts)) {
    assert(pattern.length > 0, "pattern must be non-empty");
    assert(
      Array.isArray(suites) && suites.length > 0,
      `pattern ${pattern} must map to non-empty suite array`,
    );
    for (const suite of suites) {
      assert(suite.startsWith("tests/"), `suite ${suite} must start with tests/`);
      const fullPath = new URL(`../${suite}`, import.meta.url).pathname;
      const stat = Deno.statSync(fullPath);
      assert(stat.isFile, `suite ${suite} must exist on disk`);
    }
  }
});

Deno.test("contracts.json covers audio-feed-2i3y and audio-feed-ey8i storage subsystem mappings", () => {
  const contracts = loadContracts();

  // audio-feed-2i3y: scripts/exww-section-measures.ts and proof
  assertEquals(
    contracts["scripts/exww-section-measures.ts"],
    ["tests/exww_band_floor_test.ts"],
    "exww section measures must map to exww_band_floor_test",
  );
  assertEquals(
    contracts["scripts/exww-live-claims-browser-proof.ts"],
    ["tests/exww_mutants_test.ts"],
    "exww live claims proof must map to exww_mutants_test",
  );

  assertEquals(
    contracts["src/storage/kv.ts"],
    ["tests/storage_test.ts"],
    "src/storage/kv.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/kv/**"],
    ["tests/storage_test.ts"],
    "src/storage/kv/** must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/memory.ts"],
    ["tests/storage_test.ts"],
    "src/storage/memory.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/memory/**"],
    ["tests/storage_test.ts"],
    "src/storage/memory/** must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/mod.ts"],
    ["tests/storage_test.ts"],
    "src/storage/mod.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/log_shape.ts"],
    ["tests/storage_test.ts"],
    "src/storage/log_shape.ts must map to tests/storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/s3.ts"],
    ["tests/s3_abort_socket_test.ts"],
    "src/storage/s3.ts must map to S3 suite, NOT storage_test.ts",
  );
  assertEquals(
    contracts["src/storage/legacy_audio.ts"],
    ["tests/legacy_audio_inventory_test.ts"],
    "src/storage/legacy_audio.ts must map to legacy_audio_inventory_test.ts",
  );
  assertEquals(
    contracts["src/storage/episode_events.ts"],
    ["tests/admin_observability_test.ts"],
    "src/storage/episode_events.ts must map to admin_observability_test.ts",
  );
  assertEquals(
    contracts["src/storage/bounded.ts"],
    ["tests/synthesis_unsigned_write_test.ts"],
    "src/storage/bounded.ts must map to synthesis_unsigned_write_test.ts",
  );
  assertEquals(
    contracts["tests/conformance/**"],
    ["tests/storage_test.ts"],
    "tests/conformance/** must map to tests/storage_test.ts",
  );
});

// ---------------------------------------------------------------------------------------------
// audio-feed-byuy: the `check-coverage.py` acceptance test that lived here is DELETED, not fixed.
//
// Why: its subject was never this repository. It executed
// /home/exedev/fleet/remote/check-coverage.py by absolute path and asserted that script's own JSON
// output (two-sided mapping, the omitted hint, unmapped), using tests/contracts.json only as its
// input. That made the suite's meaning depend on the machine it ran on: anywhere without that exact
// host layout it returned early and passed WITHOUT checking anything, and on a fleet VM it reddened
// this repo whenever the host tree changed for the host's own reasons (fleet-bv0md: that file is
// edited in place and already cites lines of this repo's tests).
//
// The half of the contract this repo owns is still checked here, above: every entry of
// tests/contracts.json is asserted by name - including the glob keys `src/storage/kv/**`,
// `src/storage/memory/**` and `tests/conformance/**` - and every suite each entry names is asserted
// to exist on disk.
//
// The consumer's half belongs to the suite that owns the script, which has it:
// ~/fleet/tests/check-coverage.test.sh (45 assertions over its own generated fixture repos,
// including the two-sided mapping, the omitted hint and unmapped reporting).
//
// GAP, named rather than left silent: that host suite has no glob/fnmatch case, so "the classifier
// expands a `**` key from this repo's contracts.json" is now checked nowhere. It belongs host-side,
// in ~/fleet/tests/check-coverage.test.sh fed by a fixture contracts file - not here, by reading
// another repository's script from this repo's suite.
// ---------------------------------------------------------------------------------------------
