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
