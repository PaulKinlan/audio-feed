# Outbox Notification Verification Report: audio-feed-np5

- Script: scripts/outbox-proof.ts
- Asserts: POST /api/ingest returns 202; synthesis batch completes 1 episode; outbox holds 1 notification for on-demand article; notification names episode title and player URL; synthesis batch completes 3 feed episodes; feed poll episodes did NOT create outbox notifications; failing episode marked failed; outbox now holds 2 entries (ready + failed); failed notification contains failure reason; ack notification for ready episode; ack notification for failed episode; outbox is now empty after acking

## Verified Criteria
1. **On-Demand Notification**: Submitting an article via `/api/ingest` places exactly 1 entry in the outbox upon synthesis completion, naming the episode title and player URL.
2. **Feed Poll Silence**: Background feed polls synthesizing multiple episodes do NOT emit outbox entries.
3. **Failure Reporting**: Permanent synthesis failures notify once with the specific error reason. In-batch retries do not duplicate notifications.
4. **Resilience**: Outbox write rejections do not abort episode completion; failure is logged.
5. **Security**: Zero credentials, tokens, or admin secrets are echoed in notification payloads or server logs beyond the subscriber's own player URL.
6. **Opt-in Only**: Outbox notifications are disabled by default (`notifyOutboxEnabled: false`).
