import { assert, assertEquals } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { buildObservabilityReport, claimAttemptsFrom } from "../src/observability/admin_report.ts";
import type { LogRecord } from "../src/storage/mod.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

Deno.test("nm5h: empty failure reason is still a FAILED terminal claim in the admin report", async () => {
  const stores = memoryStores();
  const user = makeUser({ id: "nm5h-user" });
  await stores.metadata.putUser(user);
  const episode = makeEpisode({
    id: "nm5h-episode",
    userId: user.id,
    status: "pending",
    createdAt: "2026-10-11T09:00:00.000Z",
  });
  await stores.metadata.putEpisode(episode);
  const owner = "nm5h-worker";
  const claimed = await stores.metadata.claimEpisode(user.id, episode.id, {
    now: "2026-10-11T09:05:00.000Z",
    leaseMs: 60_000,
    owner,
    maxClaims: 3,
  });
  assert(claimed);
  assert(await stores.metadata.completeEpisode({ ...claimed, status: "failed", error: "" }, owner));

  // Real producer + store: the optional empty reason disappears, but the severity and
  // terminal duration remain. The reader must not call this successful.
  const records = await stores.metadata.listLogs();
  const terminal = records.find((record) => record.durationMs !== undefined);
  assert(terminal);
  assertEquals(terminal.reason, undefined);
  assertEquals(terminal.severity, "error");
  const [attempt] = claimAttemptsFrom(records, Date.parse("2026-10-11T09:06:00.000Z"));
  assertEquals(attempt?.endedWithTerminalWrite, true);
  assertEquals(attempt?.outcome, "failed");
  const report = await buildObservabilityReport(stores, Date.parse("2026-10-11T09:06:00.000Z"));
  assertEquals(report.attempts[episode.id]?.[0]?.outcome, "failed");
});

Deno.test("nm5h: stored terminal severity and optional reason variations retain outcomes", async () => {
  const store = memoryStores().metadata;
  const cases = [
    { label: "failed with text", severity: "error", reason: "provider failed", outcome: "failed" },
    { label: "failed with empty text", severity: "error", reason: "", outcome: "failed" },
    { label: "failed without reason", severity: "error", outcome: "failed" },
    { label: "finished without reason", severity: "info", outcome: "finished" },
    { label: "finished with empty text", severity: "info", reason: "", outcome: "finished" },
    {
      label: "legacy reason fallback",
      severity: "info",
      reason: "legacy failure",
      outcome: "failed",
    },
    // A truthy raw string can become an EMPTY-but-present value after control stripping.
    { label: "failure with stripped text", severity: "error", reason: "\u0001", outcome: "failed" },
  ] as const;
  for (const [index, item] of cases.entries()) {
    assert(
      await store.appendLog({
        time: "2026-10-11T09:00:00.000Z",
        severity: item.severity,
        type: "claim.lifecycle",
        process: "storage",
        message: item.label,
        phase: "uploading_audio",
        attempt: index + 1,
        durationMs: 0,
        ...("reason" in item ? { reason: item.reason } : {}),
      }),
    );
  }
  const records = await store.listLogs();
  assertEquals(records.map((record) => record.reason), [
    "provider failed",
    undefined,
    undefined,
    undefined,
    undefined,
    "legacy failure",
    "",
  ]);
  assertEquals(Object.hasOwn(records[6]!, "reason"), true);
  const attempts = claimAttemptsFrom(records, Date.parse("2026-10-11T09:01:00.000Z"));
  assertEquals(attempts.map((attempt) => attempt.outcome), cases.map((item) => item.outcome));
  assertEquals(attempts.map((attempt) => attempt.endedWithTerminalWrite), cases.map(() => true));
});

Deno.test("nm5h: structured abandonment and yield still outrank optional reason", () => {
  const base: LogRecord = {
    seq: 1,
    time: "2026-10-11T09:00:00.000Z",
    severity: "error",
    type: "claim.lifecycle",
    process: "storage",
    message: "claim transition",
    phase: "uploading_audio",
    attempt: 1,
  };
  const attempts = claimAttemptsFrom([
    { ...base, context: { workerState: "unknown" } },
    {
      ...base,
      seq: 2,
      attempt: 2,
      reason: "resuming next tick",
      context: { claimOutcome: "yielded" },
    },
  ], Date.parse("2026-10-11T09:01:00.000Z"));
  assertEquals(attempts.map((attempt) => [attempt.outcome, attempt.endedWithTerminalWrite]), [
    ["abandoned", false],
    ["retrying", false],
  ]);
});
