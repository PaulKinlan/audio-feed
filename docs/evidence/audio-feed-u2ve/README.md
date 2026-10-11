# audio-feed-u2ve — the rate limit is keyed on an address the caller can choose

`before.json` and `repro.json` are the same probe (`scripts/repro_u2ve_rate_limit_ff.ts`) run against
the unfixed and fixed trees, with the same limiter configuration **actually in effect** (5 requests
per 60s — the first run of this probe passed an option name the compose layer ignored, so the
baseline was re-measured with the seam wired correctly rather than left claiming a bound it had not
set).

The probe is a deployment with `TRUST_PROXY_HEADERS=1` and one trusted hop in front. It posts to the
public `POST /api/request-access` route with `x-forwarded-for: <forged>, <real>`, which is the real
shape of that header: every hop **appends** the address it saw, so anything a client supplies sits to
the LEFT of the address the trusted hop added.

| bound: 5 requests / 60s, 20 attempts | before | after |
| --- | --- | --- |
| rotating forged prefix → `429`s | **0** | **15** |
| rotating forged prefix → allowed through | **20 (all of them)** | **5** |
| one honest client → first `429` | attempt 6 | attempt 6 |
| two distinct trusted-hop values | separate buckets | separate buckets |

Before: the bound did not exist for a caller who rotated the header — 20 requests, no `429`, because
the key was the first (client-supplied) entry and each request therefore landed in a fresh bucket.
After: rotating the prefix buys nothing; exactly the bound is allowed, then `429`, which is precisely
what an honest client gets. The last two rows are the control: the fix must not stop the bypass by
collapsing every caller into one bucket, so distinct real clients are shown to still be limited to
their own allowance.

The script exits non-zero when the bound was evaded, so this is a regression gate as well as a
measurement:

```sh
timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_u2ve_rate_limit_ff.ts
```

`tests/rate_limit_key_test.ts` pins the same properties at the unit level and through the real route,
including the second path with the same shape (`cf-connecting-ip` was consulted before the forwarded
chain, so a forged single-value header won even when the hop had appended the real address), the
`remoteAddr` fallbacks, and that a value too long to be an address cannot become an unbounded store
key.
