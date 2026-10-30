# audio-feed-s2pi — observability API verification (record of a historical proof)

- Capture: no assertions
- Reason: the script this directory used to declare (`scripts/verify_s2pi_errors_api.ts`) is
  HISTORICAL by its own first line (audio-feed-byh4j) — no suite executes it, so it is NOT evidence
  of current behaviour, and a declaration cannot present it as live proof. The live coverage of
  every shape the transcript below discovered is `tests/observability_api_test.ts`: an anonymous
  request refused and told how to authenticate; a wrong key refused; a cursor walk that sees every
  event exactly once, in order, and never moves backwards; a poll at the cursor returning nothing
  and keeping the cursor; `summary` answering "nothing changed" and counting what did change; a
  cursor retention has passed refused with `410 cursor_too_old` (and `summary` refusing it
  identically); and the shared key never reaching the store.

`verify-errors-api.txt` is a transcript of `scripts/verify_s2pi_errors_api.ts`, which drove the REAL
server (`bootstrap`) with the key supplied through the environment — the way a deployment provides
it, and with an invented key value that was never printed. That mattered because the unit tests
inject a config object and build the app with `createApp`, which does NOT run the request-logging
wrapper, so the unit tests could not see anything about how the API interacts with the store it is
reading. The script is kept as the record below, not as a runnable proof: no suite executes it, it
is not re-derivable against the current tree without re-wiring, and running it by hand drives a real
server to answer a question `tests/observability_api_test.ts` now answers.

## Two real bugs this caught that the unit tests could not

**The observer fed itself.** Every successful poll is a request, and the request wrapper records
successes unless the route is excluded — so each poll wrote an event into the store the poller was
asking about. `summary` could therefore never answer "nothing changed", and the feed would fill with
evidence of being read: correct code with no useful answer, and invisible to a unit test that drives
`createApp` (which does not log). Fixed by excluding the observability endpoints from success
records — failures are still recorded, so a rejected caller remains visible.

**A fully-pruned store looked empty, so a lost cursor was answered with silence.** The "empty store
is not too old" special case keyed on `oldestSeq > newestSeq`, which is what a store whose retention
has removed everything reports as well as one that has never held an event. A cursor from before a
full prune was accepted and returned an empty feed, presenting lost events as quiet — the one thing
the bead forbids. The measurement that distinguishes them: a store that has never held an event
reports `oldestSeq 1` (so `since=0` is not below it), while a pruned store reports
`prunedThrough + 1 > 1`. The rule is now one line with no special case, and the test asserts the
full-prune case explicitly along with "an early poller is still not refused".
