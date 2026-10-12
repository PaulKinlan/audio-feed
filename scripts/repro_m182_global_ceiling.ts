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
import { createChecker, runProof, writeEvidenceReadme } from "./proof-helper.ts";

runProof("audio-feed-m182", async () => {
  const NO_GLOBAL = Deno.args.includes("--no-global");
  const OUT = new URL("../docs/evidence/audio-feed-m182/", import.meta.url).pathname;
  await Deno.mkdir(OUT, { recursive: true });

  const chk = createChecker();

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
    pending +=
      (await stores.metadata.listEpisodes({ userId, status: "pending", limit: 50 })).length;
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
    chk.check(
      "without the fleet ceiling all episodes were paid",
      paid === SUBSCRIBERS * PER_SUBSCRIBER,
      `expected ${SUBSCRIBERS * PER_SUBSCRIBER}, got ${paid}`,
    );
    return;
  }

  chk.check(
    "spent calls stayed within the global ceiling",
    paid <= GLOBAL_CEILING,
    `spent ${paid} calls against a ceiling of ${GLOBAL_CEILING}`,
  );
  chk.check(
    "the ceiling was reached exactly",
    paid === GLOBAL_CEILING,
    `paid ${paid}`,
  );
  chk.check(
    "deferred remaining episodes cleanly",
    pending === SUBSCRIBERS * PER_SUBSCRIBER - GLOBAL_CEILING,
    `${pending} left pending`,
  );
  chk.check(
    "the day counter agrees with paid calls",
    report.globalCountForToday === paid,
    `counter: ${report.globalCountForToday}, paid: ${paid}`,
  );
  chk.check(
    "at least one deferral reason named the fleet ceiling",
    report.deferredReasons.some((r) => r.includes("across all subscribers")),
    `reasons: ${report.deferredReasons.join(", ")}`,
  );

  await writeEvidenceReadme({
    dir: OUT,
    script: "scripts/repro_m182_global_ceiling.ts",
    title: "Global TTS Ceiling Proof (audio-feed-m182)",
    asserts: [
      "spent calls stayed within the global ceiling",
      "the ceiling was reached exactly",
      "deferred remaining episodes cleanly",
      "the day counter agrees with paid calls",
      "at least one deferral reason named the fleet ceiling",
    ],
    sections: [
      {
        heading: "The problem",
        body:
          `khk3 gave every subscriber a daily ceiling (default 50). That bounds one subscriber and leaves the
total linear in the number of _approved_ subscribers — and approving one is a single button. Nothing
else in the deployment bounded the sum: only the admin approval gate and the worker's own
throughput, neither of which is a spending limit.`,
      },
      {
        heading: "What was measured",
        body:
          `\`scripts/repro_m182_global_ceiling.ts\` drives the real synthesis worker over three subscribers with
three episodes each (nine paid calls available) and reports what was actually paid. The counter it
depends on is written when an episode is really synthesised, so this is the only way to see the
ceiling operate.

| nine queued episodes, three subscribers       | before           | after (ceiling 4)                                                        |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| paid TTS calls                                | **9**            | **4**                                                                    |
| episodes still pending (deferred, not failed) | 0                | **5**                                                                    |
| the day's fleet counter                       | (does not exist) | 4                                                                        |
| deferral reason                               | —                | \`daily spend ceiling reached across all subscribers (limit: 4, used: 4)\` |

\`before.json\` is the pre-change tree (the option does not exist there, and \`deno run\` does not
type-check, so it is simply ignored). \`repro.json\` is the tree with the ceiling. The script fails
rather than reports: it checks that the ceiling was reached exactly, that the remainder is _pending_
and not _failed_, that the day counter agrees with the calls paid, and that some reason named the
fleet ceiling.`,
      },
      {
        heading: "The shape, mirroring khk3",
        body:
          `- Resolved \`explicit option -> deployment config -> constant\`, **inside the worker** at both the
  gather pass and the spend gate, so no entry point that synthesises can forget it (the v2ym lesson:
  a call site that forgot was exactly how the per-subscriber ceiling leaked).
- \`DEFAULT_GLOBAL_DAILY_EPISODE_BUDGET = 500\`, deliberately ten subscribers' worth at the
  per-subscriber default. High enough that a small deployment never meets it by accident, finite so
  the sum cannot run away while nobody is watching. \`GLOBAL_DAILY_EPISODE_BUDGET\` sets it; 0 means
  nothing is synthesised.
- An unusable value (NaN, negative, Infinity) counts as ABSENT, not unlimited, so no future refactor
  can hand it a number that means "no ceiling" — the same property khk3 asserts for the
  per-subscriber ceiling, asserted here over the helper.
- Exceeding it DEFERS: the episodes stay pending and the next UTC day serves them. Nothing is failed
  and nothing is spent.
- The day counter is incremented in the **same store write** as the per-user counter, and the
  conformance suite asserts the fleet total equals the sum of the per-user counts, because a ceiling
  measured against a counter that can drift from the per-subscriber ones is a ceiling on the wrong
  number.`,
      },
      {
        heading: "An interaction worth knowing (found by a failing test)",
        body:
          `The two ceilings interact, and the first version of the test got it wrong in an instructive way: a
single subscriber on the shipped per-subscriber default stops at 50, so one subscriber can never
reach a fleet ceiling of 500. Ten of them do. That is not a defect — it is the sizing rationale —
and it is now asserted explicitly in both directions: a fleet ceiling is a backstop, not a
replacement, and neither reason is reported as the other.`,
      },
    ],
  });
});
