# audio-feed-wzv9 — the structured log store: what a dead claim leaves behind

Evidence for the foundation bead of the observability set. `claim-forensics.txt` is the output of
`scripts/repro_wzv9_claim_forensics.ts`, which drives the **real** batch entry point the poll loop
calls and the real store; every check in it exits non-zero if the property stops holding.

## A. A synthesis that fails inside TTS

```
#1 info  synthesis.claim        phase=claimed         attempt=1
#2 info  synthesis.phase        phase=article-loaded  attempt=1
#3 warn  synthesis.attempt      phase=tts   reason="TTS provider returned 503 after 3 attempts"
#4 error synthesis.failed       phase=terminal took=3ms reason="TTS provider returned 503…"
```

The phase sequence is the point: before this, an operator had the terminal error and nothing about
how far the work got. Now the retry failure is a record of its own, so "it failed in TTS" and "it
never reached TTS" are different facts.

## B. A claim that dies before its terminal write — the siv1 case

```
#5 info  synthesis.claim        phase=claimed         attempt=1
```

and then nothing, because the process is gone. The episode's own status is still `synthesizing`, so
the episode alone cannot explain it — the claim record is what says the work started, and the
_absence_ of a terminal partner is what says it died rather than never ran.

## C. An exhausted claim

```
#6 info  synthesis.claim        phase=claimed    attempt=1
#7 info  synthesis.claim        phase=claimed    attempt=2
#8 info  synthesis.claim        phase=claimed    attempt=3
#9 error synthesis.abandoned    phase=abandoned  attempt=3
   reason="abandoned after 3 attempts; no claim recorded a cause (last claim by worker-… ) — each
           claim ended before its terminal write, so the worker died or its isolate was stopped"
```

The three claims survive as a timeline, which is exactly what "no cause recorded" used to hide. Two
records now overlap deliberately: the episode carries a user-visible sentence and the log carries
the timeline. The log is authoritative for diagnosis; the episode sentence is not made worse by it,
so nothing user-facing was rewritten for this bead.

## D. The cursor and the retention contract

`newestSeq` matches the number of records; nothing pruned means `oldestSeq === 1`; after pruning
everything, `oldestSeq === newestSeq + 1`. That last one is the honest empty state: the errors API
has to be able to say "cursor too old" rather than skip, which it can only do if the store will
state what it still holds.

## What is asserted where

- `tests/conformance/metadata/logs.ts` — the record shape, the cursor, the window, the summary,
  retention, the caps and redaction, and the lifecycle records. Runs against **both** adapters,
  because KV gets its ordering from a sequenced key space and memory from an array and a counter.
- `tests/log_route_redaction_test.ts` — that a capability in a request path (`/listen/<feedToken>`,
  `/audio/<key>`, `/feed/<token>/master.xml`) cannot reach the store, and that a query string is
  never logged at all.
- `tests/cron_test.ts` — that retention is its own daily job and registers even when synthesis is
  unconfigured, because pruning needs no provider credentials.

## Review round 1: two findings, both fixed at the class level

### audio-feed-pwu4 (P1) — a malformed path stored a raw capability

`GET /feed/<token>/master.xml/<token>` reached the store and persisted the token. The cause was a
policy, not a typo: `redactRoutePath` matched CANONICAL shapes, and its `/feed/<token>/...` branch
copied every REMAINING segment through, so a token placed after `master.xml` was never examined. The
unit test passed because it asserted the shapes I had thought of; the reviewer booted the real app
and appended a segment to a real feed URL.

The fix replaces shape-awareness with position and a fail-closed rule:

1. Percent-escapes are decoded (repeatedly, bounded) BEFORE splitting, because the router decodes —
   `%2F` is a segment separator in what is actually served even though it is not one in the text.
2. A capability prefix (`/feed/`, `/listen/`, `/audio/`) has its first following segment replaced by
   a marker WHATEVER it looks like: the capability is the position, not the shape. A short token
   such as `/feed/abc/...` cannot survive by failing a "looks random" test.
3. Every other segment survives only if it is a plain lowercase route word; anything else, including
   a malformed escape, is redacted. An unknown route loses detail instead of risking a credential.

Verification is the finding's own reproduction widened to every shape it names, driven through
`openStores` + `bootstrap` — the real app, not a unit test: `capability-leak-verify.txt` shows all
ten shapes safe, the original case now storing `/feed/:token/master.xml/:redacted`, and the whole
serialised store containing no form of the token. The regression test asserts the property per case
AND over the entire serialised store, which is the assertion that would have caught this.

### audio-feed-a0gi (P2) — the ceiling counted UTF-16 units, not bytes

`MAX_LOG_RECORD_BYTES` was compared against `JSON.stringify(record).length`, so a record of
three-byte characters measured 57,741 bytes against a 32,768 ceiling and was accepted. The ceiling
bounds what the store holds and what a reader has to parse, so it has to be measured in the units
the store holds: `serialisedLogBytes()` now encodes with a shared `TextEncoder` and measures real
bytes. The conformance case reproduces the arithmetic of the mismatch first (bytes over the ceiling
while UTF-16 length is under it) and then asserts the refusal, on both adapters.

## Review round 2: the path is no longer sanitised at all

### audio-feed-pwu4 (P1, still leaking) — and why the second attempt failed

The fail-closed sanitiser above still leaked: an uppercase prefix (`/AUDIO/abc`) kept the prefix
from being recognised as a capability position, and then a SHORT lower-case segment passed for a
route word. Both attempts shared one mistake — deciding, per segment, whether it was a secret — and
every version of that decision is a policy for the shapes someone thought of, with the arriving
shape chosen by the attacker.

So the path is not sanitised any more. It is not recorded at all. The recorded value is the PATTERN
the router matched, which is a constant from the route table (`/feed/:token/master.xml`), or
`<unmatched>` for a request that matches nothing. A capability cannot reach a record because no
user-controlled byte is stored, which is a guarantee about the code rather than a property of a
heuristic. `redactRoutePath` and `isHighVolumeAssetPath` are gone; the high-volume exclusion is now
`isHighVolumeRoute(pattern)`, and a route missing from that list costs one extra record rather than
losing its diagnostics.

### The bug I introduced while fixing it, and the assertion that caught it

The first version of this fix recorded the pattern on the Request in a WeakMap as the router
dispatched. It looked right and it was silently useless: the app REBUILDS the Request during
canonical-host handling, so for every request that took that path the lookup missed and every route
recorded as `<unmatched>`.

What caught it was asserting the EXPECTED pattern per case rather than only "nothing leaked" — a
lookup returning the marker for everything passes a no-leak assertion while making the field
worthless. The fix is a pure lookup into the same route table the dispatcher uses
(`Router.routePatternFor`), which has no request-identity assumption to violate. The lesson is the
one from the review itself: assert the behaviour you want, not the absence of the thing you fear.

### audio-feed-t2x3 (P2) — concurrent appends dropped records

Twelve parallel appends landed five and returned `null` for seven: losing the sequence
compare-and-swap was reported as a failure instead of being retried, and an error log that drops
events under load loses exactly the events of an incident.

Appends are now serialised per process (chained promises, so a failed append cannot poison the ones
behind it) and retried with jittered backoff, which covers the contention other isolates cause. A
final failure still resolves `null` — callers are lifecycle paths and none may fail because a log
line could not be stored — but it reports itself on stderr rather than disappearing. Two conformance
cases assert it for both adapters: twelve concurrent appends all land with `null` count zero and
contiguous seqs, and a burst of differently sized appends loses nothing.

### Also learned: URLPattern normalises percent-encodings

`/feed/%6B…/master.xml` matches `/feed/:token/master.xml`, so an encoded token reaches the same
registered pattern. Recorded because the first version of the evidence script expected the marker
there and called the mismatch a leak — the script now labels a leak and a stale expectation
differently, since conflating them is how a real leak gets ignored.

## The claim-lifecycle event shape (converged with audio-feed-siv1)

One event type carries the whole claim story: `claim.lifecycle`. Before this, the lifecycle was five
types (`synthesis.claim`, `.phase`, `.ready`, `.failed`, `.abandoned`) — five names for one fact, so
a reader had to know all five to answer "what happened to this episode", and the store and the
worker could each write a differently shaped record for the same thing. The variable FIELD says
which moment it is:

| field                        | meaning                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`                       | `"claim.lifecycle"` — the only type the claim lifecycle writes                                                                                                                                                                 |
| `phase`                      | `"claimed"` at the start of an attempt, otherwise the worker's execution phase — **the same vocabulary siv1 persists on the episode** (`reading_article`, `generating_script`, `uploading_audio`, …), so one fact has one name |
| `attempt`                    | 1-based attempt number, from the episode's own counter                                                                                                                                                                         |
| `reason`                     | present only when an attempt ENDED: the observable cause. Absent on a start, and absent on a clean finish                                                                                                                      |
| `episodeId`, `correlationId` | the episode, so every attempt reads as one story without a join                                                                                                                                                                |
| `durationMs`                 | claim → terminal, on the terminal record                                                                                                                                                                                       |
| `context`                    | the observed facts: `owner`/`leaseMs`/`maxClaims` on a claim; `expiredAt`/`lastHeartbeat`/`provenance`/`workerState: "unknown"` on an abandonment                                                                              |

**The producer is the storage state transition, in both adapters** — `claimEpisode` (start, and the
abandonment), `touchEpisodeClaim` (phase), `completeEpisode` (terminal). That is deliberate rather
than convenient: siv1 made phase and heartbeat _durable writes on the episode_, so the transition is
the only place that cannot miss a phase change, and the worker needs no log writer of its own —
which is what stops two shapes appearing for one fact. The start record is written before the claim
is honoured, because a process killed mid-synthesis leaves it behind and its lack of a terminal
partner is what distinguishes a dead claim from one that never started.

An abandonment states only what the store can see: the lease expired, when it expired, the last
heartbeat and phase, and that **worker state is unknown**. It never asserts that a worker died
(`audio-feed-kd5r`), because a later reader cannot tell an observation from a guess.

A heartbeat that repeats the current phase writes no record: one record per heartbeat would bury the
transitions in noise, and a repeated phase is not a change.
