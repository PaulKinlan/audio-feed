/**
 * audio-feed-1kw — pin the `!isDeploy` gates on the in-memory background workers.
 *
 * Before this file those gates were unpinned: deleting both of them restores
 * audio-feed-562 (in-memory workers running on Deploy alongside Deno.cron, which
 * duplicates articles and double-spends synthesis) and the entire suite stayed
 * green. Two reasons, both now fixed in `bootstrap`:
 *
 *   1. the worker/feedPoller handles were local to bootstrap(), so a test had
 *      nothing to assert on — they are returned now;
 *   2. `isDeploy` was a module-level const evaluated at load, so a test could not
 *      exercise either branch — it is injectable now.
 *
 * All three cases are needed. Asserting only "null on Deploy" would be satisfied
 * by a build that never starts any worker, which is the false-green shape this
 * bead exists to prevent.
 */
import { assert, assertEquals } from "@std/assert";
import { openStores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";
import type { Synthesizer } from "../src/worker/synthesis.ts";

/** Never invoked: the store is empty, so no tick has anything to synthesise. If
 *  it is called the test is broken, so fail loudly rather than emit audio. */
const stubSynthesizer: Synthesizer = () =>
  Promise.reject(new Error("stub synthesizer must not be called in this test"));

async function boot(overrides: { isDeploy: boolean; synthesizer: Synthesizer | null }) {
  // Hermetic: an in-memory KV and port 0. A test must not open the default
  // persistent KV or bind a fixed port that another lane is already holding.
  const stores = await openStores({ kvPath: ":memory:" });
  const result = await bootstrap({ port: 0, stores, ...overrides });
  return result;
}

Deno.test("on Deploy, neither in-memory worker starts (audio-feed-1kw)", async () => {
  const result = await boot({ isDeploy: true, synthesizer: stubSynthesizer });
  try {
    assertEquals(result.isDeploy, true, "the injected decision must be what the result reports");
    // This is the assertion that catches the mutant. Both gates must hold even
    // with a synthesizer present, so a removed `!isDeploy` cannot hide behind it.
    assertEquals(result.worker, null, "synthesis worker must not run on Deploy");
    assertEquals(result.feedPoller, null, "feed poller must not run on Deploy");
  } finally {
    await result.shutdown();
  }
});

Deno.test("off Deploy, both in-memory workers do start (audio-feed-1kw)", async () => {
  const result = await boot({ isDeploy: false, synthesizer: stubSynthesizer });
  try {
    assert(result.worker !== null, "local runs need the synthesis worker");
    assert(result.feedPoller !== null, "local runs need the feed poller");
  } finally {
    await result.shutdown();
  }
});

Deno.test("the worker gate and the poller gate are independent (audio-feed-1kw)", async () => {
  // Without this, a single `!isDeploy && synthesizer` condition on both workers
  // would satisfy the first two cases. The poller has no key dependency: it must
  // still run locally when there is nothing to synthesise.
  const result = await boot({ isDeploy: false, synthesizer: null });
  try {
    assertEquals(result.worker, null, "no synthesizer means no synthesis worker");
    assert(result.feedPoller !== null, "the poller must not be gated on the synthesizer");
  } finally {
    await result.shutdown();
  }
});

Deno.test("a malformed PUBLIC_BASE_URL does not crash boot, and the gate fails closed (audio-feed-ft74)", async () => {
  // The regression this pins: the boot logging path called `new URL(config.publicBaseUrl)` unguarded, so
  // PUBLIC_BASE_URL=not-a-url threw a raw TypeError out of bootstrap and killed startup. Bad
  // configuration must not be fatal at boot, and never from a log statement - the gate already treats
  // such a value as unusable, so boot warns and refuses instead.
  const stores = await openStores({ kvPath: ":memory:" });
  const booted = await bootstrap({
    port: 0,
    stores,
    isDeploy: true,
    synthesizer: null,
    config: { publicBaseUrl: "not-a-url" },
  });
  try {
    assertEquals(booted.isDeploy, true, "it must boot at all - that is the bug");

    // Fail closed rather than trusting the Host header: an origin that cannot be parsed is not an
    // origin, so nothing non-loopback may be advertised.
    const refused = await booted.fetch(
      new Request("https://audio-feed.paulkinlan-ea.deno.net/", {
        headers: { host: "audio-feed.paulkinlan-ea.deno.net" },
      }),
    );
    await refused.body?.cancel();
    assertEquals(refused.status, 421, "an unusable configured origin must fail closed");

    // And local development is unaffected, so a bad value degrades rather than blocks.
    const local = await booted.fetch(new Request("http://localhost:8000/"));
    await local.body?.cancel();
    assert(local.status !== 421, "loopback must not be refused, bad value or not");
  } finally {
    await booted.shutdown();
  }
});

Deno.test("an ALLOWED_HOSTS list with no usable entry warns at boot and fails closed (audio-feed-4x4t)", async () => {
  // The bug this pins: the warning condition keyed on the raw ALLOWED_HOSTS array length, so
  // ["not a host", ""] counted as configured, the warning was suppressed, and the deployment refused
  // every non-loopback host with a 421 in total silence. Both halves are asserted together because
  // either one alone is survivable - refusing while warning is defensible, and warning while serving
  // would be fine - but refusing invisibly is what costs an operator an afternoon. This fails if the
  // condition is reverted to `.length`, because then nothing is warned at all.
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warned.push(args.map((a) => String(a)).join(" "));
  };
  const stores = await openStores({ kvPath: ":memory:" });
  let booted: Awaited<ReturnType<typeof bootstrap>> | null = null;
  try {
    booted = await bootstrap({
      port: 0,
      stores,
      isDeploy: true,
      synthesizer: null,
      config: { allowedHosts: ["not a host", ""] },
    });

    assert(
      warned.some((line) => line.includes("No usable PUBLIC_BASE_URL")),
      `boot must say that nothing usable is configured; warned: ${JSON.stringify(warned)}`,
    );

    const refused = await booted.fetch(
      new Request("https://audio-feed.paulkinlan-ea.deno.net/health", {
        headers: { host: "audio-feed.paulkinlan-ea.deno.net" },
      }),
    );
    await refused.body?.cancel();
    assertEquals(refused.status, 421, "and it must still fail closed");
  } finally {
    console.warn = original;
    if (booted) await booted.shutdown();
  }
});

Deno.test("a usable origin with unusable ALLOWED_HOSTS still says what it accepts (audio-feed-4x4t)", async () => {
  // The residual half of the same defect: the positive branch keyed on the raw array length too, so
  // PUBLIC_BASE_URL good + ALLOWED_HOSTS=["not a host",""] printed NOTHING - the gate worked and nobody
  // was told. Both halves are asserted: a positive line IS emitted, and a foreign host is still refused.
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  };
  const stores = await openStores({ kvPath: ":memory:" });
  let booted: Awaited<ReturnType<typeof bootstrap>> | null = null;
  try {
    booted = await bootstrap({
      port: 0,
      stores,
      isDeploy: true,
      synthesizer: null,
      config: { publicBaseUrl: "https://audio.example.com", allowedHosts: ["not a host", ""] },
    });
    // Exact, not a substring that another branch could also satisfy: the log must name the pinned host and
    // must NOT claim extra hosts, because the junk entries contribute none. Asserting only the host name
    // passed even when the code fell through to the "plus N extra hosts" branch, which is how a test can
    // look like a guard while pinning nothing.
    assert(
      logged.some((line) =>
        line.includes("Host gate: accepting audio.example.com (from PUBLIC_BASE_URL).")
      ),
      `boot must name the pinned host; logged: ${JSON.stringify(logged)}`,
    );
    assert(
      !logged.some((line) => line.includes("extra host")),
      `and must not claim extras that no usable entry provides; logged: ${JSON.stringify(logged)}`,
    );
    const foreign = await booted.fetch(
      new Request("https://evil.example/health", { headers: { host: "evil.example" } }),
    );
    await foreign.body?.cancel();
    assertEquals(foreign.status, 421, "and it must still refuse a host it does not know");
  } finally {
    console.log = original;
    if (booted) await booted.shutdown();
  }
});

Deno.test("ALLOWED_HOSTS alone activates the gate and says so (audio-feed-4x4t)", async () => {
  // The third state that used to log nothing: no usable PUBLIC_BASE_URL, but usable ALLOWED_HOSTS. The
  // gate is active, the listed host is served, a foreign host is refused, and the operator is told.
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  };
  const stores = await openStores({ kvPath: ":memory:" });
  let booted: Awaited<ReturnType<typeof bootstrap>> | null = null;
  try {
    booted = await bootstrap({
      port: 0,
      stores,
      isDeploy: true,
      synthesizer: null,
      config: { allowedHosts: ["audio.example.com"] },
    });
    assert(
      logged.some((line) => line.includes("Host gate: accepting 1 host(s) from ALLOWED_HOSTS")),
      `boot must name the ALLOWED_HOSTS-only case; logged: ${JSON.stringify(logged)}`,
    );
    const listed = await booted.fetch(
      new Request("https://audio.example.com/health", { headers: { host: "audio.example.com" } }),
    );
    await listed.body?.cancel();
    assert(listed.status !== 421, "a listed host must be served when it is the only configuration");
    const foreign = await booted.fetch(
      new Request("https://evil.example/health", { headers: { host: "evil.example" } }),
    );
    await foreign.body?.cancel();
    assertEquals(foreign.status, 421, "an unlisted host must still be refused");
  } finally {
    console.log = original;
    if (booted) await booted.shutdown();
  }
});

Deno.test("a malformed ALLOWED_HOSTS entry is ignored, not fatal (audio-feed-ft74)", async () => {
  const stores = await openStores({ kvPath: ":memory:" });
  const booted = await bootstrap({
    port: 0,
    stores,
    isDeploy: true,
    synthesizer: null,
    config: { allowedHosts: ["not a host", ""] },
  });
  try {
    // The set is empty, so nothing non-loopback is accepted - and nothing threw getting there.
    const refused = await booted.fetch(
      new Request("https://audio-feed.paulkinlan-ea.deno.net/", {
        headers: { host: "audio-feed.paulkinlan-ea.deno.net" },
      }),
    );
    await refused.body?.cancel();
    assertEquals(refused.status, 421, "entries that do not parse must not open the gate");
  } finally {
    await booted.shutdown();
  }
});
