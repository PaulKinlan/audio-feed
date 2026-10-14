import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { type ClaimAttempt, claimAttemptsFrom } from "../src/observability/admin_report.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { MemoryMetadataStore } from "../src/storage/memory.ts";
import type { MetadataStore } from "../src/storage/mod.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

const START = "2026-10-11T09:05:00.000Z";
const BEFORE_EXPIRY = Date.parse("2026-10-11T09:05:30.000Z");
const AFTER_EXPIRY = Date.parse("2026-10-11T09:07:00.000Z");
const RECLAIM = new Date(AFTER_EXPIRY).toISOString();
const claim = { owner: "worker-first", now: START, leaseMs: 60_000, maxClaims: 3 };

async function seed(store: MetadataStore, id = "ojde-episode") {
  const user = makeUser({ id: "ojde-user", email: "ojde@example.test", status: "approved" });
  await store.putUser(user);
  const episode = makeEpisode({
    id,
    userId: user.id,
    status: "pending",
    createdAt: "2026-10-11T09:00:00.000Z",
  });
  await store.putEpisode(episode);
  return episode;
}

function evidence(row: ClaimAttempt | undefined): ClaimAttempt["expiryEvidence"] {
  return row?.expiryEvidence;
}

const adapters: { name: string; create: () => MetadataStore | Promise<MetadataStore> }[] = [
  { name: "memory", create: () => new MemoryMetadataStore() },
  {
    name: "KV",
    create: async () =>
      new KvMetadataStore(await Deno.openKv(":memory:"), { ownsConnection: true }),
  },
];

for (const adapter of adapters) {
  Deno.test(`ojde ${adapter.name}: observed intermediate expiry is recorded, not inferred`, async () => {
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      assert(await store.claimEpisode(episode.userId, episode.id, claim));
      assert(
        await store.claimEpisode(episode.userId, episode.id, {
          ...claim,
          owner: "worker-next",
          now: RECLAIM,
        }),
      );
      const [first] = claimAttemptsFrom(await store.listLogs(), AFTER_EXPIRY);
      assertEquals(first?.startedAt, START);
      assertEquals(first?.leaseExpired, true);
      assertEquals(first?.outcome, "abandoned");
      assertEquals(first?.endedWithTerminalWrite, false);
      assertEquals(evidence(first), "recorded");
    } finally {
      await store.close();
    }
  });

  Deno.test(`ojde ${adapter.name}: overdue start with no expiry record is inferred`, async () => {
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      assert(await store.claimEpisode(episode.userId, episode.id, claim));
      const records = await store.listLogs();
      assertEquals(records.length, 1, "there was no observed expiry record");
      const [first] = claimAttemptsFrom(records, AFTER_EXPIRY);
      assertEquals(first?.startedAt, START);
      assertEquals(first?.leaseExpired, true);
      assertEquals(first?.outcome, "abandoned");
      assertEquals(first?.endedWithTerminalWrite, false);
      assertEquals(evidence(first), "inferred");
    } finally {
      await store.close();
    }
  });

  Deno.test(`ojde ${adapter.name}: observed max-claims abandonment is recorded`, async () => {
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      const oneClaim = { ...claim, maxClaims: 1 };
      assert(await store.claimEpisode(episode.userId, episode.id, oneClaim));
      assertEquals(
        await store.claimEpisode(episode.userId, episode.id, {
          ...oneClaim,
          owner: "worker-next",
          now: RECLAIM,
        }),
        null,
      );
      const [first] = claimAttemptsFrom(await store.listLogs(), AFTER_EXPIRY);
      assertEquals(first?.outcome, "abandoned");
      assertEquals(first?.endedWithTerminalWrite, false);
      assertEquals(evidence(first), "recorded");
    } finally {
      await store.close();
    }
  });

  Deno.test(`amhn ${adapter.name}: the EXPIRY-without-terminal-write record carries them too`, async () => {
    // THE OTHER TERMINAL SHAPE, AND IT IS NOT REDUNDANT: tonight's store had BOTH - episodes abandoned
    // because the claim ceiling was exhausted (the row above) and episodes that expired with no terminal
    // write while attempts remained (this row, severity warn, context.claimOutcome "expired"). A size
    // carried on only one of them would leave half the outage undiagnosable, so both are asserted, on
    // both storage twins.
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      // maxClaims 3 in `claim`: the first reclaim EXPIRES the lease and grants another attempt, rather
      // than exhausting the ceiling, which is what makes this the non-final shape.
      assert(await store.claimEpisode(episode.userId, episode.id, claim));
      assert(
        await store.touchEpisodeClaim(episode.userId, episode.id, claim.owner, {
          now: START,
          phase: "uploading_audio",
          bytesAttempted: 9_437_184,
        }),
      );
      assert(
        await store.claimEpisode(episode.userId, episode.id, {
          ...claim,
          owner: "worker-next",
          now: RECLAIM,
        }),
        "a reclaim under maxClaims must grant a new claim",
      );

      const expired = (await store.listLogs()).find((log) =>
        log.type === "claim.lifecycle" && log.context?.claimOutcome === "expired"
      );
      assert(expired, "the expiry must leave a record");
      assertEquals(expired.phase, "uploading_audio", "the expiry must name the stage it died in");
      assertEquals(
        expired.severity,
        "warn",
        "a reclaimable expiry is a warning, not the terminal error the abandonment writes",
      );
      assertEquals(
        expired.context?.bytesAttempted,
        9_437_184,
        "the expiry-without-terminal-write record must carry the bytes attempted, like the abandonment",
      );
    } finally {
      await store.close();
    }
  });

  Deno.test(`amhn ${adapter.name}: an abandoned upload names the stage it died in AND the bytes attempted`, async () => {
    // THE ACCEPTANCE TEST FOR audio-feed-amhn, DELIBERATELY AN OBSERVABILITY TEST RATHER THAN A
    // BEHAVIOUR TEST. A platform kill inside the terminal put is the case where the worker cannot write
    // its own failure record at all - the isolate stops existing - so the only witness is the store, and
    // what has to be recoverable from the store ALONE is (i) WHERE it died and (ii) the SIZE it was
    // attempting. (ii) is the fact no other record can supply: `byteLength` is written only when an
    // episode reaches ready, which is exactly why every failed upload on 2026-10-14 had no size.
    //
    // Run against BOTH adapters on purpose: the field crosses a storage twin (KV and memory), and a
    // change that lands in one and not the other is the classic drift this loop exists to catch.
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      const oneClaim = { ...claim, maxClaims: 1 };
      assert(await store.claimEpisode(episode.userId, episode.id, oneClaim));

      // The worker's own checkpoint as it ENTERS the terminal stage: the phase it is in, and the size
      // of the whole-episode artefact it is about to upload.
      assert(
        await store.touchEpisodeClaim(episode.userId, episode.id, oneClaim.owner, {
          now: START,
          phase: "uploading_audio",
          bytesAttempted: 9_437_184,
        }),
        "the checkpoint carrying the attempted size must be accepted",
      );
      assertEquals(
        (await store.getEpisode(episode.userId, episode.id))?.bytesAttempted,
        9_437_184,
        `${adapter.name} must persist the attempted size, or the storage twins have drifted`,
      );

      // Nobody ever writes a terminal result. The lease expires, and the next claim abandons it.
      assertEquals(
        await store.claimEpisode(episode.userId, episode.id, {
          ...oneClaim,
          owner: "worker-next",
          now: RECLAIM,
        }),
        null,
      );

      const abandoned = (await store.listLogs()).find((log) =>
        log.type === "claim.lifecycle" && log.severity === "error"
      );
      assert(abandoned, "an exhausted claim must leave a terminal failure record");
      assertEquals(
        abandoned.phase,
        "uploading_audio",
        "the terminal record must name the stage the attempt died in",
      );
      assertEquals(
        abandoned.context?.bytesAttempted,
        9_437_184,
        "the record must carry the bytes the upload was attempting, which nothing else holds",
      );
      // Readable WITHOUT knowing the event type or the context key: the location is in the prose, so a
      // reader who has never seen this store can still see where the episode stopped.
      assert(
        (abandoned.message ?? "").includes("uploading_audio"),
        "the message must say where it died, not only that it did",
      );
    } finally {
      await store.close();
    }
  });

  Deno.test(`ojde ${adapter.name}: healthy live claim has no expiry evidence`, async () => {
    const store = await adapter.create();
    try {
      const episode = await seed(store);
      assert(await store.claimEpisode(episode.userId, episode.id, claim));
      const [first] = claimAttemptsFrom(await store.listLogs(), BEFORE_EXPIRY);
      assertEquals(first?.outcome, "in-flight");
      assertEquals(first?.leaseExpired, false);
      assertEquals(first?.endedWithTerminalWrite, false);
      assertEquals(evidence(first), undefined);
    } finally {
      await store.close();
    }
  });
}

Deno.test("ojde: admin Ended cells distinguish recorded and inferred expiry", async () => {
  const stores = memoryStores();
  try {
    const admin = makeUser({
      id: "ojde-admin",
      email: "ojde-admin@example.test",
      status: "approved",
      isAdmin: true,
    });
    await stores.metadata.putUser(admin);
    // The route uses its real clock. Expire the page's lease relative to this run,
    // rather than asserting that the machine is on a particular calendar date.
    const pageNow = Date.now();
    const pageClaim = { ...claim, now: new Date(pageNow - 120_000).toISOString() };
    const pageReclaim = new Date(pageNow).toISOString();
    const recorded = await seed(stores.metadata, "ojde-recorded");
    assert(await stores.metadata.claimEpisode(recorded.userId, recorded.id, pageClaim));
    assert(
      await stores.metadata.claimEpisode(recorded.userId, recorded.id, {
        ...pageClaim,
        owner: "worker-next",
        now: pageReclaim,
      }),
    );

    const inferred = await seed(stores.metadata, "ojde-inferred");
    assert(await stores.metadata.claimEpisode(inferred.userId, inferred.id, pageClaim));
    // A different warning for this episode makes its claim history visible in the recent-failure
    // panel. It is NOT an expiry event; only the lease clock can classify the claim as inferred.
    assert(
      await stores.metadata.appendLog({
        time: pageReclaim,
        severity: "warn",
        type: "synthesis.issue",
        process: "worker",
        message: "unrelated warning",
        episodeId: inferred.id,
        userId: inferred.userId,
      }),
    );
    const BASE = "https://audio.example";
    const ctx = {
      config: { port: 8000, publicBaseUrl: BASE, adminToken: "local-test-token" },
      stores,
    };
    const fetch = createApp(ctx, createHandlers(ctx)).fetch;
    const session = await createSession(stores.metadata, admin.id);
    const response = await fetch(
      new Request(`${BASE}/admin/observability`, {
        headers: { cookie: `${SESSION_COOKIE}=${session}` },
      }),
    );
    assertEquals(response.status, 200);
    const html = await response.text();
    // Compare COMPLETE Ended-cell text PER EPISODE, so swapped labels cannot pass as a set.
    const endedCellsFor = (id: string) => {
      const section =
        html.match(new RegExp(`<section class="card" id="ep-${id}">([\\s\\S]*?)<\\/section>`))
          ?.[1] ?? "";
      return [...section.matchAll(/<td>(NO terminal write[^<]*)<\/td>/g)]
        .map((match) => match[1]);
    };
    assertEquals(endedCellsFor("ojde-recorded"), ["NO terminal write — lease expiry recorded"]);
    assertEquals(endedCellsFor("ojde-inferred"), ["NO terminal write — lease expired (inferred)"]);
  } finally {
    await stores.metadata.close();
  }
});
