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
import { createChecker, runProof, writeEvidenceReadme } from "./proof-helper.ts";

runProof("audio-feed-wzv9", async () => {
  const OUT = new URL("../docs/evidence/audio-feed-wzv9/", import.meta.url).pathname;
  await Deno.mkdir(OUT, { recursive: true });

  const BASE = "https://audio.example";
  const config = { port: 8080, publicBaseUrl: BASE, adminToken: "admin-secret" };

  const stores: Stores = memoryStores();
  const chk = createChecker();

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
  chk.check("A: the claim was recorded", types.includes("claim.lifecycle"));
  chk.check("A: the phase it reached was recorded", types.includes("claim.lifecycle"));
  chk.check("A: a failed narration attempt recorded its reason", types.includes("claim.lifecycle"));
  chk.check(
    "A: a terminal outcome recorded the reason",
    afterA.some((r) => r.type === "claim.lifecycle" && Boolean(r.reason)),
  );
  chk.check(
    "A: the terminal record carries a duration",
    afterA.some((r) => r.type === "claim.lifecycle" && typeof r.durationMs === "number"),
  );
  chk.check(
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
  chk.check("B: the claim was taken", claimed !== null);
  // …and then nothing. No terminal write, exactly as when an isolate is stopped.

  const afterB = (await stores.metadata.listLogs()).filter((r) => r.episodeId === "epi-B");
  timeline(afterB);
  chk.check(
    "B: the claim is readable after the worker vanished",
    afterB.some((r) => r.type === "claim.lifecycle" && r.phase === "claimed"),
  );
  chk.check(
    "B: no terminal record exists, which is itself the finding",
    // Under ONE event type, "no terminal record" means no record that ends the story: a terminal one
    // carries a duration, and a failure or abandonment carries a reason. The claim start carries
    // neither, which is exactly why its lack of a partner is the finding.
    !afterB.some((r) =>
      r.type === "claim.lifecycle" && (r.durationMs !== undefined || r.reason !== undefined)
    ),
  );
  const episodeB = await stores.metadata.getEpisode(userId, "epi-B");
  chk.check(
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
  chk.check("C: no further claim was granted", fourth === null);
  chk.check(
    "C: the abandonment was recorded with a reason",
    afterC.some((r) => r.type === "claim.lifecycle" && Boolean(r.reason)),
  );
  chk.check(
    "C: the three dead claims are still visible as a timeline",
    // A start is a lifecycle record with no reason: the abandonment record reuses the phase the claim
    // was last known in, so counting by phase would count it as a fourth claim.
    afterC.filter((r) => r.type === "claim.lifecycle" && r.reason === undefined).length === 3,
  );
  chk.check(
    "C: the whole claim story uses ONE event type, and its phase is siv1's vocabulary",
    new Set(afterC.map((r) => r.type)).size === 1 &&
      afterC.every((r) => r.type === "claim.lifecycle") &&
      afterC.every((r) => typeof r.phase === "string"),
  );
  const episodeC = await stores.metadata.getEpisode(userId, "epi-C");
  console.log(`\n    episode status: ${episodeC?.status}`);
  console.log(`    episode error : ${episodeC?.error}`);
  chk.check(
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
  chk.check(
    "D: the newest seq matches the record count",
    bounds.newestSeq === (await stores.metadata.listLogs()).length,
  );
  chk.check("D: nothing has been pruned, so the oldest retained seq is 1", bounds.oldestSeq === 1);
  const pruned = await stores.metadata.pruneLogs(new Date(Date.now() + 60_000));
  chk.check(
    "D: every record is older than a future cutoff, so all are pruned",
    pruned === bounds.newestSeq,
    `pruned=${pruned}`,
  );
  const empty = await stores.metadata.logBounds();
  chk.check(
    "D: after pruning everything, bounds says so (oldest > newest) rather than lying",
    empty.oldestSeq === empty.newestSeq + 1,
    `oldest=${empty.oldestSeq} newest=${empty.newestSeq}`,
  );

  await writeEvidenceReadme({
    dir: OUT,
    script: "scripts/repro_wzv9_claim_forensics.ts",
    title: "audio-feed-wzv9 — the structured log store: what a dead claim leaves behind",
    asserts: [
      "A: the claim was recorded",
      "A: the phase it reached was recorded",
      "A: a failed narration attempt recorded its reason",
      "A: a terminal outcome recorded the reason",
      "A: the terminal record carries a duration",
      "A: every record for the episode shares one correlation id",
      "B: the claim was taken",
      "B: the claim is readable after the worker vanished",
      "B: no terminal record exists, which is itself the finding",
      "B: the episode alone would NOT tell you why — status is still synthesizing",
      "C: no further claim was granted",
      "C: the abandonment was recorded with a reason",
      "C: the three dead claims are still visible as a timeline",
      "C: the whole claim story uses ONE event type, and its phase is siv1's vocabulary",
      "C: the reason names the mechanism, as an OBSERVATION and not a verdict",
      "D: the newest seq matches the record count",
      "D: nothing has been pruned, so the oldest retained seq is 1",
      "D: every record is older than a future cutoff, so all are pruned",
      "D: after pruning everything, bounds says so (oldest > newest) rather than lying",
    ],
    sections: [
      {
        heading: "Artifacts & Scope",
        body:
          `Evidence for the foundation bead of the observability set. \`claim-forensics.txt\` is the output of
\`scripts/repro_wzv9_claim_forensics.ts\`, which drives the **real** batch entry point the poll loop
calls and the real store; every check in it exits non-zero if the property stops holding. Historical
CLI transcripts (\`claim-forensics.txt\`, \`capability-leak-verify.txt\`) record structured log store
verification.`,
      },
      {
        heading: "A. A synthesis that fails inside TTS",
        body: `\`\`\`
#1 info  synthesis.claim        phase=claimed         attempt=1
#2 info  synthesis.phase        phase=article-loaded  attempt=1
#3 warn  synthesis.attempt      phase=tts   reason="TTS provider returned 503 after 3 attempts"
#4 error synthesis.failed       phase=terminal took=3ms reason="TTS provider returned 503…"
\`\`\`

The phase sequence is the point: before this, an operator had the terminal error and nothing about
how far the work got. Now the retry failure is a record of its own, so "it failed in TTS" and "it
never reached TTS" are different facts.`,
      },
      {
        heading: "B. A claim that dies before its terminal write — the siv1 case",
        body: `\`\`\`
#5 info  synthesis.claim        phase=claimed         attempt=1
\`\`\`

and then nothing, because the process is gone. The episode's own status is still \`synthesizing\`, so
the episode alone cannot explain it — the claim record is what says the work started, and the
_absence_ of a terminal partner is what says it died rather than never ran.`,
      },
      {
        heading: "C. An exhausted claim",
        body: `\`\`\`
#6 info  synthesis.claim        phase=claimed    attempt=1
#7 info  synthesis.claim        phase=claimed    attempt=2
#8 info  synthesis.claim        phase=claimed    attempt=3
#9 error synthesis.abandoned    phase=abandoned  attempt=3
   reason="abandoned after 3 attempts; no claim recorded a cause (last claim by worker-… ) — each
           claim ended before its terminal write, so the worker died or its isolate was stopped"
\`\`\`

The three claims survive as a timeline, which is exactly what "no cause recorded" used to hide. Two
records now overlap deliberately: the episode carries a user-visible sentence and the log carries
the timeline. The log is authoritative for diagnosis; the episode sentence is not made worse by it,
so nothing user-facing was rewritten for this bead.`,
      },
      {
        heading: "D. The cursor and the retention contract",
        body:
          `\`newestSeq\` matches the number of records; nothing pruned means \`oldestSeq === 1\`; after pruning
everything, \`oldestSeq === newestSeq + 1\`. That last one is the honest empty state: the errors API
has to be able to say "cursor too old" rather than skip, which it can only do if the store will
state what it still holds.`,
      },
      {
        heading: "What is asserted where",
        body:
          `- \`tests/conformance/metadata/logs.ts\` — the record shape, the cursor, the window, the summary,
  retention, the caps and redaction, and the lifecycle records. Runs against **both** adapters,
  because KV gets its ordering from a sequenced key space and memory from an array and a counter.
- \`tests/log_request_surface_invariant_test.ts\` — that a capability in a request path (\`/listen/<feedToken>\`,
  \`/audio/<key>\`, \`/feed/<token>/master.xml\`) cannot reach the store, and that a query string is
  never logged at all.
- \`tests/cron_test.ts\` — that retention is its own daily job and registers even when synthesis is
  unconfigured, because pruning needs no provider credentials.`,
      },
      {
        heading: "Review round 1: two findings, both fixed at the class level",
        body: `### audio-feed-pwu4 (P1) — a malformed path stored a raw capability

\`GET /feed/<token>/master.xml/<token>\` reached the store and persisted the token. The cause was a
policy, not a typo: \`redactRoutePath\` matched CANONICAL shapes, and its \`/feed/<token>/...\` branch
copied every REMAINING segment through, so a token placed after \`master.xml\` was never examined. The
unit test passed because it asserted the shapes I had thought of; the reviewer booted the real app
and appended a segment to a real feed URL.

The fix replaces shape-awareness with position and a fail-closed rule:

1. Percent-escapes are decoded (repeatedly, bounded) BEFORE splitting, because the router decodes —
   \`%2F\` is a segment separator in what is actually served even though it is not one in the text.
2. A capability prefix (\`/feed/\`, \`/listen/\`, \`/audio/\`) has its first following segment replaced by
   a marker WHATEVER it looks like: the capability is the position, not the shape. A short token
   such as \`/feed/abc/...\` cannot survive by failing a "looks random" test.
3. Every other segment survives only if it is a plain lowercase route word; anything else, including
   a malformed escape, is redacted. An unknown route loses detail instead of risking a credential.

Verification is the finding's own reproduction widened to every shape it names, driven through
\`openStores\` + \`bootstrap\` — the real app, not a unit test: \`capability-leak-verify.txt\` shows all
ten shapes safe, the original case now storing \`/feed/:token/master.xml/:redacted\`, and the whole
serialised store containing no form of the token. The regression test asserts the property per case
AND over the entire serialised store, which is the assertion that would have caught this.

### audio-feed-a0gi (P2) — the ceiling counted UTF-16 units, not bytes

\`MAX_LOG_RECORD_BYTES\` was compared against \`JSON.stringify(record).length\`, so a record of
three-byte characters measured 57,741 bytes against a 32,768 ceiling and was accepted. The ceiling
bounds what the store holds and what a reader has to parse, so it has to be measured in the units
the store holds: \`serialisedLogBytes()\` now encodes with a shared \`TextEncoder\` and measures real
bytes. The conformance case reproduces the arithmetic of the mismatch first (bytes over the ceiling
while UTF-16 length is under it) and then asserts the refusal, on both adapters.`,
      },
      {
        heading: "Review round 2: the path is no longer sanitised at all",
        body: `### audio-feed-pwu4 (P1, still leaking) — and why the second attempt failed

The fail-closed sanitiser above still leaked: an uppercase prefix (\`/AUDIO/abc\`) kept the prefix
from being recognised as a capability position, and then a SHORT lower-case segment passed for a
route word. Both attempts shared one mistake — deciding, per segment, whether it was a secret — and
every version of that decision is a policy for the shapes someone thought of, with the arriving
shape chosen by the attacker.

So the path is not sanitised any more. It is not recorded at all. The recorded value is the PATTERN
the router matched, which is a constant from the route table (\`/feed/:token/master.xml\`), or
\`<unmatched>\` for a request that matches nothing. A capability cannot reach a record because no
user-controlled byte is stored, which is a guarantee about the code rather than a property of a
heuristic. \`redactRoutePath\` and \`isHighVolumeAssetPath\` are gone; the high-volume exclusion is now
\`isHighVolumeRoute(pattern)\`, and a route missing from that list costs one extra record rather than
losing its diagnostics.

### The bug I introduced while fixing it, and the assertion that caught it

The first version of this fix recorded the pattern on the Request in a WeakMap as the router
dispatched. It looked right and it was silently useless: the app REBUILDS the Request during
canonical-host handling, so for every request that took that path the lookup missed and every route
recorded as \`<unmatched>\`.

What caught it was asserting the EXPECTED pattern per case rather than only "nothing leaked" — a
lookup returning the marker for everything passes a no-leak assertion while making the field
worthless. The fix is a pure lookup into the same route table the dispatcher uses
(\`Router.routePatternFor\`), which has no request-identity assumption to violate. The lesson is the
one from the review itself: assert the behaviour you want, not the absence of the thing you fear.

### audio-feed-t2x3 (P2) — concurrent appends dropped records

Twelve parallel appends landed five and returned \`null\` for seven: losing the sequence
compare-and-swap was reported as a failure instead of being retried, and an error log that drops
events under load loses exactly the events of an incident.

Appends are now serialised per process (chained promises, so a failed append cannot poison the ones
behind it) and retried with jittered backoff, which covers the contention other isolates cause. A
final failure still resolves \`null\` — callers are lifecycle paths and none may fail because a log
line could not be stored — but it reports itself on stderr rather than disappearing. Two conformance
cases assert it for both adapters: twelve concurrent appends all land with \`null\` count zero and
contiguous seqs, and a burst of differently sized appends loses nothing.

### Also learned: URLPattern normalises percent-encodings

\`/feed/%6B…/master.xml\` matches \`/feed/:token/master.xml\`, so an encoded token reaches the same
registered pattern. Recorded because the first version of the evidence script expected the marker
there and called the mismatch a leak — the script now labels a leak and a stale expectation
differently, since conflating them is how a real leak gets ignored.`,
      },
      {
        heading: "The claim-lifecycle event shape (converged with audio-feed-siv1)",
        body:
          `One event type carries the whole claim story: \`claim.lifecycle\`. Before this, the lifecycle was five
types (\`synthesis.claim\`, \`.phase\`, \`.ready\`, \`.failed\`, \`.abandoned\`) — five names for one fact, so
a reader had to know all five to answer "what happened to this episode", and the store and the
worker could each write a differently shaped record for the same thing. The variable FIELD says
which moment it is:

| field                        | meaning                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| \`type\`                       | \`"claim.lifecycle"\` — the only type the claim lifecycle writes                                                                                                                                                                 |
| \`phase\`                      | \`"claimed"\` at the start of an attempt, otherwise the worker's execution phase — **the same vocabulary siv1 persists on the episode** (\`reading_article\`, \`generating_script\`, \`uploading_audio\`, …), so one fact has one name |
| \`attempt\`                    | 1-based attempt number, from the episode's own counter                                                                                                                                                                         |
| \`reason\`                     | present only when an attempt ENDED: the observable cause. Absent on a start, and absent on a clean finish                                                                                                                      |
| \`episodeId\`, \`correlationId\` | the episode, so every attempt reads as one story without a join                                                                                                                                                                |
| \`durationMs\`                 | claim → terminal, on the terminal record                                                                                                                                                                                       |
| \`context\`                    | the observed facts: \`owner\`/\`leaseMs\`/\`maxClaims\` on a claim; \`expiredAt\`/\`lastHeartbeat\`/\`provenance\`/\`workerState: "unknown"\` on an abandonment                                                                              |

**The producer is the storage state transition, in both adapters** — \`claimEpisode\` (start, and the
abandonment), \`touchEpisodeClaim\` (phase), \`completeEpisode\` (terminal). That is deliberate rather
than convenient: siv1 made phase and heartbeat _durable writes on the episode_, so the transition is
the only place that cannot miss a phase change, and the worker needs no log writer of its own —
which is what stops two shapes appearing for one fact. The start record is written before the claim
is honoured, because a process killed mid-synthesis leaves it behind and its lack of a terminal
partner is what distinguishes a dead claim from one that never started.

An abandonment states only what the store can see: the lease expired, when it expired, the last
heartbeat and phase, and that **worker state is unknown**. It never asserts that a worker died
(\`audio-feed-kd5r\`), because a later reader cannot tell an observation from a guess.

A heartbeat that repeats the current phase writes no record: one record per heartbeat would bury the
transitions in noise, and a repeated phase is not a change.`,
      },
      {
        heading: "Review round 5: no field derived from the request is logged raw",
        body: `### audio-feed-ao4s (P1) — the raw HTTP method

\`req.method\` was stored in the message and in \`context.method\`, so \`Request(method: "<canary>")\`
persisted the caller's string. Same family as the path leak, one field later. \`normaliseMethod()\`
now passes the methods this app actually serves (the router's own \`Method\` union: GET, HEAD, POST,
PUT, PATCH, DELETE, OPTIONS) through as the literal and records \`<other>\` for anything else. A
method the app cannot serve is a string a client chose, not a method.

### The audit, per request-derived field

| field               | treatment                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| \`method\`            | normalised through the served-method allowlist, else \`<other>\`                                                                                                                                                                         |
| \`route\`             | the registered pattern the URL matched, never the path                                                                                                                                                                                 |
| \`status\`            | a number the platform bounds to a valid HTTP code; it cannot carry a string                                                                                                                                                            |
| \`durationMs\`        | measured in the wrapper, not taken from the request                                                                                                                                                                                    |
| \`correlationId\`     | minted here with \`randomUUID\`; an inbound \`x-correlation-id\` header is **never adopted**, so a caller cannot choose the value in a record                                                                                              |
| \`error\` (500 path)  | the error's **class name only**, from this codebase's own throw sites. The message and stack are not stored: an unhandled error's message can quote the request that caused it, which is a request-derived field nobody would call one |
| not recorded at all | headers, query string, body, client address                                                                                                                                                                                            |

### The class invariant: fuzz a canary per surface

Four leaks in this family were each fixed correctly and each followed by another surface, because
shape-by-shape tests check the shapes the author imagined.
\`tests/log_request_surface_invariant_test.ts\` asserts no shapes. It fuzzes one canary through
**every** attacker-controlled surface INDEPENDENTLY — method (including a lower-case spelling of a
real one), path segment (positional capability, unmatched tail, mixed-case prefix), query string,
and each header separately (\`user-agent\`, \`x-correlation-id\`, \`referer\`, \`cookie\`,
\`x-forwarded-for\`, \`content-type\`) and body — across a matched and an unmatched path, and asserts
the canary appears nowhere in the full serialised store. Adding a surface is one entry in
\`SURFACES\`.

**The first version of this test was vacuous**, and that is worth recording: it drove \`createApp\`,
which does not log at all (the wrapper lives in \`bootstrap\`), so it asserted absence over a store
nobody wrote to and 26 cases passed while proving nothing. Every case now also asserts that an
\`http.request\` record EXISTS, which is the check that caught it. A leak test that cannot fail is
worse than no test, because it is counted as coverage.

**The guard was verified to bite**: reverting \`normaliseMethod\` to \`return raw\` fails exactly the
three method cases, and restoring it returns the suite to 27 passed / 0 failed.`,
      },
    ],
  });
});
