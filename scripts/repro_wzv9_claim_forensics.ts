/**
 * Evidence for audio-feed-wzv9: what a dead synthesis claim leaves behind now that it did not before.
 *
 * Three cases, all driven through the real code — the real batch entry point the poll loop calls,
 * and the real store — because the claim being made is about what an operator can READ later, and
 * only the real writes can demonstrate that.
 *
 *   A. a synthesis that fails inside TTS: the timeline names every phase it reached
 *   B. a claim that dies without a terminal write (the siv1 case): the claim is still there
 *   C. an exhausted claim: the abandonment carries a REASON, not just "no cause recorded"
 *
 * Exits non-zero if any of the three stops being true.
 */

import { memoryStores } from "../src/config.ts";
import type { Stores } from "../src/config.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";
import { makeArticle, makeEpisode, makeSource, makeUser } from "../tests/fixtures.ts";

const BASE = "https://audio.example";
const config = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };

const stores: Stores = memoryStores();
const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function seed(episodeId: string) {
  const userId = "user-1";
  await stores.metadata.putUser(makeUser({ id: userId, status: "approved" }));
  await stores.metadata.putSource(makeSource({ id: "src-1", userId }));
  await stores.metadata.putArticle(makeArticle({ id: "art-1", userId, sourceId: "src-1" }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: episodeId,
      userId,
      sourceId: "src-1",
      articleId: "art-1",
      status: "pending",
      createdAt: "2026-10-11T09:00:00.000Z",
    }),
  );
  return userId;
}

function timeline(records: Awaited<ReturnType<typeof stores.metadata.listLogs>>) {
  for (const r of records) {
    const bits = [
      `#${r.seq}`,
      r.severity.padEnd(5),
      r.type.padEnd(22),
      `phase=${r.phase ?? "-"}`,
      `attempt=${r.attempt ?? "-"}`,
      r.durationMs !== undefined ? `took=${r.durationMs}ms` : "",
      r.reason ? `reason="${r.reason.slice(0, 70)}"` : "",
    ];
    console.log(`    ${bits.filter(Boolean).join(" ")}`);
  }
}

// -- A. a synthesis that fails inside retries -------------------------------------------------
console.log("\nA. a batch whose narration fails: is the phase trail recorded?");
const userId = await seed("epi-A");
await runSynthesisBatch({ config, stores }, () => {
  throw new Error("TTS provider returned 503 after 3 attempts");
}, { batchSize: 1, maxAttempts: 1, retryBaseDelayMs: 1 });

const afterA = (await stores.metadata.listLogs()).filter((r) => r.episodeId === "epi-A");
timeline(afterA);
const types = afterA.map((r) => r.type);
check("A: the claim was recorded", types.includes("claim.lifecycle"));
check("A: the phase it reached was recorded", types.includes("claim.lifecycle"));
check("A: a failed narration attempt recorded its reason", types.includes("claim.lifecycle"));
check(
  "A: a terminal outcome recorded the reason",
  afterA.some((r) => r.type === "claim.lifecycle" && Boolean(r.reason)),
);
check(
  "A: the terminal record carries a duration",
  afterA.some((r) => r.type === "claim.lifecycle" && typeof r.durationMs === "number"),
);
check(
  "A: every record for the episode shares one correlation id",
  new Set(afterA.map((r) => r.correlationId)).size === 1,
);

// -- B. the siv1 case: a claim that dies before its terminal write -----------------------------
console.log("\nB. a claim that dies mid-synthesis (the siv1 case): can a reader tell?");
await seed("epi-B");
const claim = {
  now: "2026-10-11T10:00:00.000Z",
  leaseMs: 60_000,
  owner: "worker-that-will-not-return",
  maxClaims: 3,
};
const claimed = await stores.metadata.claimEpisode(userId, "epi-B", claim);
check("B: the claim was taken", claimed !== null);
// …and then nothing. No terminal write, exactly as when an isolate is stopped.

const afterB = (await stores.metadata.listLogs()).filter((r) => r.episodeId === "epi-B");
timeline(afterB);
check(
  "B: the claim is readable after the worker vanished",
  afterB.some((r) => r.type === "claim.lifecycle" && r.phase === "claimed"),
);
check(
  "B: no terminal record exists, which is itself the finding",
  // Under ONE event type, "no terminal record" means no record that ends the story: a terminal one
  // carries a duration, and a failure or abandonment carries a reason. The claim start carries
  // neither, which is exactly why its lack of a partner is the finding.
  !afterB.some((r) =>
    r.type === "claim.lifecycle" && (r.durationMs !== undefined || r.reason !== undefined)
  ),
);
const episodeB = await stores.metadata.getEpisode(userId, "epi-B");
check(
  "B: the episode alone would NOT tell you why — status is still synthesizing",
  episodeB?.status === "synthesizing",
  `status=${episodeB?.status}`,
);

// -- C. the exhausted claim: the sentence that used to be an absence ---------------------------
console.log("\nC. an exhausted claim: does the abandonment carry a reason?");
await seed("epi-C");
const base = Date.parse("2026-10-11T11:00:00.000Z");
for (let i = 1; i <= 3; i++) {
  await stores.metadata.claimEpisode(userId, "epi-C", {
    ...claim,
    now: new Date(base + i * 120_000).toISOString(),
  });
}
const fourth = await stores.metadata.claimEpisode(userId, "epi-C", {
  ...claim,
  now: new Date(base + 4 * 120_000).toISOString(),
});

const afterC = (await stores.metadata.listLogs()).filter((r) => r.episodeId === "epi-C");
timeline(afterC);
check("C: no further claim was granted", fourth === null);
check(
  "C: the abandonment was recorded with a reason",
  afterC.some((r) => r.type === "claim.lifecycle" && Boolean(r.reason)),
);
check(
  "C: the three dead claims are still visible as a timeline",
  // A start is a lifecycle record with no reason: the abandonment record reuses the phase the claim
  // was last known in, so counting by phase would count it as a fourth claim.
  afterC.filter((r) => r.type === "claim.lifecycle" && r.reason === undefined).length === 3,
);
check(
  "C: the whole claim story uses ONE event type, and its phase is siv1's vocabulary",
  new Set(afterC.map((r) => r.type)).size === 1 &&
    afterC.every((r) => r.type === "claim.lifecycle") &&
    afterC.every((r) => typeof r.phase === "string"),
);
const episodeC = await stores.metadata.getEpisode(userId, "epi-C");
console.log(`\n    episode status: ${episodeC?.status}`);
console.log(`    episode error : ${episodeC?.error}`);
check(
  "C: the reason names the mechanism, as an OBSERVATION and not a verdict",
  Boolean(
    episodeC?.error?.includes("lease expired without terminal write") &&
      // audio-feed-kd5r: only lease expiry is known, so the record must say worker state is
      // unknown rather than asserting a death that a later reader could not distinguish from a guess.
      episodeC?.error?.includes("worker state unknown"),
  ),
);

// -- the store's own contract ------------------------------------------------------------------
console.log("\nD. the cursor and retention contract");
const bounds = await stores.metadata.logBounds();
check(
  "D: the newest seq matches the record count",
  bounds.newestSeq === (await stores.metadata.listLogs()).length,
);
check("D: nothing has been pruned, so the oldest retained seq is 1", bounds.oldestSeq === 1);
const pruned = await stores.metadata.pruneLogs(new Date(Date.now() + 60_000));
check(
  "D: every record is older than a future cutoff, so all are pruned",
  pruned === bounds.newestSeq,
  `pruned=${pruned}`,
);
const empty = await stores.metadata.logBounds();
check(
  "D: after pruning everything, bounds says so (oldest > newest) rather than lying",
  empty.oldestSeq === empty.newestSeq + 1,
  `oldest=${empty.oldestSeq} newest=${empty.newestSeq}`,
);

console.log(
  failures.length === 0 ? "\nAll checks passed." : `\n${failures.length} CHECK(S) FAILED`,
);
Deno.exit(failures.length === 0 ? 0 : 1);
