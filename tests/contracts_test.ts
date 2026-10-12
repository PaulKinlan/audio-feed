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

Deno.test("contracts.json covers audio-feed-ey8i storage subsystem mappings", () => {
  const contracts = loadContracts();

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

Deno.test("check-coverage.py acceptance: two-sided mapping, omission, and unmapped checks", async () => {
  const covScript = "/home/exedev/fleet/remote/check-coverage.py";
  try {
    const stat = await Deno.stat(covScript);
    if (!stat.isFile) return;
  } catch {
    // If not running on a fleet VM with check-coverage.py, skip runner execution test
    return;
  }

  const dir = await Deno.makeTempDir();
  try {
    const invokeGit = async (args: string[]) => {
      const c = new Deno.Command(args[0]!, { args: args.slice(1), cwd: dir });
      const res = await c.output();
      if (!res.success) throw new Error(`Command failed: ${args.join(" ")}`);
    };
    await invokeGit(["git", "init", "-b", "main"]);
    await invokeGit(["git", "config", "user.name", "Test"]);
    await invokeGit(["git", "config", "user.email", "test@example.com"]);
    await Deno.writeTextFile(`${dir}/README.md`, "# Test");
    await invokeGit(["git", "add", "README.md"]);
    await invokeGit(["git", "commit", "-m", "init"]);
    await invokeGit(["git", "checkout", "-b", "feature"]);

    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    await Deno.mkdir(`${dir}/src/storage/kv`, { recursive: true });
    await Deno.copyFile(CONTRACTS_PATH, `${dir}/tests/contracts.json`);
    await Deno.writeTextFile(`${dir}/src/storage/kv/runs.ts`, "export const runs = [];");
    await invokeGit(["git", "add", "."]);
    await invokeGit(["git", "commit", "-m", "add storage run"]);

    const sha = new TextDecoder().decode(
      (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir }).output()).stdout,
    ).trim();

    // 1. Mapped when run: storage_test.ts ran -> unmapped is empty
    const logPath = `${dir}/gate.log`;
    await Deno.writeTextFile(
      logPath,
      "fast-gate: ran: tests/storage_test.ts\nfast-gate: passed: tests/storage_test.ts\n",
    );
    const cmd1 = new Deno.Command("python3", {
      args: [covScript, logPath, dir, sha, "deno task test:fast"],
    });
    const res1 = await cmd1.output();
    const out1 = JSON.parse(new TextDecoder().decode(res1.stdout));
    assertEquals(out1.unmapped, [], "warning must be ABSENT when storage_test.ts ran");
    assertEquals(out1.omitted, [], "omitted must be empty");

    // 2. Omitted when not run: other test ran, storage_test.ts omitted -> unmapped with omitted suite
    await Deno.writeTextFile(
      logPath,
      "fast-gate: ran: tests/other_test.ts\nfast-gate: passed: tests/other_test.ts\n",
    );
    const cmd2 = new Deno.Command("python3", {
      args: [covScript, logPath, dir, sha, "deno task test:fast"],
    });
    const res2 = await cmd2.output();
    const out2 = JSON.parse(new TextDecoder().decode(res2.stdout));
    assertEquals(
      out2.unmapped,
      ["src/storage/kv/runs.ts"],
      "warning must be PRESENT when storage_test.ts was omitted",
    );
    assertEquals(out2.omitted, ["tests/storage_test.ts"], "omitted suite must be named");

    // 3. S3 isolation: S3 suite covers S3 without triggering omitted storage_test.ts
    const s3Dir = await Deno.makeTempDir();
    try {
      const s3Git = async (args: string[]) => {
        const c = new Deno.Command(args[0]!, { args: args.slice(1), cwd: s3Dir });
        const res = await c.output();
        if (!res.success) throw new Error(`Command failed: ${args.join(" ")}`);
      };
      await s3Git(["git", "init", "-b", "main"]);
      await s3Git(["git", "config", "user.name", "Test"]);
      await s3Git(["git", "config", "user.email", "test@example.com"]);
      await Deno.writeTextFile(`${s3Dir}/README.md`, "# Test");
      await s3Git(["git", "add", "README.md"]);
      await s3Git(["git", "commit", "-m", "init"]);
      await s3Git(["git", "checkout", "-b", "feature"]);
      await Deno.mkdir(`${s3Dir}/tests`, { recursive: true });
      await Deno.mkdir(`${s3Dir}/src/storage`, { recursive: true });
      await Deno.copyFile(CONTRACTS_PATH, `${s3Dir}/tests/contracts.json`);
      await Deno.writeTextFile(`${s3Dir}/src/storage/s3.ts`, "export const blob = 1;");
      await s3Git(["git", "add", "."]);
      await s3Git(["git", "commit", "-m", "add s3 blob storage"]);
      const shaS3 = new TextDecoder().decode(
        (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: s3Dir }).output())
          .stdout,
      ).trim();
      const s3Log = `${s3Dir}/gate.log`;
      await Deno.writeTextFile(
        s3Log,
        "fast-gate: ran: tests/s3_abort_socket_test.ts\nfast-gate: passed: tests/s3_abort_socket_test.ts\n",
      );
      const cmdS3 = new Deno.Command("python3", {
        args: [covScript, s3Log, s3Dir, shaS3, "deno task test:fast"],
      });
      const resS3 = await cmdS3.output();
      const outS3 = JSON.parse(new TextDecoder().decode(resS3.stdout));
      assertEquals(outS3.unmapped, [], "S3 change with S3 suite must not be unmapped");
      assertEquals(outS3.omitted, [], "S3 change must not flag storage_test.ts as omitted");
    } finally {
      await Deno.remove(s3Dir, { recursive: true });
    }

    // 4. Truly unmapped: uncontracted untested file is still reported unmapped
    await Deno.mkdir(`${dir}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${dir}/scripts/untested.ts`, "export const x = 42;");
    await invokeGit(["git", "add", "."]);
    await invokeGit(["git", "commit", "-m", "add untested"]);
    const sha3 = new TextDecoder().decode(
      (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: dir }).output()).stdout,
    ).trim();
    await Deno.writeTextFile(
      logPath,
      "fast-gate: ran: tests/storage_test.ts\nfast-gate: passed: tests/storage_test.ts\n",
    );
    const cmd3 = new Deno.Command("python3", {
      args: [covScript, logPath, dir, sha3, "deno task test:fast"],
    });
    const res3 = await cmd3.output();
    const out3 = JSON.parse(new TextDecoder().decode(res3.stdout));
    assert(
      out3.unmapped.includes("scripts/untested.ts"),
      "genuinely untested file must be reported unmapped",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
