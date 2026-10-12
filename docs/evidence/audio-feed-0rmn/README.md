# Script Stage Body-Read Error Preservation (audio-feed-0rmn)

- Script: scripts/repro_0rmn_script_body_read.ts
- Asserts: deadline refusal indicates 503 and explicit timeout; deadline refusal preserves status 503; deadline timeout on OK indicates timeout while reading body; deadline timeout on OK leaves status undefined; cancel refusal indicates caller cancellation; cancel refusal leaves status undefined; cancel on OK indicates caller cancellation; cancel on OK leaves status undefined; unreadable refusal preserves original error wording; unreadable refusal preserves status 502; malformed JSON preserves original error wording

## Scope & Mock Transport
All tests run in-process using injected mock `fetchFn` implementations returning custom `ReadableStream` instances. No real network sockets, TCP listeners, or Deno HTTP servers are used.

This verifies that `createGroundedScriptGenerator` correctly propagates stream cancellation and timeouts through its body-read catch handlers without translating caller aborts into provider errors.
