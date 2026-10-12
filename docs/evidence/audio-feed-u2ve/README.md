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

## audio-feed-jqmd — the class, not the example: the hand-rolled validator is gone

The fourth finding in this guard was the one that named the pattern. A dotted-quad tail represents
**two** IPv6 groups, so `1:2:3:4:5:6:7::192.0.2.1` writes seven groups plus a quad — nine, not eight
— and my structure check counted the quad as one. Twenty rotating dotted-tail values bought twenty
buckets, exactly as `0:` had before them.

Three hand-rolled versions had now each been wrong in a different way: the first bounded the length
of a forwarded value, the second its alphabet, the third its structure — and each looked sufficient
from the inside. The fix is to stop writing the validator. `isIP` from `node:net` is the platform's,
it returns 4, 6 or 0, and it was checked against every form that has ever mattered here before it
was adopted:

| value                                                                            | isIP      |                                         |
| -------------------------------------------------------------------------------- | --------- | --------------------------------------- |
| `203.0.113.7`, `2001:db8::1`, `::ffff:192.0.2.1`                                 | 4 / 6 / 6 | accepted                                |
| `1:2:3:4:5:6:7::192.0.2.1`, `0:`, `abc:`, `1:2:3`, `999.0.113.7`, `:::`, `zz::1` | 0         | fall back to the socket                 |
| `203.0.113.7:8443`, `[2001:db8::1]:443`                                          | **0**     | ports are not addresses — handled below |

That last row is why the change is not a one-liner. `isIP` is strict, and a proxy that appends an
address with a port appends both, so the port is stripped first — but only in the two forms where it
is unambiguous (`v4:port` and `[v6]:port`). A **bare** IPv6 ending in `:digits` is readable two
ways, nine groups or an address with a port, and reading it as the latter let `1:2:3:4:5:6:7:8:9`
through as `1:2:3:4:5:6:7:8` with port 9 — a fifth rotated key, caught by the corpus written for
this finding before it reached review. Rejecting host-with-port outright was the other option and it
is the wrong one: it collapses distinct clients onto one socket-address bucket, which is the failure
audio-feed-hn4 was a P2 about.

| 20 rotated values, bound 5/60s, no forwarded chain | before                   | after                    |
| -------------------------------------------------- | ------------------------ | ------------------------ |
| dotted-quad tail (`1:2:3:4:5:6:X::192.0.2.1`)      | **0 x 429 / 20 allowed** | **15 x 429 / 5 allowed** |
| single hex group + colon (`0:` .. `13:`)           | 15 x 429 / 5 allowed     | 15 x 429 / 5 allowed     |
| over-long forged value                             | 15 x 429 / 5 allowed     | 15 x 429 / 5 allowed     |
| a well-formed `cf-connecting-ip`                   | locks out at attempt 6   | locks out at attempt 6   |

`tests/rate_limit_key_test.ts` now carries the corpus this needed from the start: one table of every
family that has ever rotated a key (`0:`, `abc:`, over-long, nine and ten groups, both dotted-tail
forms, a bare-IPv6-last-group-as-port, `999.0.113.7:80`), each with the finding that found it, and a
bucket-level test that rotates all four families through the real limiter and asserts the bound
holds for each while a well-formed address still locks out at 6.

**The lesson, stated for the next person:** three rounds of "does this look like an address?"
produced three different holes, and the fourth round is only safe because it stopped asking me to be
the authority on IPv6. When a guard has to be right about a standard format, the standard format
belongs in the platform.
