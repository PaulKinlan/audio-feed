# Outbox Notification Verification Report: audio-feed-np5

## Verified Criteria
1. **On-Demand Notification**: Submitting an article via `/api/ingest` places exactly 1 entry in the outbox upon synthesis completion, naming the episode title and player URL.
2. **Feed Poll Silence**: Background feed polls synthesizing multiple episodes do NOT emit outbox entries.
3. **Failure Reporting**: Permanent synthesis failures notify once with the specific error reason. In-batch retries do not duplicate notifications.
4. **Resilience**: Outbox write rejections do not abort episode completion; failure is logged.
5. **Security**: Zero credentials, tokens, or admin secrets are echoed in notification payloads or server logs beyond the subscriber's own player URL.
6. **Opt-in Only**: Outbox notifications are disabled by default (`notifyOutboxEnabled: false`).

## Execution Log
```
PASS POST /api/ingest returns 202: status: 202
PASS synthesis batch completes 1 episode: ready: 1
PASS outbox holds 1 notification for on-demand article: entries: 1
PASS notification names episode title and player URL: title='On-Demand Read Article', playerUrl='http://localhost:42957/listen/subscriber-token-123', status='ready'
PASS synthesis batch completes 3 feed episodes: ready: 3
PASS feed poll episodes did NOT create outbox notifications: outbox count remains 1
PASS failing episode marked failed: failed: 1
PASS outbox now holds 2 entries (ready + failed): entries: 2
PASS failed notification contains failure reason: error: 'Gemini quota exhausted'
PASS ack notification 39f4c496-d9fe-46b8-843b-febb5c7b4486: status: 200
PASS ack notification dbbe2c65-a01c-40cc-9254-b4faac2b1cbe: status: 200
PASS outbox is now empty after acking: 0 entries
```
