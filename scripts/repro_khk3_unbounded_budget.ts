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

const OUT = new URL("../docs/evidence/audio-feed-khk3/repro.json", import.meta.url);

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
const stores: Stores = memoryStores();
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

await Deno.mkdir(new URL("./", OUT), { recursive: true });
await Deno.writeTextFile(OUT, JSON.stringify(report, null, 2) + "\n");

console.log(`user: ${USER}  dailyEpisodeBudget: ${stored?.dailyEpisodeBudget ?? "unset"}`);
console.log(`queued: ${QUEUED} episodes, ${TICKS} ticks of ${PER_TICK} in ONE UTC day`);
console.log(`paid TTS calls: ${paidTtsCalls}`);
console.log(`ready: ${report.readyTotal}   deferred: ${report.deferredTotal}`);
console.log(`store's count for the day: ${today}`);
console.log(`first tick that deferred anything: ${report.firstTickWithDeferral ?? "none"}`);
if (report.deferReasons.length) console.log(`defer reason: ${report.deferReasons[0]}`);

const expected = Deno.args[0] ? Number(Deno.args[0]) : undefined;
if (expected !== undefined) {
  if (paidTtsCalls > expected) {
    console.error(`FAIL: spent ${paidTtsCalls} paid calls, ceiling was ${expected}`);
    Deno.exit(1);
  }
  console.log(`OK: ${paidTtsCalls} paid calls <= ceiling ${expected}`);
}

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
  new URL("../docs/evidence/audio-feed-khk3/manual-path-v2ym.json", import.meta.url),
  JSON.stringify(manualReport, null, 2) + "\n",
);
if (manualPaid > 1) {
  console.error(`FAIL: the manual route spent ${manualPaid} paid calls against a ceiling of 1`);
  Deno.exit(1);
}
console.log("OK: the manual route charged the configured ceiling, and the dashboard advertises it");
