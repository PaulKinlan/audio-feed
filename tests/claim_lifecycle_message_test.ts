import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { memoryStores } from "../src/config.ts";
import { claimLifecycleEvent } from "../src/storage/episode_events.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

const SUBJECT = 'claim 1 of episode tnhp-episode is in phase "completing"';
const cases = [
  {
    name: "error with nonempty reason keeps its existing explanation",
    severity: "error",
    reason: "provider failed",
    expected: `${SUBJECT}: provider failed`,
    storedReason: "provider failed",
  },
  {
    name: "error with raw-empty reason says failed",
    severity: "error",
    reason: "",
    expected: `${SUBJECT}: synthesis failed in 0ms`,
    storedReason: undefined,
  },
  {
    name: "error with absent reason says failed",
    severity: "error",
    expected: `${SUBJECT}: synthesis failed in 0ms`,
    storedReason: undefined,
  },
  {
    name: "error with whitespace-only reason says failed rather than printing blank prose",
    severity: "error",
    reason: "   ",
    expected: `${SUBJECT}: synthesis failed in 0ms`,
    storedReason: "   ", // cleanString does not trim whitespace.
  },
  {
    name: "error with control-only reason says failed after cleaning strips the control",
    severity: "error",
    reason: "\u0001",
    expected: `${SUBJECT}: synthesis failed in 0ms`,
    storedReason: "", // Raw reason is truthy; cleanString strips the C0 character.
  },
  {
    name: "genuine completion without reason retains finished phrasing",
    severity: "info",
    expected: `${SUBJECT}: synthesis finished in 0ms`,
    storedReason: undefined,
  },
  {
    name: "genuine completion with raw-empty reason retains finished phrasing",
    severity: "info",
    reason: "",
    expected: `${SUBJECT}: synthesis finished in 0ms`,
    storedReason: undefined,
  },
] as const;

for (const example of cases) {
  Deno.test(`tnhp: ${example.name}`, async () => {
    // Shared lifecycle writer + real store sanitiser/read, not an invented LogRecord fixture.
    const store = memoryStores().metadata;
    const event = claimLifecycleEvent(
      { id: "tnhp-episode", userId: "tnhp-user", attempts: 1 },
      {
        phase: "completing",
        attempt: 1,
        severity: example.severity,
        durationMs: 0,
        ...("reason" in example ? { reason: example.reason } : {}),
      },
    );
    assert(await store.appendLog(event));
    const [record] = await store.listLogs();
    assertEquals(record?.severity, example.severity);
    assertEquals(record?.reason, example.storedReason);
    assertEquals(record?.message, example.expected);
  });
}

Deno.test("tnhp: an actual failed episode with an empty error cannot say synthesis finished", async () => {
  const store = memoryStores().metadata;
  const user = makeUser({ id: "tnhp-user" });
  await store.putUser(user);
  const episode = makeEpisode({
    id: "tnhp-episode",
    userId: user.id,
    status: "pending",
    createdAt: "2026-10-11T09:00:00.000Z",
  });
  await store.putEpisode(episode);
  const owner = "tnhp-worker";
  const claimed = await store.claimEpisode(user.id, episode.id, {
    owner,
    now: "2026-10-11T09:05:00.000Z",
    leaseMs: 60_000,
    maxClaims: 3,
  });
  assert(claimed);
  assert(await store.completeEpisode({ ...claimed, status: "failed", error: "" }, owner));
  const terminal = (await store.listLogs()).find((record) => record.durationMs !== undefined);
  assert(terminal);
  assertEquals(terminal.severity, "error");
  assertEquals(terminal.reason, undefined);
  assertStringIncludes(terminal.message, ": synthesis failed in ");
  assert(!terminal.message.includes("synthesis finished"));
});
