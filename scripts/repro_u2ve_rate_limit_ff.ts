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
import { runProof, writeEvidenceReadme } from "./proof-helper.ts";

const OUT_DIR = "docs/evidence/audio-feed-u2ve";
const OUT = new URL(`../${OUT_DIR}/repro.json`, import.meta.url);

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

await runProof("repro_u2ve_rate_limit_ff", async (checker) => {
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

  // -- 4. the FALLBACK header, which the first fix left unbounded (audio-feed-5vvw) ---------
  //
  // `cf-connecting-ip` is consulted when there is no usable forwarded chain. It is a single-value
  // header, so a proxy that does not manage it passes whatever the caller sent. Rotating a long value
  // there was both a fresh bucket per request and an unbounded number of store rows — the same two
  // failures the forwarded chain had, on the path beside it.

  // The reviewer's second repro (audio-feed-hzg1): values that are NOT addresses but passed the first
  // version of the shape check, because a single hex group with a trailing colon was read as IPv6.
  // Rotating them bought a bucket each — the same bypass the shape check exists to stop, which is why
  // the check now constrains structure and not just the alphabet.
  const malformed = app();
  const malformedStatuses: number[] = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    const response = await malformed.fetch(
      new Request("http://localhost/api/request-access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `${i.toString(16)}:`,
        },
        body: JSON.stringify({ email: `malformed-${i}@example.com`, reason: "probe" }),
      }),
    );
    malformedStatuses.push(response.status);
  }

  // The reviewer's third repro (audio-feed-jqmd): a dotted-quad tail represents TWO IPv6 groups, so
  // seven written groups plus a quad is nine, not eight. The structure check counted the quad as one
  // group and let these through, so a caller could rotate them for a bucket each.
  const dottedTail = app();
  const dottedTailStatuses: number[] = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    const response = await dottedTail.fetch(
      new Request("http://localhost/api/request-access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `1:2:3:4:5:6:${i.toString(16)}::192.0.2.1`,
        },
        body: JSON.stringify({ email: `dotted-${i}@example.com`, reason: "probe" }),
      }),
    );
    dottedTailStatuses.push(response.status);
  }

  const cfOnly = app();
  const cfStatuses: number[] = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    const response = await cfOnly.fetch(
      new Request("http://localhost/api/request-access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `forged-${String(i).padStart(3, "0")}-${"x".repeat(200)}`,
        },
        body: JSON.stringify({ email: `cf-probe-${i}@example.com`, reason: "probe" }),
      }),
    );
    cfStatuses.push(response.status);
  }

  // And a well-formed cf-connecting-ip is still honoured: a proxy that manages the header works.
  const cfHonest = app();
  const cfHonestFirst: number[] = [];
  for (let i = 0; i < MAX_REQUESTS + 1; i++) {
    const response = await cfHonest.fetch(
      new Request("http://localhost/api/request-access", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify({ email: `cf-honest-${i}@example.com`, reason: "probe" }),
      }),
    );
    cfHonestFirst.push(response.status);
  }

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
    rotatingForgedCfOnly: {
      tooManyRequests: count(cfStatuses, 429),
      allowedThrough: cfStatuses.filter((s) => s !== 429).length,
      evaded: count(cfStatuses, 429) === 0,
    },
    rotatingMalformedCfOnly: {
      tooManyRequests: count(malformedStatuses, 429),
      allowedThrough: malformedStatuses.filter((s) => s !== 429).length,
      evaded: count(malformedStatuses, 429) === 0,
    },
    rotatingDottedTailCfOnly: {
      tooManyRequests: count(dottedTailStatuses, 429),
      allowedThrough: dottedTailStatuses.filter((s) => s !== 429).length,
      evaded: count(dottedTailStatuses, 429) === 0,
    },
    wellFormedCfClient: {
      tooManyRequests: count(cfHonestFirst, 429),
      first429AtAttempt: cfHonestFirst.indexOf(429) + 1,
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

  console.log(
    `rotating forged cf-connecting-ip (no chain): ${report.rotatingForgedCfOnly.tooManyRequests} x 429, ` +
      `${report.rotatingForgedCfOnly.allowedThrough} allowed through; ` +
      `a well-formed one is still honoured (first 429 at attempt ${report.wellFormedCfClient.first429AtAttempt})`,
  );
  console.log(
    `rotating malformed cf-connecting-ip values (0: .. 13:): ${report.rotatingMalformedCfOnly.tooManyRequests} x 429, ${report.rotatingMalformedCfOnly.allowedThrough} allowed through`,
  );
  console.log(
    `rotating dotted-tail cf-connecting-ip values: ${report.rotatingDottedTailCfOnly.tooManyRequests} x 429, ${report.rotatingDottedTailCfOnly.allowedThrough} allowed through`,
  );

  checker.check(
    "rate limit bound holds against rotating forged x-forwarded-for prefix",
    !report.rotatingForgedPrefix.evaded &&
      report.rotatingForgedPrefix.tooManyRequests === 15 &&
      report.rotatingForgedPrefix.allowedThrough === 5,
    `${report.rotatingForgedPrefix.tooManyRequests} x 429, ${report.rotatingForgedPrefix.allowedThrough} allowed`,
  );
  checker.check(
    "honest client rate limited at configured threshold",
    report.singleHonestClient.first429AtAttempt === 6 &&
      report.singleHonestClient.tooManyRequests === 15,
    `first 429 at attempt ${report.singleHonestClient.first429AtAttempt}`,
  );
  checker.check(
    "two distinct trusted clients receive independent rate limit buckets",
    report.twoDistinctTrustedValues.first.every((c) => c.status === 200) &&
      report.twoDistinctTrustedValues.secondClientStatus === 200,
    `client 1: 5x 200, client 2: status ${report.twoDistinctTrustedValues.secondClientStatus}`,
  );
  checker.check(
    "rate limit bound holds against rotating forged cf-connecting-ip",
    !report.rotatingForgedCfOnly.evaded &&
      report.rotatingForgedCfOnly.tooManyRequests === 15 &&
      report.rotatingForgedCfOnly.allowedThrough === 5,
    `${report.rotatingForgedCfOnly.tooManyRequests} x 429`,
  );
  checker.check(
    "well-formed cf-connecting-ip client rate limited at configured threshold",
    report.wellFormedCfClient.first429AtAttempt === 6 &&
      report.wellFormedCfClient.tooManyRequests === 1,
    `first 429 at attempt ${report.wellFormedCfClient.first429AtAttempt}`,
  );
  checker.check(
    "rate limit bound holds against rotating malformed cf-connecting-ip",
    !report.rotatingMalformedCfOnly.evaded &&
      report.rotatingMalformedCfOnly.tooManyRequests === 15 &&
      report.rotatingMalformedCfOnly.allowedThrough === 5,
    `${report.rotatingMalformedCfOnly.tooManyRequests} x 429`,
  );
  checker.check(
    "rate limit bound holds against rotating dotted-tail cf-connecting-ip",
    !report.rotatingDottedTailCfOnly.evaded &&
      report.rotatingDottedTailCfOnly.tooManyRequests === 15 &&
      report.rotatingDottedTailCfOnly.allowedThrough === 5,
    `${report.rotatingDottedTailCfOnly.tooManyRequests} x 429`,
  );

  await writeEvidenceReadme({
    dir: OUT_DIR,
    title: "audio-feed-u2ve — the rate limit is keyed on an address the caller can choose",
    script: "scripts/repro_u2ve_rate_limit_ff.ts",
    asserts: [
      "rate limit bound holds against rotating forged x-forwarded-for prefix",
      "honest client rate limited at configured threshold",
      "two distinct trusted clients receive independent rate limit buckets",
      "rate limit bound holds against rotating forged cf-connecting-ip",
      "well-formed cf-connecting-ip client rate limited at configured threshold",
      "rate limit bound holds against rotating malformed cf-connecting-ip",
      "rate limit bound holds against rotating dotted-tail cf-connecting-ip",
    ],
    sections: [
      {
        heading: "Overview",
        body:
          `\`before.json\` and \`repro.json\` are the same probe (\`scripts/repro_u2ve_rate_limit_ff.ts\`) run
against the unfixed and fixed trees, with the same limiter configuration **actually in effect** (5
requests per 60s — the first run of this probe passed an option name the compose layer ignored, so
the baseline was re-measured with the seam wired correctly rather than left claiming a bound it had
not set).

The probe is a deployment with \`TRUST_PROXY_HEADERS=1\` and one trusted hop in front. It posts to the
public \`POST /api/request-access\` route with \`x-forwarded-for: <forged>, <real>\`, which is the real
shape of that header: every hop **appends** the address it saw, so anything a client supplies sits
to the LEFT of the address the trusted hop added.

| bound: 5 requests / 60s, 20 attempts     | before               | after            |
| ---------------------------------------- | -------------------- | ---------------- |
| rotating forged prefix → \`429\`s          | **0**                | **15**           |
| rotating forged prefix → allowed through | **20 (all of them)** | **5**            |
| one honest client → first \`429\`          | attempt 6            | attempt 6        |
| two distinct trusted-hop values          | separate buckets     | separate buckets |

Before: the bound did not exist for a caller who rotated the header — 20 requests, no \`429\`, because
the key was the first (client-supplied) entry and each request therefore landed in a fresh bucket.
After: rotating the prefix buys nothing; exactly the bound is allowed, then \`429\`, which is
precisely what an honest client gets. The last two rows are the control: the fix must not stop the
bypass by collapsing every caller into one bucket, so distinct real clients are shown to still be
limited to their own allowance.

The script exits non-zero when the bound was evaded, so this is a regression gate as well as a
measurement:

\`\`\`sh
timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_u2ve_rate_limit_ff.ts
\`\`\`

\`tests/rate_limit_key_test.ts\` pins the same properties at the unit level and through the real
route, including the second path with the same shape (\`cf-connecting-ip\` was consulted before the
forwarded chain, so a forged single-value header won even when the hop had appended the real
address), the \`remoteAddr\` fallbacks, and that a value too long to be an address cannot become an
unbounded store key.`,
      },
      {
        heading: "audio-feed-5vvw — the fallback header had the same two failures",
        body:
          `An independent review of the first fix (rev-u2ve) reproduced the rotated-header bypass on
\`cf-connecting-ip\`: with no forwarded chain, ten rotated 200-byte values produced ten \`200\`s and
zero \`429\`s, and those values became store keys verbatim. Bounding only \`x-forwarded-for\` had left
the path beside it able to take any string a caller sent — a fresh bucket per request _and_ an
unbounded key.

The probe now covers it, so both measurements are in the same file:

| 20 attempts, bound 5/60s, no forwarded chain               | before 5vvw  | after     |
| ---------------------------------------------------------- | ------------ | --------- |
| rotating forged \`cf-connecting-ip\` → \`429\`s                | **0**        | **15**    |
| rotating forged \`cf-connecting-ip\` → allowed through       | **20 (all)** | **5**     |
| a well-formed \`cf-connecting-ip\` → first \`429\`             | attempt 6    | attempt 6 |
| rotating forged \`x-forwarded-for\` prefix → allowed through | 5            | 5         |

Both headers are now held to one rule — the value must look like an address (or it falls through to
the platform's socket address) and cannot be arbitrarily long. That also makes the rule statable in
one sentence instead of "the chain is bounded, the fallback is not". The residual is unchanged and
is the operator's assertion, not a gap in the check: behind a proxy that manages _neither_ header, a
caller can still rotate among well-formed addresses, because then no forwarded value is trustworthy
at all — which is why the documented topology is a proxy that appends or overwrites them.

\`tests/rate_limit_key_test.ts\` gained the reviewer's reproducer at the bucket level, the shape rules
(accepting, among the forms proxies really emit, \`[2001:db8::1]:443\` and \`::ffff:192.0.2.1\` — the
latter caught by the test on its first run, which is why the check now handles a dotted-quad tail),
and a check that near-misses like \`999.0.113.7\`, \`unknown\` and a double \`::\` fall through rather
than becoming keys.`,
      },
      {
        heading: "audio-feed-hzg1 — the shape check constrained an alphabet, not a structure",
        body:
          `A second review of the shape rule found the obvious gap in it: \`isIpv6\` counted hex groups and
ignored empty ones, so \`0:\` — one hex group and a trailing colon — was accepted as an address. A
caller could rotate \`0:\` through \`13:\` in the fallback header and get a fresh bucket each time,
which is the same bypass this rule exists to close, reached through the rule itself.

Reproduced with the reviewer's reproducer as its own section of the probe, measured against the
exact tip they reviewed (the unfixed review tip) and then against the fix:

| malformed \`cf-connecting-ip\` values \`0:\` .. \`13:\`, bound 5/60s, 20 attempts | 429s   | allowed      |
| --------------------------------------------------------------------------- | ------ | ------------ |
| before (\`hzg1-before.json\`)                                                 | **0**  | **20 (all)** |
| after (\`repro.json\`)                                                        | **15** | **5**        |

The rule now requires the _structure_ of an address: without \`::\` an IPv6 address has exactly eight
groups, and with it at most seven may be written (since \`::\` stands for at least one elided group);
\`:::\` and a duplicated \`::\` are rejected, as is a single colon at an edge that is not part of \`::\`.
\`tests/rate_limit_key_test.ts\` asserts the forms individually — \`0:\`, \`13:\`, \`abc:\`, \`:::\`,
\`2001:db8:\`, \`:1:2:3:4:5:6:7\`, \`1:2:3\`, nine groups, and a five-digit group — alongside the real
forms, which must keep working.

Worth stating plainly, because it is the second hole in the same guard: the first version bounded
the _length_ of a forwarded value, the second bounded its _alphabet_, and this finding is what a
third round of "does this actually look like an address" had to add. Counting characters and
characters that happen to be legal is not the same as requiring a shape.`,
      },
      {
        heading: "audio-feed-jqmd — the class, not the example: the hand-rolled validator is gone",
        body:
          `The fourth finding in this guard was the one that named the pattern. A dotted-quad tail represents
**two** IPv6 groups, so \`1:2:3:4:5:6:7::192.0.2.1\` writes seven groups plus a quad — nine, not eight
— and my structure check counted the quad as one. Twenty rotating dotted-tail values bought twenty
buckets, exactly as \`0:\` had before them.

Three hand-rolled versions had now each been wrong in a different way: the first bounded the length
of a forwarded value, the second its alphabet, the third its structure — and each looked sufficient
from the inside. The fix is to stop writing the validator. \`isIP\` from \`node:net\` is the platform's,
it returns 4, 6 or 0, and it was checked against every form that has ever mattered here before it
was adopted:

| value                                                                            | isIP      |                                         |
| -------------------------------------------------------------------------------- | --------- | --------------------------------------- |
| \`203.0.113.7\`, \`2001:db8::1\`, \`::ffff:192.0.2.1\`                                 | 4 / 6 / 6 | accepted                                |
| \`1:2:3:4:5:6:7::192.0.2.1\`, \`0:\`, \`abc:\`, \`1:2:3\`, \`999.0.113.7\`, \`:::\`, \`zz::1\` | 0         | fall back to the socket                 |
| \`203.0.113.7:8443\`, \`[2001:db8::1]:443\`                                          | **0**     | ports are not addresses — handled below |

That last row is why the change is not a one-liner. \`isIP\` is strict, and a proxy that appends an
address with a port appends both, so the port is stripped first — but only in the two forms where it
is unambiguous (\`v4:port\` and \`[v6]:port\`). A **bare** IPv6 ending in \`:digits\` is readable two
ways, nine groups or an address with a port, and reading it as the latter let \`1:2:3:4:5:6:7:8:9\`
through as \`1:2:3:4:5:6:7:8\` with port 9 — a fifth rotated key, caught by the corpus written for
this finding before it reached review. Rejecting host-with-port outright was the other option and it
is the wrong one: it collapses distinct clients onto one socket-address bucket, which is the failure
audio-feed-hn4 was a P2 about.

| 20 rotated values, bound 5/60s, no forwarded chain | before                   | after                    |
| -------------------------------------------------- | ------------------------ | ------------------------ |
| dotted-quad tail (\`1:2:3:4:5:6:X::192.0.2.1\`)      | **0 x 429 / 20 allowed** | **15 x 429 / 5 allowed** |
| single hex group + colon (\`0:\` .. \`13:\`)           | 15 x 429 / 5 allowed     | 15 x 429 / 5 allowed     |
| over-long forged value                             | 15 x 429 / 5 allowed     | 15 x 429 / 5 allowed     |
| a well-formed \`cf-connecting-ip\`                   | locks out at attempt 6   | locks out at attempt 6   |

\`tests/rate_limit_key_test.ts\` now carries the corpus this needed from the start: one table of every
family that has ever rotated a key (\`0:\`, \`abc:\`, over-long, nine and ten groups, both dotted-tail
forms, a bare-IPv6-last-group-as-port, \`999.0.113.7:80\`), each with the finding that found it, and a
bucket-level test that rotates all four families through the real limiter and asserts the bound
holds for each while a well-formed address still locks out at 6.

**The lesson, stated for the next person:** three rounds of "does this look like an address?"
produced three different holes, and the fourth round is only safe because it stopped asking me to be
the authority on IPv6. When a guard has to be right about a standard format, the standard format
belongs in the platform.`,
      },
    ],
  });
});
