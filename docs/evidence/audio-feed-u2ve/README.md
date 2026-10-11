# audio-feed-u2ve — the rate limit is keyed on an address the caller can choose

`before.json` and `repro.json` are the same probe (`scripts/repro_u2ve_rate_limit_ff.ts`) run
against the unfixed and fixed trees, with the same limiter configuration **actually in effect** (5
requests per 60s — the first run of this probe passed an option name the compose layer ignored, so
the baseline was re-measured with the seam wired correctly rather than left claiming a bound it had
not set).

The probe is a deployment with `TRUST_PROXY_HEADERS=1` and one trusted hop in front. It posts to the
public `POST /api/request-access` route with `x-forwarded-for: <forged>, <real>`, which is the real
shape of that header: every hop **appends** the address it saw, so anything a client supplies sits
to the LEFT of the address the trusted hop added.

| bound: 5 requests / 60s, 20 attempts     | before               | after            |
| ---------------------------------------- | -------------------- | ---------------- |
| rotating forged prefix → `429`s          | **0**                | **15**           |
| rotating forged prefix → allowed through | **20 (all of them)** | **5**            |
| one honest client → first `429`          | attempt 6            | attempt 6        |
| two distinct trusted-hop values          | separate buckets     | separate buckets |

Before: the bound did not exist for a caller who rotated the header — 20 requests, no `429`, because
the key was the first (client-supplied) entry and each request therefore landed in a fresh bucket.
After: rotating the prefix buys nothing; exactly the bound is allowed, then `429`, which is
precisely what an honest client gets. The last two rows are the control: the fix must not stop the
bypass by collapsing every caller into one bucket, so distinct real clients are shown to still be
limited to their own allowance.

The script exits non-zero when the bound was evaded, so this is a regression gate as well as a
measurement:

```sh
timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_u2ve_rate_limit_ff.ts
```

`tests/rate_limit_key_test.ts` pins the same properties at the unit level and through the real
route, including the second path with the same shape (`cf-connecting-ip` was consulted before the
forwarded chain, so a forged single-value header won even when the hop had appended the real
address), the `remoteAddr` fallbacks, and that a value too long to be an address cannot become an
unbounded store key.

## audio-feed-5vvw — the fallback header had the same two failures

An independent review of the first fix (rev-u2ve) reproduced the rotated-header bypass on
`cf-connecting-ip`: with no forwarded chain, ten rotated 200-byte values produced ten `200`s and
zero `429`s, and those values became store keys verbatim. Bounding only `x-forwarded-for` had left
the path beside it able to take any string a caller sent — a fresh bucket per request _and_ an
unbounded key.

The probe now covers it, so both measurements are in the same file:

| 20 attempts, bound 5/60s, no forwarded chain               | before 5vvw  | after     |
| ---------------------------------------------------------- | ------------ | --------- |
| rotating forged `cf-connecting-ip` → `429`s                | **0**        | **15**    |
| rotating forged `cf-connecting-ip` → allowed through       | **20 (all)** | **5**     |
| a well-formed `cf-connecting-ip` → first `429`             | attempt 6    | attempt 6 |
| rotating forged `x-forwarded-for` prefix → allowed through | 5            | 5         |

Both headers are now held to one rule — the value must look like an address (or it falls through to
the platform's socket address) and cannot be arbitrarily long. That also makes the rule statable in
one sentence instead of "the chain is bounded, the fallback is not". The residual is unchanged and
is the operator's assertion, not a gap in the check: behind a proxy that manages _neither_ header, a
caller can still rotate among well-formed addresses, because then no forwarded value is trustworthy
at all — which is why the documented topology is a proxy that appends or overwrites them.

`tests/rate_limit_key_test.ts` gained the reviewer's reproducer at the bucket level, the shape rules
(accepting, among the forms proxies really emit, `[2001:db8::1]:443` and `::ffff:192.0.2.1` — the
latter caught by the test on its first run, which is why the check now handles a dotted-quad tail),
and a check that near-misses like `999.0.113.7`, `unknown` and a double `::` fall through rather
than becoming keys.

## audio-feed-hzg1 — the shape check constrained an alphabet, not a structure

A second review of the shape rule found the obvious gap in it: `isIpv6` counted hex groups and
ignored empty ones, so `0:` — one hex group and a trailing colon — was accepted as an address. A
caller could rotate `0:` through `13:` in the fallback header and get a fresh bucket each time,
which is the same bypass this rule exists to close, reached through the rule itself.

Reproduced with the reviewer's reproducer as its own section of the probe, measured against the
exact tip they reviewed (`c78ce8f`) and then against the fix:

| malformed `cf-connecting-ip` values `0:` .. `13:`, bound 5/60s, 20 attempts | 429s   | allowed      |
| --------------------------------------------------------------------------- | ------ | ------------ |
| before (`hzg1-before.json`)                                                 | **0**  | **20 (all)** |
| after (`repro.json`)                                                        | **15** | **5**        |

The rule now requires the _structure_ of an address: without `::` an IPv6 address has exactly eight
groups, and with it at most seven may be written (since `::` stands for at least one elided group);
`:::` and a duplicated `::` are rejected, as is a single colon at an edge that is not part of `::`.
`tests/rate_limit_key_test.ts` asserts the forms individually — `0:`, `13:`, `abc:`, `:::`,
`2001:db8:`, `:1:2:3:4:5:6:7`, `1:2:3`, nine groups, and a five-digit group — alongside the real
forms, which must keep working.

Worth stating plainly, because it is the second hole in the same guard: the first version bounded
the _length_ of a forwarded value, the second bounded its _alphabet_, and this finding is what a
third round of "does this actually look like an address" had to add. Counting characters and
characters that happen to be legal is not the same as requiring a shape.
