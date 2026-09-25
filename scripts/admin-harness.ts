/**
 * Local harness that serves the REAL admin dashboard with seeded run history.
 *
 * Exists so the dashboard can be checked in an actual browser (audio-feed-ct1).
 * It records three hours of runs at production cadence, ending now: the feed
 * poll every 15 minutes and the synthesis cron every 2, as src/cron.ts
 * schedules them. A route returning 200 says nothing about what the stat cards
 * and the runs table then claim.
 *
 * Deliberately NOT part of the gate: it serves an admin page on localhost with a
 * fixed token, which is fine for a driven browser session and wrong for
 * anything else.
 *
 *   deno run --allow-all --unstable-kv scripts/admin-harness.ts [port] [stopped]
 *
 * `stopped` stops the poll cron one hour in while synthesis keeps ticking: the
 * outage the "Last feed poll" card exists for.
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";

const numeric = (value: string | undefined) =>
  value && /^\d+$/.test(value) ? Number(value) : undefined;
const port = numeric(Deno.args.find((a) => /^\d+$/.test(a))) ?? 8132;
const stopped = Deno.args.includes("stopped");
const base = `http://localhost:${port}`;

const stores = memoryStores();
const config = { port, publicBaseUrl: base, adminToken: "harness-admin" };
const ctx = { config, stores };

const MINUTES = 180;
const start = Date.now() - MINUTES * 60_000;
const at = (minute: number, ms = 0) => new Date(start + minute * 60_000 + ms).toISOString();

for (let m = 0; m < MINUTES; m++) {
  if (m % 15 === 0 && (!stopped || m < 60)) {
    await stores.metadata.recordRun({
      id: `p${m}`,
      kind: "feed-poll",
      trigger: "cron",
      startedAt: at(m),
      durationMs: 1000 + 2 * m,
      polled: 3,
      queued: 1,
      failed: 0,
    });
  }
  if (m % 2 === 0) {
    // An idle tick, which is most of them, marked idle as src/cron.ts marks it
    // (audio-feed-0ob). +250 ms so it never ties with a poll.
    await stores.metadata.recordRun({
      id: `s${m}`,
      kind: "synthesis",
      trigger: "cron",
      startedAt: at(m, 250),
      durationMs: 30,
      ready: 0,
      failed: 0,
      deferred: 0,
      idle: true,
    });
  }
}

const { fetch } = createApp(ctx, createHandlers(ctx));
Deno.serve({ port }, fetch);
const scenario = stopped
  ? "poll cron stopped 1 h in, synthesis still ticking"
  : "both crons healthy";
console.log(`admin harness: ${base}/admin  token: harness-admin  (${scenario})`);
