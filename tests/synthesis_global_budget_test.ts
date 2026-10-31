/**
 * audio-feed-m182 — the ceiling on total TTS spend, not just on one subscriber's.
 *
 * WHAT WAS WRONG
 * khk3 gave every subscriber a daily ceiling (default 50), which bounds one subscriber and leaves
 * the total linear in the number of approved subscribers: fifty each is unbounded as an operator
 * approves more of them, and approval is the single action that multiplies it. Nothing else in the
 * deployment bounded the sum — only the admin approval gate and the worker's own throughput, and
 * neither of those is a spending limit.
 *
 * WHAT THESE TESTS PIN
 * 1. The global ceiling is resolved the same way the per-subscriber one is — explicit, then the
 *    deployment config, then the constant — and, like it, has no input that yields "unlimited".
 * 2. When it is reached, work is DEFERRED (the episodes stay pending) rather than failed, because
 *    the next UTC day serves them and nothing was spent.
 * 3. The deferral reason says which ceiling it was, the day's usage, and whether the number was
 *    configured or the built-in default.
 * 4. The per-subscriber control is unchanged: a subscriber over their OWN budget is held by their
 *    own reason, and a subscriber under it is only held when the fleet ceiling is reached.
 * 5. The dashboard reports the ceiling, its source, and the day's global usage.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import {
  DEFAULT_DAILY_EPISODE_BUDGET,
  DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET,
  memoryStores,
} from "../src/config.ts";
import {
  globalDailyEpisodeBudgetFor,
  runSynthesisBatch,
  startSynthesisWorker,
} from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import { controlledInvocationClock } from "./fixtures/invocation_clock.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import type { SynthesisWorkerOptions } from "../src/worker/synthesis.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "http://localhost",
  adminToken: "admin-secret",
};

function fakeAudio(bytes = 480): DecodedAudioResult {
  const raw = new Uint8Array(44 + bytes);
  raw.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  raw.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  raw.set([0x64, 0x61, 0x74, 0x61], 36); // data
  return {
    rawBytes: raw,
    mimeType: "audio/wav",
    format: "wav",
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    durationSeconds: 2,
    finishReason: "STOP",
    truncated: false,
    toWav: () => raw,
  };
}

/** Add one subscriber with `count` pending episodes. */
async function seedInto(
  stores: Stores,
  userId: string,
  count: number,
  budget?: number,
): Promise<void> {
  await stores.metadata.putUser(
    makeUser({
      id: userId,
      status: "approved",
      ...(budget === undefined ? {} : { dailyEpisodeBudget: budget }),
    }),
  );
  await stores.metadata.putSource(makeSource({ id: `src-${userId}`, userId }));
  await stores.metadata.putArticle(
    makeArticle({ id: `art-${userId}`, userId, sourceId: `src-${userId}` }),
  );
  for (let i = 0; i < count; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `${userId}-ep-${String(i).padStart(2, "0")}`,
        userId,
        sourceId: `src-${userId}`,
        articleId: `art-${userId}`,
        status: "pending",
      }),
    );
  }
}

/** Run one batch, counting the calls that would have been billed. */
async function spend(
  stores: Stores,
  options: SynthesisWorkerOptions = {},
  appConfig: AppConfig = config,
): Promise<{ paid: number; ready: number; deferred: string[]; warnings: string[] }> {
  let paid = 0;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const result = await runSynthesisBatch({ config: appConfig, stores }, () => {
      paid++;
      return Promise.resolve(fakeAudio());
    }, options);
    return {
      paid,
      ready: result.ready.length,
      deferred: result.deferred.map((d) => d.reason),
      warnings,
    };
  } finally {
    console.warn = original;
  }
}

Deno.test("the fleet ceiling resolves explicit, then config, then the constant (audio-feed-m182)", () => {
  assertEquals(globalDailyEpisodeBudgetFor(7, 9), { limit: 7, source: "configured" });
  assertEquals(globalDailyEpisodeBudgetFor(undefined, 9), { limit: 9, source: "configured" });
  assertEquals(globalDailyEpisodeBudgetFor(undefined, undefined), {
    limit: DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET,
    source: "default",
  });
  // 0 is a legal ceiling: it means nothing is synthesised.
  assertEquals(globalDailyEpisodeBudgetFor(0, 9), { limit: 0, source: "configured" });
});

Deno.test("no value of the fleet ceiling means unlimited (audio-feed-m182)", () => {
  // The failure mode is a branch somebody adds later, so this is asserted as a property of the
  // helper rather than case by case — the same reasoning khk3 used for the per-subscriber ceiling.
  const unusable = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    -0.5,
    Number.NEGATIVE_INFINITY,
  ];
  for (const option of unusable) {
    for (const deployment of unusable) {
      const resolved = globalDailyEpisodeBudgetFor(option, deployment);
      assert(
        Number.isFinite(resolved.limit) && resolved.limit >= 0,
        `option=${String(option)} deployment=${String(deployment)} produced ${resolved.limit}`,
      );
      assertEquals(resolved.source, "default");
    }
  }
  // An unusable option does not discard a usable deployment value.
  assertEquals(globalDailyEpisodeBudgetFor(Number.NaN, 12), { limit: 12, source: "configured" });
});

Deno.test("the fleet ceiling defers work once the day's total reaches it (audio-feed-m182)", async () => {
  const stores: Stores = memoryStores();
  // Three subscribers, two episodes each: six paid calls available, a fleet ceiling of four.
  for (const user of ["user-a", "user-b", "user-c"]) await seedInto(stores, user, 2);

  const run = await spend(stores, { globalDailyEpisodeBudget: 4, batchSize: 10 });
  assertEquals(run.paid, 4, "exactly the ceiling is spent, no more");
  assertEquals(run.ready, 4);
  assertEquals(run.deferred.length, 2, "the rest is deferred, not failed");

  // Deferred, not failed: the work is still pending and the next UTC day serves it.
  let stillPending = 0;
  let failed = 0;
  for (const user of ["user-a", "user-b", "user-c"]) {
    stillPending +=
      (await stores.metadata.listEpisodes({ userId: user, status: "pending", limit: 50 }))
        .length;
    failed += (await stores.metadata.listEpisodes({ userId: user, status: "failed", limit: 50 }))
      .length;
  }
  assertEquals(stillPending, 2, "a deferral leaves the work pending");
  assertEquals(failed, 0, "hitting a budget must never fail an episode");

  // The day's global counter is what the ceiling is measured against.
  const day = new Date().toISOString().slice(0, 10);
  assertEquals(await stores.metadata.getDailySynthesisCount(day), 4);

  // And the reason says which ceiling it was, with the usage. An explicit option is a CONFIGURED
  // ceiling, so it carries no "nobody set this" clause — the same shape as the per-user reason,
  // where a configured budget says nothing extra either.
  for (const reason of run.deferred) {
    assertStringIncludes(reason, "daily spend ceiling reached across all subscribers");
    assertStringIncludes(reason, "limit: 4");
    assertStringIncludes(reason, "used: 4");
    assertEquals(reason.includes("built-in default"), false, "an operator set this one");
    assertEquals(reason.includes("deployment default"), false, "this is not the per-user ceiling");
  }
});

Deno.test("an operator's fleet ceiling is reported as configured, and a default warns once (audio-feed-m182)", async () => {
  const stores: Stores = memoryStores();
  for (const user of ["user-a", "user-b"]) await seedInto(stores, user, 1);

  const configured = await spend(stores, { globalDailyEpisodeBudget: 1, batchSize: 10 });
  assertEquals(configured.paid, 1);
  assertStringIncludes(
    configured.deferred[0]!,
    "daily spend ceiling reached across all subscribers (limit: 1, used: 1)",
  );
  assertEquals(
    configured.deferred[0]!.includes("built-in default"),
    false,
    "an operator's number is not reported as the built-in one",
  );
  assertEquals(
    configured.warnings.some((w) => w.includes("fleet-wide daily ceiling")),
    false,
    "a ceiling the operator set needs no warning about nobody setting one",
  );

  // The built-in default is only reported when it is actually reached, and reaching it takes more
  // than one subscriber's own ceiling allows: a subscriber on the per-user default stops at 50, so
  // the global 500 is sized as ten of them (that is the sizing rationale, not an accident). This
  // raises the per-subscriber ceiling so the FLEET ceiling is what bites, which is what is under
  // test here — the two interacting is asserted separately below.
  const other: Stores = memoryStores();
  await seedInto(other, "user-a", DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET + 1);
  // The 90s invocation budget must not decide this row: under the real clock a loaded host once
  // cut the sweep at 268 of 501 turns, `deferred` came back empty, and the row was silently
  // testing nothing while still passing on a quiet box. The shared fixture's clock never moves
  // unless this row advances it, so the preflight break never fires and the CEILING decides the
  // last episode — which is what this row is about.
  const time = controlledInvocationClock();
  const unconfigured = await spend(other, {
    batchSize: DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET + 5,
    clock: time.clock,
  }, { ...config, defaultDailyEpisodeBudget: 1000 });
  // If fewer episodes were considered than were seeded, the invocation budget cut the batch —
  // say so, instead of a bare "actual 268, expected 500".
  assertEquals(
    unconfigured.paid + unconfigured.deferred.length,
    DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET + 1,
    "the sweep must consider every seeded episode for the ceiling to decide the last one; fewer means the invocation budget cut the batch early (inject tests/fixtures/invocation_clock.ts and never advance it) — not the ceiling under test",
  );
  assertEquals(unconfigured.paid, DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET);
  assertEquals(unconfigured.deferred.length, 1);
  assertStringIncludes(unconfigured.deferred[0]!, "source: built-in default");
  assertEquals(
    unconfigured.warnings.filter((w) => w.includes("fleet-wide daily ceiling")).length,
    1,
    "say it once per run, not once per subscriber",
  );
});

Deno.test("one subscriber's own ceiling still stops them before the fleet ceiling (audio-feed-m182)", async () => {
  // The interaction, asserted deliberately: with the shipped per-user default (50) and a fleet
  // ceiling of 500, a single subscriber is stopped by their OWN ceiling — ten of them are what
  // reaches the fleet one. A fleet ceiling is a backstop, not a replacement.
  const stores: Stores = memoryStores();
  await seedInto(stores, "user-a", DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET + 1);
  const run = await spend(stores, { batchSize: DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET + 5 });
  assertEquals(run.paid, DEFAULT_DAILY_EPISODE_BUDGET);
  assertEquals(run.deferred.length, DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET + 1 - run.paid);
  assertStringIncludes(run.deferred[0]!, "daily episode budget exceeded");
  assertEquals(
    run.deferred[0]!.includes("across all subscribers"),
    false,
    "the per-subscriber reason is what applies here",
  );
});

Deno.test("the per-subscriber ceiling still holds, and is not replaced (audio-feed-m182)", async () => {
  const stores: Stores = memoryStores();
  await seedInto(stores, "user-a", 3, 1); // their own ceiling: one episode
  await seedInto(stores, "user-b", 3); // on the deployment default

  const run = await spend(stores, { globalDailyEpisodeBudget: 100, batchSize: 10 });
  // user-a is held by their OWN budget: the fleet ceiling is nowhere near.
  const heldItsOwn = run.deferred.filter((r) => r.includes("daily episode budget exceeded"));
  assertEquals(heldItsOwn.length, 2);
  assertEquals(heldItsOwn[0]!.includes("source: deployment default"), false);
  // user-b is unaffected by user-a's budget: the fleet has room, so it spends.
  assert(run.paid >= 2, `expected the second subscriber to be served, paid ${run.paid}`);
});

Deno.test("the dashboard reports the fleet ceiling, its source and the day's usage (audio-feed-m182)", async () => {
  const stores: Stores = memoryStores();
  await seedInto(stores, "user-a", 1);
  await stores.metadata.putUser(
    makeUser({ id: "admin-1", status: "approved", isAdmin: true }),
  );

  const session = await createSession(stores.metadata, "admin-1");
  const appConfig: AppConfig = { ...config, globalDailyEpisodeBudget: 321 };
  const { fetch } = createApp(
    { config: appConfig, stores },
    createHandlers({
      config: appConfig,
      stores,
    }),
  );

  const response = await fetch(
    new Request("http://localhost/api/admin/stats", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    }),
  );
  assertEquals(response.status, 200);
  const stats = await response.json();
  assertEquals(stats.synthesis.globalDailyEpisodeBudget, 321);
  assertEquals(stats.synthesis.globalBudgetSource, "configured");
  assertEquals(stats.synthesis.globalEpisodesToday, 0);
  // The per-subscriber reporting is untouched.
  assertEquals(typeof stats.synthesis.defaultDailyEpisodeBudget, "number");
});

Deno.test("a stop()ped worker's own tick honours the fleet ceiling (audio-feed-m182)", async () => {
  // The batch helper above and the poll loop are different entry points; khk3's v2ym finding was
  // exactly that the manual path could ignore a ceiling the loop honoured. This drives the loop.
  const stores: Stores = memoryStores();
  for (const user of ["user-a", "user-b"]) await seedInto(stores, user, 2);
  let paid = 0;
  const worker = startSynthesisWorker({ config, stores }, () => {
    paid++;
    return Promise.resolve(fakeAudio());
  }, {
    batchSize: 10,
    intervalMs: 60_000,
    globalDailyEpisodeBudget: 2,
  });
  await worker.stop();
  assertEquals(paid, 2, "the loop spends exactly the fleet ceiling and no more");
});
