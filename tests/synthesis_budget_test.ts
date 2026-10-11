/**
 * audio-feed-khk3 — a subscriber is never left without a daily ceiling.
 *
 * WHAT WAS WRONG
 * audio-feed-9mp made the per-user `dailyEpisodeBudget` OPTIONAL and recorded "default is no
 * ceiling" as an accepted criterion, so that adding the ceiling could not change behaviour for the
 * single-user deployment. The consequence is that discretionary spend had NO ceiling for exactly the
 * subscribers nobody had configured: the enforcement condition was
 * `typeof user.dailyEpisodeBudget === "number" && >= 0`, and `undefined` failed it. The only
 * remaining bounds were the admin approval gate and the worker's own throughput — neither of them a
 * spending limit.
 *
 * WHAT THESE TESTS PIN
 * 1. The unset case is bounded, by a deployment default that is a real number.
 * 2. The configured path is byte-for-byte unchanged, wording included (audio-feed-9mp's own test
 *    still reads the reason string), because the point is to close a hole, not to redesign the gate.
 * 3. There is no input — no user record, no option, no environment value — that yields "unlimited".
 *    That is asserted as a property over the helper rather than case by case, because the failure
 *    mode is a branch somebody adds later.
 * 4. The ceiling is VISIBLE: the deferral reason says which ceiling stopped the work, the log
 *    reports a subscriber held by the default once per run, and the admin dashboard reports each
 *    subscriber's effective ceiling and its source.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { DEFAULT_DAILY_EPISODE_BUDGET, loadConfig, memoryStores } from "../src/config.ts";
import {
  dailyEpisodeBudgetFor,
  runSynthesisBatch,
  startSynthesisWorker,
} from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
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

/** A store with `count` pending episodes for one subscriber, and nothing else. */
async function queue(
  userId: string,
  count: number,
  budget?: number,
): Promise<Stores> {
  const stores: Stores = memoryStores();
  await seedInto(stores, userId, count, budget);
  return stores;
}

/** Add the subscriber, one source, one article and `count` pending episodes to an existing store. */
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
  await stores.metadata.putSource(makeSource({ id: "src", userId }));
  await stores.metadata.putArticle(makeArticle({ id: "art", userId, sourceId: "src" }));
  for (let i = 0; i < count; i++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `ep-${String(i).padStart(2, "0")}`,
        userId,
        sourceId: "src",
        articleId: "art",
        status: "pending",
      }),
    );
  }
}

/** Run one batch, counting the calls that would have been billed. */
async function spend(
  stores: Stores,
  options: SynthesisWorkerOptions = {},
): Promise<{ paid: number; ready: number; deferred: string[]; warnings: string[] }> {
  let paid = 0;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const result = await runSynthesisBatch({ config, stores }, () => {
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

/** Drain many ticks of one UTC day, the way the two-minute cron does. */
async function spendOverTicks(
  stores: Stores,
  ticks: number,
  options: SynthesisWorkerOptions = {},
): Promise<{ paid: number; deferred: string[]; warnings: string[] }> {
  const day = Date.UTC(2026, 9, 10, 3, 0, 0);
  let paid = 0;
  const deferred: string[] = [];
  const warnings: string[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const run = await spend(stores, { ...options, nowMs: day + tick * 1000 });
    paid += run.paid;
    deferred.push(...run.deferred);
    warnings.push(...run.warnings);
  }
  return { paid, deferred, warnings };
}

// -- 1. the hole: no budget configured ------------------------------------

Deno.test("a subscriber with no daily budget is bounded by the deployment default (audio-feed-khk3)", async () => {
  const stores = await queue("unbudgeted", 3);

  const run = await spend(stores, { batchSize: 5, defaultDailyEpisodeBudget: 2 });

  assertEquals(run.paid, 2, "spend stops at the default ceiling");
  assertEquals(run.ready, 2);
  assertEquals(run.deferred.length, 1);
  assertStringIncludes(run.deferred[0]!, "daily episode budget exceeded (limit: 2, used: 2");
  assertStringIncludes(
    run.deferred[0]!,
    "source: deployment default - no per-user budget configured",
    "the reason must say the ceiling was a default, not a decision somebody made",
  );

  // Deferred, not failed: still pending, so tomorrow serves it (audio-feed-9mp's shape).
  assertEquals((await stores.metadata.getEpisode("unbudgeted", "ep-02"))?.status, "pending");
});

Deno.test("with nothing configured anywhere, the constant bounds the day (audio-feed-khk3)", async () => {
  const episodes = DEFAULT_DAILY_EPISODE_BUDGET + 1;
  const stores = await queue("unbudgeted", episodes);
  const ticks = Math.ceil(episodes / 5) + 1;

  // No worker option, no config field: the last-resort path a misconfigured deployment takes.
  const { paid, deferred } = await spendOverTicks(stores, ticks, { batchSize: 5 });

  assertEquals(
    paid,
    DEFAULT_DAILY_EPISODE_BUDGET,
    "the constant itself is the floor of last resort",
  );
  assertEquals(
    deferred.length >= 1,
    true,
    "the episode past the ceiling is deferred, not synthesized",
  );
  // A deferred episode stays pending, so the NEXT tick defers it again: one episode past the
  // ceiling appears once per tick, not once per day. What must hold is that nothing past the
  // ceiling was ever billed and that the reason names the default rather than a decision.
  for (const reason of deferred) assertStringIncludes(reason, "source: deployment default");
});

Deno.test("the configured deployment ceiling applies on EVERY synthesis path (audio-feed-v2ym)", async () => {
  // The finding: the first cut resolved the ceiling at the call sites, so the cron honoured
  // DEFAULT_DAILY_EPISODE_BUDGET while the admin "synthesize now" route and the poll loop charged
  // the constant — and the dashboard, reading the config, advertised a limit those paths were not
  // applying. This drives all three real entry points with a deployment ceiling of 1.

  const ceiling = { ...config, defaultDailyEpisodeBudget: 1 };

  // 1. the manual admin route, through the real app and a real HTTP request
  const manualStores: Stores = memoryStores();
  const manualCtx = { config: ceiling, stores: manualStores };
  await seedInto(manualStores, "manual-user", 60);
  let manualPaid = 0;
  const { fetch } = createApp(
    manualCtx,
    createHandlers(manualCtx, {
      synthesizer: () => {
        manualPaid++;
        return Promise.resolve(fakeAudio());
      },
    }),
  );
  for (let i = 0; i < 12; i++) {
    const response = await fetch(
      new Request("http://localhost/api/admin/synthesize-now", {
        method: "POST",
        headers: { "x-admin-token": "admin-secret" },
      }),
    );
    assertEquals(response.status, 200);
  }
  assert(
    manualPaid > 0,
    "the manual route must synthesise something, or this proves nothing about its ceiling",
  );
  assertEquals(
    manualPaid,
    1,
    "the manual route must charge the configured ceiling, not the constant",
  );

  // 2. the poll loop the server starts. Its first tick is already in flight when the constructor
  // returns, and `stop()` awaits that tick — so this drives the loop's OWN call, with no second
  // caller racing it and no timer to wait on.
  const loopStores: Stores = memoryStores();
  const loopCtx = { config: ceiling, stores: loopStores };
  await seedInto(loopStores, "loop-user", 60);
  let loopPaid = 0;
  const worker = startSynthesisWorker(loopCtx, () => {
    loopPaid++;
    return Promise.resolve(fakeAudio());
  }, { intervalMs: 60_000, batchSize: 5 });
  await worker.stop();
  assert(loopPaid > 0, "the poll loop must synthesise something");
  assertEquals(loopPaid, 1, "the poll loop must charge the configured ceiling, not the constant");

  // 3. the cron's call: no options at all, which is how production runs it
  const cronStores: Stores = memoryStores();
  const cronCtx = { config: ceiling, stores: cronStores };
  await seedInto(cronStores, "cron-user", 60);
  let cronPaid = 0;
  await runSynthesisBatch(cronCtx, () => {
    cronPaid++;
    return Promise.resolve(fakeAudio());
  });
  assert(cronPaid > 0, "the no-options path must synthesise something");
  assertEquals(cronPaid, 1, "the no-options path must charge the configured ceiling too");

  // And the number the dashboard advertises is the one all three paths just charged.
  const statsApp = createApp(
    { config: ceiling, stores: manualStores },
    createHandlers({ config: ceiling, stores: manualStores }, {
      synthesizer: () => Promise.resolve(fakeAudio()),
    }),
  );
  const body = await (await statsApp.fetch(
    new Request("http://localhost/api/admin/stats", {
      headers: { "x-admin-token": "admin-secret" },
    }),
  )).json() as { synthesis: { defaultDailyEpisodeBudget: number } };
  assertEquals(
    body.synthesis.defaultDailyEpisodeBudget,
    1,
    "visibility must advertise the ceiling the paths actually charge",
  );
});

Deno.test("the default is an operator knob, not a hardcoded number (audio-feed-khk3)", async () => {
  const stores = await queue("unbudgeted", 3);

  const run = await spend(stores, { batchSize: 5, defaultDailyEpisodeBudget: 1 });

  assertEquals(run.paid, 1, "a configured deployment default is the ceiling that applies");
  assertStringIncludes(run.deferred[0]!, "(limit: 1, used: 1");
});

// -- 2. the configured path is unchanged ----------------------------------

Deno.test("a configured budget keeps its exact wording and semantics (audio-feed-9mp)", async () => {
  const stores = await queue("budgeted", 3, 2);

  const run = await spend(stores, { batchSize: 5, defaultDailyEpisodeBudget: 50 });

  assertEquals(run.paid, 2, "the subscriber's own budget wins over the deployment default");
  assertEquals(
    run.deferred,
    ["daily episode budget exceeded (limit: 2, used: 2)"],
    "the configured path's reason is unchanged to the character — the dashboard and audio-feed-9mp's own test read it",
  );
  assertEquals(
    run.warnings,
    [],
    "a configured budget is doing its job quietly; only the default is reported",
  );
});

Deno.test("a budget of 0 still means 'synthesize nothing', not 'unlimited' (audio-feed-9mp)", async () => {
  const stores = await queue("stopped", 2, 0);

  const run = await spend(stores, { batchSize: 5, defaultDailyEpisodeBudget: 50 });

  assertEquals(run.paid, 0);
  assertEquals(run.deferred.length, 2);
  assertStringIncludes(run.deferred[0]!, "(limit: 0, used: 0)");
});

Deno.test("an unusable explicit budget no longer means unlimited (audio-feed-khk3)", async () => {
  // `Number("abc")` is what the admin form produced for a typo; `typeof` said number, the
  // comparison said no, and the budget was silently ignored — the same hole as never setting one.
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const stores = await queue("typo", 3, bad);
    const run = await spend(stores, { batchSize: 5, defaultDailyEpisodeBudget: 2 });
    assertEquals(run.paid, 2, `budget ${bad} must fall back to the ceiling, not remove it`);
    assertStringIncludes(run.deferred[0]!, "source: deployment default");
  }
});

// -- 3. the property: no branch is unbounded ------------------------------

Deno.test("the effective ceiling is a finite number for every input (audio-feed-khk3)", () => {
  const budgets = [undefined, 0, 1, 2.5, 50, -1, Number.NaN, Number.POSITIVE_INFINITY];
  const defaults = [undefined, 0, 7, -1, Number.NaN, Number.POSITIVE_INFINITY];

  for (const dailyEpisodeBudget of budgets) {
    for (const deploymentDefault of defaults) {
      const budget = dailyEpisodeBudgetFor({ dailyEpisodeBudget }, deploymentDefault);
      assert(
        Number.isFinite(budget.limit) && budget.limit >= 0,
        `budget ${String(dailyEpisodeBudget)} with default ${String(deploymentDefault)} produced ${
          String(budget.limit)
        }`,
      );
    }
  }

  // The rule for where the number came from, so a dashboard can say "default" honestly.
  assertEquals(dailyEpisodeBudgetFor({ dailyEpisodeBudget: 3 }).source, "user");
  assertEquals(dailyEpisodeBudgetFor({ dailyEpisodeBudget: 0 }).source, "user");
  assertEquals(dailyEpisodeBudgetFor({ dailyEpisodeBudget: 2.5 }).source, "user");
  assertEquals(dailyEpisodeBudgetFor({}).source, "default");
  assertEquals(dailyEpisodeBudgetFor(null).source, "default");
  assertEquals(dailyEpisodeBudgetFor({ dailyEpisodeBudget: Number.NaN }).source, "default");
  assertEquals(
    dailyEpisodeBudgetFor({}, Number.POSITIVE_INFINITY).limit,
    DEFAULT_DAILY_EPISODE_BUDGET,
  );
  assertEquals(dailyEpisodeBudgetFor({}, -1).limit, DEFAULT_DAILY_EPISODE_BUDGET);
});

// -- 4. visibility -------------------------------------------------------

Deno.test("a subscriber held by the default is reported once per run (audio-feed-khk3)", async () => {
  const stores = await queue("unbudgeted", 3);

  const run = await spend(stores, { batchSize: 5, defaultDailyEpisodeBudget: 2 });

  assertEquals(run.warnings.length, 1, "one line per run per subscriber, not one per episode");
  assertStringIncludes(run.warnings[0]!, "unbudgeted");
  assertStringIncludes(run.warnings[0]!, "deployment default daily ceiling of 2");
  assertStringIncludes(run.warnings[0]!, "audio-feed-khk3");
});

Deno.test("the admin dashboard reports each subscriber's ceiling and its source (audio-feed-khk3)", async () => {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "configured", status: "approved", dailyEpisodeBudget: 3 }),
  );
  await stores.metadata.putUser(makeUser({ id: "unconfigured", status: "approved" }));
  // Real spend, recorded by the worker, so the dashboard is reading what the gate acted on.
  await stores.metadata.recordSynthesis("configured", 480);
  await stores.metadata.recordSynthesis("unconfigured", 480);

  const ctx = { config: { ...config, defaultDailyEpisodeBudget: 12 }, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  const response = await fetch(
    new Request("http://localhost/api/admin/stats", {
      headers: { "x-admin-token": "admin-secret" },
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json() as {
    synthesis: {
      defaultDailyEpisodeBudget: number;
      usersWithoutBudget: number;
      perUser: Array<{ userId: string; dailyBudget: number; budgetSource: string }>;
    };
  };

  assertEquals(body.synthesis.defaultDailyEpisodeBudget, 12);
  assertEquals(body.synthesis.usersWithoutBudget, 1, "the cue to configure a real budget");
  const byUser = new Map(body.synthesis.perUser.map((u) => [u.userId, u]));
  assertEquals(byUser.get("configured")?.dailyBudget, 3);
  assertEquals(byUser.get("configured")?.budgetSource, "user");
  assertEquals(
    byUser.get("unconfigured")?.dailyBudget,
    12,
    "the ceiling the worker would apply is the one the dashboard shows",
  );
  assertEquals(byUser.get("unconfigured")?.budgetSource, "default");
});

Deno.test("DEFAULT_DAILY_EPISODE_BUDGET is a validated operator knob (audio-feed-khk3)", () => {
  const original = Deno.env.get("DEFAULT_DAILY_EPISODE_BUDGET");
  try {
    Deno.env.delete("DEFAULT_DAILY_EPISODE_BUDGET");
    assertEquals(loadConfig().defaultDailyEpisodeBudget, DEFAULT_DAILY_EPISODE_BUDGET);

    Deno.env.set("DEFAULT_DAILY_EPISODE_BUDGET", "3");
    assertEquals(loadConfig().defaultDailyEpisodeBudget, 3);

    Deno.env.set("DEFAULT_DAILY_EPISODE_BUDGET", "0");
    assertEquals(
      loadConfig().defaultDailyEpisodeBudget,
      0,
      "0 is legal: an unconfigured subscriber gets nothing",
    );

    // Fail closed at boot: a typo must not silently restore the unbounded default.
    for (const bad of ["abc", "-1", "2.5"]) {
      Deno.env.set("DEFAULT_DAILY_EPISODE_BUDGET", bad);
      let threw = false;
      try {
        loadConfig();
      } catch {
        threw = true;
      }
      assert(threw, `DEFAULT_DAILY_EPISODE_BUDGET="${bad}" must be refused at boot`);
    }

    // An empty value is "unset", not 0: a half-filled env file must land on the constant rather
    // than silently switching every unconfigured subscriber off.
    Deno.env.set("DEFAULT_DAILY_EPISODE_BUDGET", "");
    assertEquals(loadConfig().defaultDailyEpisodeBudget, DEFAULT_DAILY_EPISODE_BUDGET);
  } finally {
    if (original === undefined) Deno.env.delete("DEFAULT_DAILY_EPISODE_BUDGET");
    else Deno.env.set("DEFAULT_DAILY_EPISODE_BUDGET", original);
  }
});
