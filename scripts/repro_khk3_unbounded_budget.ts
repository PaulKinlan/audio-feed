/**
 * Repro and regression harness for audio-feed-khk3 — unbounded paid TTS spend when no
 * per-user `dailyEpisodeBudget` is configured.
 *
 * Run: timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_khk3_unbounded_budget.ts [ceiling]
 *
 * WHAT IT MEASURES
 * One approved user with NO `dailyEpisodeBudget`, 60 episodes queued, and twelve worker ticks that
 * all land in the SAME UTC day — the production shape, because the synthesis cron runs every two
 * minutes and a real day holds 720 of them. The synthesizer counts PAID calls, so the number below
 * `paidTtsCalls` is money, not a proxy for it.
 *
 * Before the fix there is no ceiling at all on this path: every tick reports `ready: 5, deferred: 0`
 * and the paid count reaches the queued count. After it, the user is clamped at the deployment
 * default and the remainder is deferred with a reason saying so — deferred, not failed, so the
 * episodes are still there tomorrow.
 *
 * Pass a ceiling argument to make it a regression gate: exit 1 when more was spent than allowed.
 * With no argument it only measures, which is how the pre-fix number in
 * docs/evidence/audio-feed-khk3/ was captured.
 */

import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";
import { runProof, writeEvidenceReadme } from "./proof-helper.ts";

const EVIDENCE_DIR = new URL("../docs/evidence/audio-feed-khk3/", import.meta.url).pathname;

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "http://localhost",
  adminToken: "x",
} as AppConfig;

/** The cron runs every two minutes; twelve ticks is twenty-four minutes of one day. */
const TICKS = 12;
/** The worker's default batchSize. */
const PER_TICK = 5;
const QUEUED = TICKS * PER_TICK;
/** Fixed, so every tick lands in the same UTC day: that is what a ceiling is per. */
const DAY_MS = Date.UTC(2026, 9, 10, 3, 0, 0);

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
  } as DecodedAudioResult;
}

const USER = "unbudgeted-user";

/** One approved subscriber with no budget of their own, and `count` pending episodes. */
async function seedSubscriber(target: Stores, userId: string, count: number): Promise<void> {
  const user = makeUser({ id: userId, status: "approved" });
  delete (user as { dailyEpisodeBudget?: number }).dailyEpisodeBudget;
  await target.metadata.putUser(user);
  await target.metadata.putSource(makeSource({ id: "src", userId }));
  await target.metadata.putArticle(makeArticle({ id: "art", userId, sourceId: "src" }));
  for (let i = 0; i < count; i++) {
    await target.metadata.putEpisode(
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

await runProof("repro_khk3_unbounded_budget", async (checker) => {
  const stores: Stores = memoryStores();
  await seedSubscriber(stores, USER, QUEUED);

  let paidTtsCalls = 0;
  const ticks: Array<{ tick: number; ready: number; deferred: number; reasons: string[] }> = [];
  for (let tick = 0; tick < TICKS; tick++) {
    const result = await runSynthesisBatch(
      { config, stores },
      () => {
        paidTtsCalls++;
        return Promise.resolve(fakeAudio());
      },
      { batchSize: PER_TICK, nowMs: DAY_MS + tick * 1000 },
    );
    ticks.push({
      tick,
      ready: result.ready.length,
      deferred: result.deferred.length,
      reasons: [...new Set(result.deferred.map((d) => d.reason))],
    });
  }

  const stored = await stores.metadata.getUser(USER);
  const today = await stores.metadata.getUserDailySynthesisCount(
    USER,
    new Date(DAY_MS).toISOString().slice(0, 10),
  );

  const report = {
    bead: "audio-feed-khk3",
    user: { id: USER, dailyEpisodeBudget: stored?.dailyEpisodeBudget ?? null },
    queuedEpisodes: QUEUED,
    ticks: TICKS,
    batchSize: PER_TICK,
    paidTtsCalls,
    readyTotal: ticks.reduce((n, t) => n + t.ready, 0),
    deferredTotal: ticks.reduce((n, t) => n + t.deferred, 0),
    countedTodayInStore: today,
    firstTickWithDeferral: ticks.find((t) => t.deferred > 0)?.tick ?? null,
    deferReasons: [...new Set(ticks.flatMap((t) => t.reasons))],
    perTick: ticks,
  };

  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  await Deno.writeTextFile(
    `${EVIDENCE_DIR}/repro.json`,
    JSON.stringify(report, null, 2) + "\n",
  );

  console.log(`user: ${USER}  dailyEpisodeBudget: ${stored?.dailyEpisodeBudget ?? "unset"}`);
  console.log(`queued: ${QUEUED} episodes, ${TICKS} ticks of ${PER_TICK} in ONE UTC day`);
  console.log(`paid TTS calls: ${paidTtsCalls}`);
  console.log(`ready: ${report.readyTotal}   deferred: ${report.deferredTotal}`);
  console.log(`store's count for the day: ${today}`);
  console.log(`first tick that deferred anything: ${report.firstTickWithDeferral ?? "none"}`);
  if (report.deferReasons.length) console.log(`defer reason: ${report.deferReasons[0]}`);

  const expected = Deno.args[0] ? Number(Deno.args[0]) : undefined;
  const ceiling = expected ?? 50;

  checker.check(
    "cron batch clamps paid TTS calls to deployment default (50)",
    expected !== undefined ? paidTtsCalls <= expected : paidTtsCalls === 50,
    `spent: ${paidTtsCalls}, ceiling: ${ceiling}`,
  );
  checker.check(
    "every paid call produced a ready episode",
    report.readyTotal === paidTtsCalls,
    `ready: ${report.readyTotal}, paid: ${paidTtsCalls}`,
  );
  checker.check(
    "excess episodes deferred past ceiling",
    report.readyTotal + report.deferredTotal === QUEUED,
    `ready: ${report.readyTotal}, deferred: ${report.deferredTotal}`,
  );
  checker.check(
    "deferral reason cites deployment default ceiling",
    report.deferReasons.some((r) => r.includes("deployment default")),
    `reason: '${report.deferReasons[0] ?? ""}'`,
  );
  checker.check(
    "store daily synthesis count matches ceiling",
    today === paidTtsCalls,
    `countedToday: ${today}`,
  );

  // ---------------------------------------------------------------------------
  // audio-feed-v2ym: the same ceiling through the MANUAL admin route.
  //
  // The review finding: the first cut resolved the deployment ceiling at the call
  // sites, so only the cron honoured DEFAULT_DAILY_EPISODE_BUDGET. The reviewer
  // measured this route charging the constant — 50 paid calls when the configured
  // ceiling was 1, with the dashboard advertising 1. Same measurement, same route,
  // driven through a real app and real requests.
  // ---------------------------------------------------------------------------

  const manualStores: Stores = memoryStores();
  const manualConfig = { ...config, defaultDailyEpisodeBudget: 1 };
  await seedSubscriber(manualStores, "manual-user", QUEUED);
  let manualPaid = 0;
  const manualCtx = { config: manualConfig, stores: manualStores };
  const manual = createApp(
    manualCtx,
    createHandlers(manualCtx, {
      synthesizer: () => {
        manualPaid++;
        return Promise.resolve(fakeAudio());
      },
    }),
  );
  for (let i = 0; i < TICKS; i++) {
    await manual.fetch(
      new Request("http://localhost/api/admin/synthesize-now", {
        method: "POST",
        headers: { "x-admin-token": "x" },
      }),
    );
  }
  const advertised = await (await manual.fetch(
    new Request("http://localhost/api/admin/stats", { headers: { "x-admin-token": "x" } }),
  )).json() as { synthesis: { defaultDailyEpisodeBudget: number } };

  console.log(
    `\nmanual route (/api/admin/synthesize-now x${TICKS}) with ceiling=1: ${manualPaid} paid calls; dashboard advertises ${advertised.synthesis.defaultDailyEpisodeBudget}`,
  );
  const manualReport = {
    bead: "audio-feed-v2ym",
    path: "POST /api/admin/synthesize-now",
    configuredCeiling: 1,
    requests: TICKS,
    queuedEpisodes: QUEUED,
    paidTtsCalls: manualPaid,
    advertisedCeiling: advertised.synthesis.defaultDailyEpisodeBudget,
  };
  await Deno.writeTextFile(
    `${EVIDENCE_DIR}/manual-path-v2ym.json`,
    JSON.stringify(manualReport, null, 2) + "\n",
  );

  checker.check(
    "manual route charges configured ceiling of 1",
    manualPaid === 1,
    `spent: ${manualPaid}, ceiling: 1`,
  );
  checker.check(
    "stats endpoint advertises configured ceiling of 1",
    advertised.synthesis.defaultDailyEpisodeBudget === 1,
    `advertised: ${advertised.synthesis.defaultDailyEpisodeBudget}`,
  );

  // Write README.md via writeEvidenceReadme
  await writeEvidenceReadme({
    dir: EVIDENCE_DIR,
    title: "audio-feed-khk3 — unbounded paid synthesis when no budget is configured",
    script: "scripts/repro_khk3_unbounded_budget.ts",
    asserts: [
      "cron batch clamps paid TTS calls to deployment default (50)",
      "every paid call produced a ready episode",
      "excess episodes deferred past ceiling",
      "deferral reason cites deployment default ceiling",
      "store daily synthesis count matches ceiling",
      "manual route charges configured ceiling of 1",
      "stats endpoint advertises configured ceiling of 1",
    ],
    sections: [
      {
        heading: "Overview",
        body:
          `\`before.json\` and \`repro.json\` are the same measurement run against the same script
(\`scripts/repro_khk3_unbounded_budget.ts\`): one approved subscriber with **no**
\`dailyEpisodeBudget\`, 60 episodes queued, twelve worker ticks that all land in the same UTC day —
the production shape, since the synthesis cron runs every two minutes. The synthesizer counts paid
calls, so \`paidTtsCalls\` is money rather than a proxy for it.

| | \`before.json\` (unfixed) | \`repro.json\` (fixed) |
| --- | --- | --- |
| \`paidTtsCalls\` | **60** | **50** |
| \`readyTotal\` | 60 | 50 |
| \`deferredTotal\` | 0 | 10 |
| \`firstTickWithDeferral\` | \`null\` | 10 |
| \`deferReasons\` | \`[]\` | \`daily episode budget exceeded (limit: 50, used: 50, source: deployment default - no per-user budget configured)\` |

Before: every queued episode was synthesised, nothing was ever deferred, and the store's count for
the day reached the queue depth — the ceiling did not exist on this path at all, because the
enforcement condition was \`typeof user.dailyEpisodeBudget === "number" && >= 0\` and \`undefined\`
failed it.

After: spend stops at the deployment default, the ten episodes past it are deferred (still
\`pending\`, so tomorrow serves them), and the reason says the ceiling was a default rather than a
decision somebody made. The fixed run also logs, once per run:

\`\`\`
[audio-feed] holding work for user unbudgeted-user at the deployment default daily ceiling of 50
(no per-user budget configured; set DEFAULT_DAILY_EPISODE_BUDGET or this subscriber's budget) (audio-feed-khk3)
\`\`\`

Reproduce either side:

\`\`\`sh
# measure only
timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_khk3_unbounded_budget.ts
# regression gate: exit 1 if more than 50 paid calls
timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_khk3_unbounded_budget.ts 50
\`\`\`

\`tests/synthesis_budget_test.ts\` pins the same properties at the unit and HTTP level: the unset case
is bounded, the configured path's wording and semantics are unchanged (audio-feed-9mp's own test in
\`tests/synthesis_worker_test.ts\` still reads the exact string it did), an unusable explicit budget
(NaN, negative, Infinity) falls back to the ceiling instead of removing it, the effective ceiling is
a finite number for every input combination, the log fires once per run, and
\`GET /api/admin/stats\` reports each subscriber's ceiling and its source.`,
      },
      {
        heading: "audio-feed-v2ym — the ceiling on every path, not just cron",
        body:
          `\`manual-path-v2ym.json\` is the reviewer's reproducer, run against the fixed tree: a deployment
ceiling of **1**, 60 episodes queued for one unbudgeted subscriber, and twelve requests to the real
\`POST /api/admin/synthesize-now\` route. Result: **1 paid call**, and \`/api/admin/stats\` advertises 1.

The finding was that the first cut resolved the deployment ceiling at the **call sites**, so only
cron honoured \`DEFAULT_DAILY_EPISODE_BUDGET\`: the manual route and \`startSynthesisWorker\` charged the
constant (the reviewer measured 50 paid calls where the ceiling was 1), while the dashboard read the
config and advertised the limit they were not applying — visibility making a false claim about the
thing it exists to show.

The fix removes the possibility rather than the instance: \`runSynthesisBatch\` resolves the ceiling
itself from \`ctx.config\` (explicit option, then config, then constant), \`defaultDailyEpisodeBudget\`
is deliberately not a key of the worker's \`DEFAULTS\` (a default spread into the options object masked
the config — that was the mechanism), and cron no longer threads anything. A new call site cannot get
it wrong, because there is nothing for it to pass. The test drives all three real entry points — the
admin route over HTTP, the poll loop's own first tick, and cron's no-options call — plus the
dashboard, and asserts all four agree on the number.`,
      },
    ],
  });
});
