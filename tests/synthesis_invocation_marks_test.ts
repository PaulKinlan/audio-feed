import { assert, assertEquals, assertRejects } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import type { AppConfig } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
  adminToken: "test-admin-token",
};

Deno.test("audio-feed-4nbt: invocation start is durable before queue discovery, even with no claim", async () => {
  const stores = memoryStores();
  const original = stores.metadata.listPendingEpisodes.bind(stores.metadata);
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => entered = resolve);
  let release!: () => void;
  stores.metadata.listPendingEpisodes = () => {
    entered();
    return new Promise((resolve) => {
      release = () => resolve({ episodes: [] });
    });
  };
  const run = runSynthesisBatch({ config, stores }, () => {
    throw new Error("there are no episodes to synthesize");
  }, { maxInvocationDurationMs: 90_000 });
  try {
    await reading;
    const inFlight = (await stores.metadata.listLogs()).filter((log) =>
      log.type === "synthesis.invocation"
    );
    assertEquals(inFlight.length, 1);
    assertEquals(inFlight[0]?.phase, "started");
    assertEquals(inFlight[0]?.context?.stage, "synthesis");
    assertEquals(inFlight[0]?.context?.budgetMs, 90_000);
    assertEquals(inFlight[0]?.context?.invocationId, inFlight[0]?.correlationId);
    assert(inFlight[0]?.correlationId);
  } finally {
    release?.();
    stores.metadata.listPendingEpisodes = original;
  }
  const batch = await run;
  assertEquals(batch.considered, 0);
  const marks = (await stores.metadata.listLogs()).filter((log) =>
    log.type === "synthesis.invocation"
  );
  assertEquals(marks.map((mark) => mark.phase), ["started", "terminal"]);
  assertEquals(marks[1]?.correlationId, marks[0]?.correlationId);
  assertEquals(marks[1]?.context?.outcome, "returned");
  assert((marks[1]?.durationMs ?? -1) >= 0);
});

Deno.test("audio-feed-4nbt: a thrown pre-claim read still closes its start mark", async () => {
  const stores = memoryStores();
  stores.metadata.listPendingEpisodes = () => Promise.reject(new Error("queue read failed"));
  await assertRejects(
    () =>
      runSynthesisBatch({ config, stores }, () => {
        throw new Error("synthesis should never run");
      }),
    Error,
    "queue read failed",
  );
  const marks = (await stores.metadata.listLogs()).filter((log) =>
    log.type === "synthesis.invocation"
  );
  assertEquals(marks.map((mark) => mark.phase), ["started", "terminal"]);
  assertEquals(marks[1]?.correlationId, marks[0]?.correlationId);
  assertEquals(marks[1]?.context?.outcome, "threw");
});

Deno.test("audio-feed-4nbt: an unavailable log store cannot prevent synthesis work", async () => {
  const stores = memoryStores();
  let attempts = 0;
  stores.metadata.appendLog = () => {
    attempts++;
    return Promise.reject(new Error("logging unavailable"));
  };
  const result = await runSynthesisBatch({ config, stores }, () => {
    throw new Error("synthesis should never run");
  });
  assertEquals(result.considered, 0);
  assertEquals(attempts, 2, "both marks are attempted, but logging is best-effort");
});

Deno.test("audio-feed-4nbt: separate empty invocations get distinct correlation ids", async () => {
  const stores = memoryStores();
  for (let i = 0; i < 2; i++) {
    await runSynthesisBatch({ config, stores }, () => {
      throw new Error("synthesis should never run");
    });
  }
  const marks = (await stores.metadata.listLogs()).filter((log) =>
    log.type === "synthesis.invocation"
  );
  assertEquals(marks.map((mark) => mark.phase), ["started", "terminal", "started", "terminal"]);
  assert(marks[0]?.correlationId !== marks[2]?.correlationId);
  assertEquals(marks[0]?.correlationId, marks[1]?.correlationId);
  assertEquals(marks[2]?.correlationId, marks[3]?.correlationId);
});
