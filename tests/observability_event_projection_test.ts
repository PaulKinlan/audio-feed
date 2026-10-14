import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { screenErrorForLogging } from "../src/observability/error_screen.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";

const BASE = "https://audio.example.test";
const KEY = "local-observability-key";

function app() {
  const stores = memoryStores();
  const ctx = {
    config: { port: 8000, publicBaseUrl: BASE, adminToken: "local-admin", observabilityKey: KEY },
    stores,
  };
  const fetch = createApp(ctx, createHandlers(ctx)).fetch;
  const errors = () =>
    fetch(
      new Request(`${BASE}/api/observability/errors?severity=warn`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
    );
  return { stores, ctx, errors };
}

Deno.test("3045: authenticated event projection has the exact reviewed key set, including nulls", async () => {
  const { stores, errors } = app();
  const canary = "private-article-input-must-not-reappear";
  const screened = screenErrorForLogging(new Error(canary));
  await stores.metadata.appendLog({
    time: "2026-10-14T00:00:00.000Z",
    severity: "warn",
    type: "synthesis.stage",
    process: "worker",
    job: "synthesis",
    correlationId: "invocation-1",
    episodeId: "episode-1",
    userId: "subscriber-1",
    phase: "tts",
    attempt: 2,
    durationMs: 123,
    reason: canary, // Store caps this, but does NOT screen it: do not add it to bearer JSON.
    message: screened.message,
    stack: screened.stack,
    context: { stageMark: "tts", episodeId: "episode-1", authToken: canary },
  });
  await stores.metadata.appendLog({
    time: "2026-10-14T00:00:01.000Z",
    severity: "warn",
    type: "http.request",
    process: "app",
    message: "safe fixed message",
  });
  const response = await errors();
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.events.length, 2);
  const [event, sparse] = body.events;
  const keys = [
    "id",
    "seq",
    "time",
    "severity",
    "type",
    "route",
    "job",
    "message",
    "stack",
    "correlationId",
    "context",
    "episodeId",
    "phase",
    "attempt",
    "durationMs",
  ].sort();
  assertEquals(Object.keys(event).sort(), keys, "populated event key set is deliberate");
  assertEquals(Object.keys(sparse).sort(), keys, "missing optional fields are null, not missing");
  assertEquals(sparse.episodeId, null);
  assertEquals(sparse.phase, null);
  assertEquals(sparse.attempt, null);
  assertEquals(sparse.durationMs, null);
  assertEquals(event.episodeId, "episode-1");
  assertEquals(event.phase, "tts");
  assertEquals(event.attempt, 2);
  assertEquals(event.durationMs, 123);
  assertEquals(event.context.authToken, "[redacted]");
  assertEquals(JSON.stringify(body).includes(canary), false, "raw reason and token cannot escape");
  assertEquals(event.message, screened.message);
  assertEquals(event.stack, screened.stack);
});

Deno.test("3045: bearer response does not newly expose unscreened reason or context secrets", async () => {
  const { stores, errors } = app();
  const canary = "private-user-input-must-not-reappear";
  const screened = screenErrorForLogging(new Error(canary));
  await stores.metadata.appendLog({
    time: "2026-10-14T00:00:00.000Z",
    severity: "error",
    type: "http.unhandled",
    process: "app",
    message: screened.message,
    stack: screened.stack,
    reason: canary,
    context: { apiKey: canary },
  });
  const response = await errors();
  assertEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes(canary), false, "unscreened reason must not be projected");
  const [event] = JSON.parse(text).events;
  assertEquals("reason" in event, false);
  assertEquals(event.message, screened.message);
  assertEquals(event.stack, screened.stack);
  assertEquals(event.context.apiKey, "[redacted]");
});

Deno.test("3045: real failed synthesis stage is attributable from response root, not prose/context", async () => {
  const { stores, ctx, errors } = app();
  await stores.metadata.putUser(makeUser({ id: "stage-user", status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "stage-source", userId: "stage-user" }));
  await stores.metadata.putArticle(makeArticle({
    id: "stage-article",
    userId: "stage-user",
    sourceId: "stage-source",
    content: "One paragraph. Another paragraph.",
  }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "stage-episode",
    userId: "stage-user",
    sourceId: "stage-source",
    articleId: "stage-article",
    status: "pending",
    mode: "direct",
  }));

  await runSynthesisBatch(ctx, () => {
    throw new Error("provider stalled inside TTS");
  }, {
    batchSize: 1,
    owner: "stage-worker",
    maxAttempts: 1,
  });
  // Add two controlled marks with another episode and two phases. The first mark above remains
  // production-written; these make a nontrivial GROUP BY stage and episode test possible without
  // depending on a second synthesis run or parsing a type-specific nested context.
  for (const phase of ["tts", "verify"]) {
    assert(
      await stores.metadata.appendLog({
        time: "2026-10-14T00:00:00.000Z",
        severity: "warn",
        type: "synthesis.stage",
        process: "worker",
        job: "synthesis",
        correlationId: "other-invocation",
        episodeId: "other-episode",
        phase,
        message: "fixed diagnostic",
        durationMs: 5,
      }),
    );
  }
  const response = await errors();
  assertEquals(response.status, 200);
  const { events } = await response.json();
  const failedStages = events.filter((event: { type: string; severity: string }) =>
    event.type === "synthesis.stage" && event.severity === "warn"
  );
  assertEquals(failedStages.length, 3, "real throw plus two controlled marks in the same feed");
  // This is the actual consumer property: only stable ROOT fields, no event.message or
  // event.context, produce a per-stage count and episode set even across different invocations.
  const groups = new Map<string, Set<string>>();
  for (const event of failedStages) {
    assert(typeof event.phase === "string" && typeof event.episodeId === "string");
    if (!groups.has(event.phase)) groups.set(event.phase, new Set());
    groups.get(event.phase)!.add(event.episodeId);
  }
  const distribution = [...groups].map(([phase, episodes]) => ({
    phase,
    episodeIds: [...episodes].sort(),
    count: episodes.size,
  })).sort((a, b) => a.phase.localeCompare(b.phase));
  assertEquals(distribution, [
    { phase: "tts", episodeIds: ["other-episode", "stage-episode"], count: 2 },
    { phase: "verify", episodeIds: ["other-episode"], count: 1 },
  ]);
  const stage = failedStages.find((event: { episodeId: string }) =>
    event.episodeId === "stage-episode"
  );
  assert(stage, "the real failed stage must be retained");
  assertEquals(stage.episodeId, "stage-episode", "root episodeId joins across event kinds");
  assertEquals(stage.phase, "tts", "root phase groups failed stages without parsing prose");
  assert(
    stage.correlationId !== stage.episodeId,
    "correlationId is the invocation, not the episode",
  );
  assert(typeof stage.durationMs === "number" && stage.durationMs >= 0);
  assertEquals(stage.attempt, null, "the projection has the same keys for records without attempt");
  assertEquals(stage.userId, undefined, "bearer projection does not expose subscriber identity");
  assertEquals(stage.reason, undefined, "bearer projection does not add free-form reason text");
});

Deno.test("3045: a real max-claims expiry has structured episode, attempt, and phase", async () => {
  const { stores, errors } = app();
  await stores.metadata.putUser(makeUser({ id: "claim-user", status: "approved" }));
  await stores.metadata.putEpisode(makeEpisode({
    id: "claim-episode",
    userId: "claim-user",
    status: "pending",
    createdAt: "2026-10-14T00:00:00.000Z",
  }));
  const claim = {
    owner: "worker-1",
    now: "2026-10-14T00:00:00.000Z",
    leaseMs: 60_000,
    maxClaims: 1,
  };
  assert(await stores.metadata.claimEpisode("claim-user", "claim-episode", claim));
  assertEquals(
    await stores.metadata.claimEpisode("claim-user", "claim-episode", {
      ...claim,
      owner: "worker-2",
      now: "2026-10-14T00:02:00.000Z",
    }),
    null,
  );
  const response = await errors();
  assertEquals(response.status, 200);
  const { events } = await response.json();
  const failures = events.filter((event: { type: string; severity: string }) =>
    event.type === "claim.lifecycle" && event.severity === "error"
  );
  assertEquals(failures.length, 1);
  const [failure] = failures;
  assertEquals(failure.episodeId, "claim-episode");
  assertEquals(failure.phase, "claimed");
  assertEquals(failure.attempt, 1);
  assertEquals(
    failure.context.workerState,
    "unknown",
    "the existing context says no worker result was observed",
  );
  assertEquals(failure.reason, undefined, "the bearer reader does not add free-form reason text");
});
