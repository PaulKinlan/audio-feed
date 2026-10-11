# audio-feed-s2pi — observability API verification

`verify-errors-api.txt` is a transcript of `scripts/verify_s2pi_errors_api.ts`, which drives the
REAL server (`bootstrap`) with the key supplied through the environment — the way a deployment
provides it. That matters because the unit tests inject a config object and build the app with
`createApp`, which does NOT run the request-logging wrapper, so the unit tests cannot see anything
about how the API interacts with the store it is reading. Re-running it is one command:

```
deno run -A --unstable-kv scripts/verify_s2pi_errors_api.ts
```

It asserts: an anonymous request is refused and told how to authenticate; a wrong key is refused; a
cursor walk over pages sees every event exactly once, in order, never moving backwards; a poll at
the cursor returns nothing and keeps the cursor; `summary` answers "nothing changed"; `summary`
counts what did change; new events move the cursor; a cursor retention has passed is refused with
`410 cursor_too_old` (and `summary` refuses it identically); and the shared key never reaches the
store.

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
