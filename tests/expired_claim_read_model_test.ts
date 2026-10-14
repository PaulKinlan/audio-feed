import { assert, assertEquals } from "@std/assert";
import { claimAttemptsFrom, isClaimStartRecord } from "../src/observability/admin_report.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { MemoryMetadataStore } from "../src/storage/memory.ts";
import type { LogRecord, MetadataStore } from "../src/storage/mod.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

const CLAIM = {
  now: "2026-10-11T09:05:00.000Z",
  leaseMs: 60_000,
  owner: "worker-first",
  maxClaims: 3,
};
const EXPIRES = "2026-10-11T09:06:00.000Z";
const NEXT = "2026-10-11T09:07:00.000Z";

async function seed(store: MetadataStore) {
  const user = makeUser({ id: "svwu-user", email: "svwu@example.test", status: "approved" });
  await store.putUser(user);
  const episode = makeEpisode({
    id: "svwu-episode",
    userId: user.id,
    status: "pending",
    createdAt: "2026-10-11T09:00:00.000Z",
  });
  await store.putEpisode(episode);
  return episode;
}

function expiredEvents(records: LogRecord[]): LogRecord[] {
  return records.filter((record) =>
    (record.context as Record<string, unknown> | undefined)?.claimOutcome === "expired"
  );
}

// Each test gets a fresh adapter; the KV one is a real in-memory Deno KV and is closed in finally.
// This lives in its OWN suite rather than changing the shared tests/conformance helper, which would
// force the fast gate to run the entire full-suite universe for every branch that touches it.
const adapters: { name: string; create: () => Promise<MetadataStore> | MetadataStore }[] = [
  { name: "memory", create: () => new MemoryMetadataStore() },
  {
    name: "KV",
    create: async () =>
      new KvMetadataStore(await Deno.openKv(":memory:"), { ownsConnection: true }),
  },
];

Deno.test("svwu: historical ownerless claim records remain genuine starts", () => {
  // Before owner/lease context was recorded, a start was only the claimed phase and no ending.
  const older: LogRecord = {
    seq: 1,
    time: "2026-10-11T09:04:00.000Z",
    severity: "info",
    type: "claim.lifecycle",
    process: "worker",
    message: "claim started",
    phase: "claimed",
  };
  const ownerless: LogRecord = { ...older, seq: 2, time: CLAIM.now };
  assertEquals(isClaimStartRecord(ownerless), true);
  assertEquals(isClaimStartRecord({ ...ownerless, context: { owner: "worker-first" } }), true);
  assertEquals(isClaimStartRecord({ ...ownerless, durationMs: 0 }), false);
  assertEquals(isClaimStartRecord({ ...ownerless, reason: "lease expired" }), false);
  assertEquals(isClaimStartRecord({ ...ownerless, context: { workerState: "unknown" } }), false);
  const phaseTouch: LogRecord = {
    ...ownerless,
    seq: 3,
    time: "2026-10-11T09:05:30.000Z",
    phase: "uploading_audio",
    message: "phase advanced",
  };
  assertEquals(isClaimStartRecord(phaseTouch), false);
  const [attempt] = claimAttemptsFrom([older, ownerless, phaseTouch], Date.parse(phaseTouch.time));
  assertEquals(attempt?.startedAt, CLAIM.now, "the ownerless second start replaces the first");
  assertEquals(attempt?.phase, "uploading_audio", "a later phase transition still advances");
  assertEquals(attempt?.phases, ["claimed", "uploading_audio"]);
  assertEquals(attempt?.lastHeartbeat, phaseTouch.time);
  assertEquals(attempt?.leaseExpired, null, "a legacy record cannot invent a lease duration");
});

Deno.test("mkfe: an expiry-only window reports startedAt as UNKNOWN, not the expiry instant", () => {
  // THE RETAINED WINDOW OPENS AFTER THE START. The store prunes its oldest records, so an attempt
  // whose start has aged out first appears as its EXPIRY - and initialising startedAt from the first
  // record seen reported that expiry as the claim's start, inventing a zero-length claim that never
  // happened. This is the shape rev-77 measured at the aueh tip: startedAt equal to the expiry
  // instant against a nowMs one minute later.
  const expiryOnly: LogRecord = {
    seq: 90,
    time: EXPIRES,
    severity: "warn",
    type: "claim.lifecycle",
    process: "worker",
    message: "claim 1 (owner worker-first) lease expired",
    phase: "claimed",
    attempt: 1,
    reason: "lease expired",
    context: { claimOutcome: "expired", expiredAt: EXPIRES, workerState: "unknown" },
  };
  assertEquals(isClaimStartRecord(expiryOnly), false, "an expiry is not a start");
  const [attempt] = claimAttemptsFrom([expiryOnly], Date.parse(NEXT));
  assertEquals(
    attempt?.startedAt,
    null,
    "an unknown start must be UNKNOWN, not the first surviving record's instant",
  );
  assertEquals(attempt?.outcome, "abandoned", "an expired lease nobody reclaimed is abandoned");
  assertEquals(attempt?.leaseExpired, null, "with no start there is no lease arithmetic to do");
  assertEquals(attempt?.phase, "claimed", "the last observed phase is still reported");
});

for (const adapter of adapters) {
  Deno.test(`svwu/5f1o ${adapter.name}: expired while still claimed does not shift start`, async () => {
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      assert(await store.claimEpisode(episode.userId, episode.id, CLAIM));
      assert(
        await store.claimEpisode(episode.userId, episode.id, {
          ...CLAIM,
          owner: "worker-next",
          now: NEXT,
        }),
      );
      const records = await store.listLogs();
      const expired = expiredEvents(records);
      // The KV copy is load-bearing: deleting only its append reddens THIS KV test.
      assertEquals(expired.length, 1);
      assertEquals(expired[0]?.severity, "warn");
      assertEquals(expired[0]?.attempt, 1);
      assertEquals(expired[0]?.phase, "claimed", "preserve the last observed phase");
      assertEquals(expired[0]?.time, EXPIRES);
      assertEquals((expired[0]?.context as Record<string, unknown>)?.expiredAt, EXPIRES);
      const attempts = claimAttemptsFrom(records, Date.parse(NEXT));
      assertEquals(attempts.length, 2);
      assertEquals(attempts[0]?.startedAt, CLAIM.now);
      assertEquals(attempts[0]?.leaseExpiresAt, EXPIRES);
      assertEquals(attempts[0]?.leaseExpired, true);
      assertEquals(attempts[0]?.outcome, "abandoned");
      assertEquals(attempts[0]?.endedWithTerminalWrite, false);
      assertEquals(attempts[1]?.startedAt, NEXT, "the next genuine start is unchanged");
      assertEquals(attempts[1]?.leaseExpired, false);
      assertEquals(attempts[1]?.outcome, "in-flight");
    } finally {
      await store.close();
    }
  });

  Deno.test(`svwu ${adapter.name}: expiry after phase touch keeps original start`, async () => {
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      assert(await store.claimEpisode(episode.userId, episode.id, CLAIM));
      assert(
        await store.touchEpisodeClaim(episode.userId, episode.id, CLAIM.owner, {
          phase: "uploading_audio",
          now: "2026-10-11T09:05:30.000Z",
        }),
      );
      assert(
        await store.claimEpisode(episode.userId, episode.id, {
          ...CLAIM,
          owner: "worker-next",
          now: NEXT,
        }),
      );
      const records = await store.listLogs();
      const expired = expiredEvents(records);
      assertEquals(expired.length, 1);
      assertEquals(expired[0]?.phase, "uploading_audio");
      assertEquals(expired[0]?.time, EXPIRES);
      const [first] = claimAttemptsFrom(records, Date.parse(NEXT));
      assertEquals(first?.startedAt, CLAIM.now);
      assertEquals(first?.leaseExpiresAt, EXPIRES);
      assertEquals(first?.leaseExpired, true);
      assertEquals(first?.outcome, "abandoned");
      assertEquals(first?.phases, ["claimed", "uploading_audio"]);
    } finally {
      await store.close();
    }
  });

  for (const touched of [false, true]) {
    Deno.test(`svwu ${adapter.name}: healthy completion ${touched ? "with" : "without"} touch stays finished`, async () => {
      const store = await adapter.create();
      try {
        const episode = await seed(store);
        const claimed = await store.claimEpisode(episode.userId, episode.id, CLAIM);
        assert(claimed);
        if (touched) {
          assert(
            await store.touchEpisodeClaim(episode.userId, episode.id, CLAIM.owner, {
              phase: "uploading_audio",
              now: "2026-10-11T09:05:30.000Z",
            }),
          );
        }
        const current = await store.getEpisode(episode.userId, episode.id);
        assert(current);
        assert(
          await store.completeEpisode(
            { ...current, status: "ready", audioKey: "audio/whatever", byteLength: 1234 },
            CLAIM.owner,
            { byteLength: 1234 },
          ),
        );
        const records = await store.listLogs();
        assertEquals(expiredEvents(records).length, 0);
        const [first] = claimAttemptsFrom(records, Date.parse(CLAIM.now) + 30_000);
        assertEquals(first?.startedAt, CLAIM.now);
        assertEquals(first?.leaseExpiresAt, EXPIRES);
        assertEquals(first?.leaseExpired, false);
        assertEquals(first?.outcome, "finished");
        assertEquals(first?.endedWithTerminalWrite, true);
      } finally {
        await store.close();
      }
    });
  }
}
