# Outbox Notification Verification Report: audio-feed-np5

- Script: scripts/outbox-proof.ts
- Asserts: on-demand notification places exactly one outbox entry on synthesis completion; background feed polls emit none; permanent synthesis failures notify once with the specific reason and in-batch retries do not duplicate; a rejected outbox write does not abort episode completion and the failure is logged; no credentials, tokens, or admin secrets are echoed beyond subscriber player URL; outbox notification is opt-in only, default false

## Verified Criteria
1. **On-Demand Notification**: Submitting an article via `/api/ingest` places exactly 1 entry in the outbox upon synthesis completion, naming the episode title and player URL.
2. **Feed Poll Silence**: Background feed polls synthesizing multiple episodes do NOT emit outbox entries.
3. **Failure Reporting & Deduplication**: Permanent synthesis failures notify once with the specific error reason. In-batch retries are verified to occur and do not duplicate notifications.
4. **Resilience**: Outbox write rejections do not abort episode completion; failure is logged.
5. **Security**: Zero credentials, tokens, or admin secrets are echoed in notification payloads, server logs, or run history beyond the subscriber's own player URL.
6. **Opt-in Only**: Outbox notifications are disabled by default (`notifyOutboxEnabled: false`).

## Execution Log
```
PASS POST /api/ingest returns 202 under default config: status: 202
PASS default config without notifyOutboxEnabled emits zero outbox notifications: ready: 1, outbox entries: 0
PASS POST /api/ingest returns 202: status: 202
PASS synthesis batch completes 1 episode: ready: 1
PASS outbox holds 1 notification for on-demand article: entries: 1
PASS notification names episode title and player URL: title='On-Demand Read Article', playerUrl='http://localhost:<ephemeral>/listen/subscriber-token-123', status='ready'
PASS synthesis batch completes 3 feed episodes: ready: 3
PASS feed poll episodes did NOT create outbox notifications: outbox count remains 1
PASS synthesis retries in-batch and executes 2 attempts: attempts: 2
PASS failing episode marked failed: failed: 1
PASS outbox now holds 2 entries (ready + failed): entries: 2
PASS failed notification contains failure reason: error: 'Gemini quota exhausted [mode direct; claim 1/3]'
PASS in-batch retries do not duplicate failure notification: notifications for retried episode: 1
PASS rejected outbox write does not abort episode completion: ready: 1, status: ready
PASS rejected outbox write failure is logged: logged failure via console.error
PASS secret scanner anti-test detects injected token, authorization header, and admin secret: detected leaks: 5
PASS poisoning anti-test permits playerUrl in notification but rejects capability URL in server logs and run history: permitted: clean=true; poisonedLog leaks: 1; poisonedHistory leaks: 1
PASS no credentials, tokens, or admin secrets are echoed into server logs, run history, or notifications beyond subscriber player URL: 0 leaks detected
PASS ack notification c946ba30-00f8-4d19-9643-e6024d22a057: status: 200
PASS ack notification 8f0a3ebf-df47-4136-b2d4-54a7cc2178dc: status: 200
PASS outbox is now empty after acking: 0 entries
```
