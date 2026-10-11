/**
 * Repro and regression harness for audio-feed-u2ve — the client identity the rate limiter keys on is
 * taken from a header the CLIENT controls, so a caller can rotate it and never reach the bound.
 *
 * Run: timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_u2ve_rate_limit_ff.ts
 *
 * WHAT IT MEASURES
 * A deployment with TRUST_PROXY_HEADERS=1 — one trusted hop in front, which is the only setting in
 * which any forwarded header is read. The probe sends `x-forwarded-for: <forged>, <real>`, which is
 * the real shape of the header: every hop APPENDS the address it saw, so the value a client supplies
 * lands to the LEFT of the one the trusted hop added. `POST /api/request-access` is the public route
 * (no credentials needed), and its limiter is the per-client bound that exists to stop exactly this.
 *
 * Before the fix the key is the FIRST entry, i.e. the forged one: every request lands in a fresh
 * bucket, the bound never applies, and the run reports zero 429s however many requests are sent.
 * After it the key is the LAST entry — the one the trusted hop appended — so the whole run is one
 * bucket and the bound arrives on schedule.
 *
 * The script exits non-zero when the bound was evaded, so it is a regression gate as well as a
 * measurement, and it writes the numbers to docs/evidence/audio-feed-u2ve/.
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const OUT = new URL("../docs/evidence/audio-feed-u2ve/repro.json", import.meta.url);

/** What the limiter is configured to allow, and therefore how many requests to send. */
const MAX_REQUESTS = 5;
const ATTEMPTS = MAX_REQUESTS * 4;
/** The address the trusted hop saw. A caller cannot choose this: the hop appends it. */
const REAL_CLIENT = "203.0.113.7";

function app(configOverrides: Partial<AppConfig> = {}) {
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: "http://localhost",
    trustProxyHeaders: true,
    ...configOverrides,
  };
  const ctx = { config, stores };
  const { fetch } = createApp(
    ctx,
    createHandlers(ctx, {
      requestAccess: { rateLimitConfig: { maxRequests: MAX_REQUESTS, windowMs: 60_000 } },
    }),
  );
  return { fetch, stores };
}

/** One attempt, with a forged prefix and the trusted hop's own appended address. */
async function attempt(
  fetch: (req: Request) => Promise<Response>,
  forged: string,
  forwarded: string,
  i: number,
): Promise<number> {
  const response = await fetch(
    new Request("http://localhost/api/request-access", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwarded,
      },
      body: JSON.stringify({ email: `probe-${forged}-${i}@example.com`, reason: "probe" }),
    }),
  );
  return response.status;
}

// -- 1. rotating the header ------------------------------------------------------------------

const rotating = app();
const rotatingStatuses: number[] = [];
for (let i = 0; i < ATTEMPTS; i++) {
  // A different forged prefix every time; the trusted hop's appended value never changes.
  rotatingStatuses.push(
    await attempt(rotating.fetch, `10.0.0.${i}`, `10.0.0.${i}, ${REAL_CLIENT}`, i),
  );
}

// -- 2. a single honest client, for contrast --------------------------------------------------

const honest = app();
const honestStatuses: number[] = [];
for (let i = 0; i < ATTEMPTS; i++) {
  honestStatuses.push(await attempt(honest.fetch, REAL_CLIENT, REAL_CLIENT, i));
}

// -- 3. two DIFFERENT trusted-hop values must still be two buckets ---------------------------

const twoClients = app();
const twoClientStatuses: Array<{ client: string; status: number }> = [];
for (let i = 0; i < MAX_REQUESTS; i++) {
  twoClientStatuses.push({
    client: "198.51.100.1",
    status: await attempt(twoClients.fetch, "198.51.100.1", `198.51.100.1`, i),
  });
}
twoClientStatuses.push({
  client: "198.51.100.2",
  status: await attempt(twoClients.fetch, "198.51.100.2", `198.51.100.2`, 0),
});

const count = (statuses: number[], code: number) => statuses.filter((s) => s === code).length;
const report = {
  bead: "audio-feed-u2ve",
  trustProxyHeaders: true,
  bound: { maxRequests: MAX_REQUESTS, windowMs: 60_000 },
  attempts: ATTEMPTS,
  rotatingForgedPrefix: {
    statuses: rotatingStatuses,
    tooManyRequests: count(rotatingStatuses, 429),
    allowedThrough: rotatingStatuses.filter((s) => s !== 429).length,
    evaded: count(rotatingStatuses, 429) === 0,
  },
  singleHonestClient: {
    tooManyRequests: count(honestStatuses, 429),
    allowedThrough: honestStatuses.filter((s) => s !== 429).length,
    first429AtAttempt: honestStatuses.indexOf(429) + 1,
  },
  twoDistinctTrustedValues: {
    first: twoClientStatuses.slice(0, MAX_REQUESTS),
    secondClientStatus: twoClientStatuses[MAX_REQUESTS]!.status,
  },
};

await Deno.mkdir(new URL("./", OUT), { recursive: true });
await Deno.writeTextFile(OUT, JSON.stringify(report, null, 2) + "\n");

console.log(`bound: ${MAX_REQUESTS} requests / 60s, ${ATTEMPTS} attempts each`);
console.log(
  `rotating forged x-forwarded-for prefix: ${report.rotatingForgedPrefix.tooManyRequests} x 429, ` +
    `${report.rotatingForgedPrefix.allowedThrough} allowed through`,
);
console.log(
  `one honest client: first 429 at attempt ${report.singleHonestClient.first429AtAttempt}, ` +
    `${report.singleHonestClient.tooManyRequests} x 429`,
);
console.log(
  `two distinct trusted-hop values: ${JSON.stringify(report.twoDistinctTrustedValues)}`,
);

if (report.rotatingForgedPrefix.evaded) {
  console.error(
    `FAIL: a client that rotates a forged prefix was never limited (${ATTEMPTS} attempts, no 429)`,
  );
  Deno.exit(1);
}
console.log("OK: the bound held against a forged prefix");
