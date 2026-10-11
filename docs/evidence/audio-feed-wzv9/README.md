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
