/**
 * Evidence for audio-feed-m182: the global daily TTS ceiling, measured on the real worker.
 *
 * khk3 bounded what one subscriber can spend. Total spend is still that times the number of approved
 * subscribers, and approving one is a single button. This drives the real synthesis worker over
 * several subscribers sharing a fleet-wide ceiling and reports paid vs deferred calls, which is the
 * only way to see the ceiling work: the counting it depends on is a store write performed when an
 * episode is actually synthesised.
 *
 * Run against a tree WITHOUT the change (--no-global) to see every episode paid, which is how
 * before.json was produced: the `globalDailyEpisodeBudget` option simply does not exist there, and
 * `deno run` does not type-check, so it is ignored and the ceiling never applies.
 *
 *   deno run -A scripts/repro_m182_global_ceiling.ts            # with the ceiling
 *   deno run -A scripts/repro_m182_global_ceiling.ts --no-global
 */
import { memoryStores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";

const NO_GLOBAL = Deno.args.includes("--no-global");
const OUT = new URL("../docs/evidence/audio-feed-m182/", import.meta.url).pathname;
await Deno.mkdir(OUT, { recursive: true });

const SUBSCRIBERS = 3;
const PER_SUBSCRIBER = 3;
const GLOBAL_CEILING = 4;
const DAY = new Date().toISOString().slice(0, 10);

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "http://localhost",
  adminToken: "admin-secret",
  // Raised so the ceiling under test is the FLEET one: on the shipped per-subscriber default a
  // subscriber stops at 50, and the point here is the sum.
  defaultDailyEpisodeBudget: 1000,
  ...(NO_GLOBAL ? {} : { globalDailyEpisodeBudget: GLOBAL_CEILING }),
};

function fakeAudio(bytes = 480): DecodedAudioResult {
  const raw = new Uint8Array(44 + bytes);
  raw.set([0x52, 0x49, 0x46, 0x46], 0);
  raw.set([0x57, 0x41, 0x56, 0x45], 8);
  raw.set([0x64, 0x61, 0x74, 0x61], 36);
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

const stores: Stores = memoryStores();
for (let u = 0; u < SUBSCRIBERS; u++) {
  const userId = `user-${u}`;
  await stores.metadata.putUser(makeUser({ id: userId, status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: `src-${u}`, userId }));
  await stores.metadata.putArticle(makeArticle({ id: `art-${u}`, userId, sourceId: `src-${u}` }));
  for (let e = 0; e < PER_SUBSCRIBER; e++) {
    await stores.metadata.putEpisode(
      makeEpisode({
        id: `${userId}-ep-${e}`,
        userId,
        sourceId: `src-${u}`,
        articleId: `art-${u}`,
        status: "pending",
      }),
    );
  }
}

let paid = 0;
const deferredReasons = new Set<string>();
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

try {
  // Repeated ticks of the same worker entry point the poll loop calls. Each pass takes what the
  // ceiling allows and leaves the rest pending.
  for (let tick = 0; tick < SUBSCRIBERS * PER_SUBSCRIBER + 1; tick++) {
    const result = await runSynthesisBatch({ config, stores }, () => {
      paid++;
      return Promise.resolve(fakeAudio());
    }, { batchSize: 5 });
    for (const d of result.deferred) deferredReasons.add(d.reason);
    if (result.ready.length === 0 && result.deferred.length === 0) break;
  }
} finally {
  console.warn = originalWarn;
}

let pending = 0;
let ready = 0;
for (let u = 0; u < SUBSCRIBERS; u++) {
  const userId = `user-${u}`;
  pending += (await stores.metadata.listEpisodes({ userId, status: "pending", limit: 50 })).length;
  ready += (await stores.metadata.listEpisodes({ userId, status: "ready", limit: 50 })).length;
}

const report = {
  bead: "audio-feed-m182",
  measuredAt: new Date().toISOString(),
  mode: NO_GLOBAL ? "no global ceiling (pre-change tree)" : "global ceiling in force",
  subscribers: SUBSCRIBERS,
  episodesQueued: SUBSCRIBERS * PER_SUBSCRIBER,
  configuredGlobalCeiling: NO_GLOBAL ? null : GLOBAL_CEILING,
  paidCalls: paid,
  readyEpisodes: ready,
  stillPending: pending,
  // The counter itself is part of this change, so a pre-change tree cannot report it. Read it
  // defensively rather than pretending it existed.
  globalCountForToday: typeof stores.metadata.getDailySynthesisCount === "function"
    ? await stores.metadata.getDailySynthesisCount(DAY)
    : null,
  deferredReasons: [...deferredReasons],
  warnedAboutTheDefaultCeiling: warnings.filter((w) => w.includes("fleet-wide daily ceiling")),
};

await Deno.writeTextFile(
  `${OUT}${NO_GLOBAL ? "before" : "repro"}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));

if (NO_GLOBAL) {
  if (paid !== SUBSCRIBERS * PER_SUBSCRIBER) {
    console.error(`FAIL: expected every queued episode paid, got ${paid}`);
    Deno.exit(1);
  }
  console.log(
    `OK (as expected): without the fleet ceiling all ${paid} episodes were paid — total spend is ` +
      `linear in the number of subscribers, which is the finding.`,
  );
  Deno.exit(0);
}

const problems: string[] = [];
if (paid > GLOBAL_CEILING) {
  problems.push(`spent ${paid} calls against a ceiling of ${GLOBAL_CEILING}`);
}
if (paid !== GLOBAL_CEILING) problems.push(`expected the ceiling to be reached exactly: ${paid}`);
if (pending !== SUBSCRIBERS * PER_SUBSCRIBER - GLOBAL_CEILING) {
  problems.push(
    `${pending} left pending, expected ${SUBSCRIBERS * PER_SUBSCRIBER - GLOBAL_CEILING}`,
  );
}
if (report.globalCountForToday !== paid) {
  problems.push(`the day counter says ${report.globalCountForToday}, the worker paid ${paid}`);
}
if (!report.deferredReasons.some((r) => r.includes("across all subscribers"))) {
  problems.push("no deferral reason named the fleet ceiling");
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  Deno.exit(1);
}
console.log(
  `OK: the fleet ceiling stopped paid work at ${paid} calls with ${pending} episodes deferred ` +
    `(not failed), and the day counter agrees.`,
);
