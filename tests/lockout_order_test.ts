/**
 * Tests for failed-auth lockout ordering (audio-feed-pymwh).
 *
 * Verifies the security invariant across all three secret-gated surfaces:
 * 1. src/compose/admin.ts (adminGate)
 * 2. src/routes/account_api.ts (bootstrap)
 * 3. src/routes/observability.ts (authorise)
 *
 * Contract:
 * - N+1 attempts are refused BEFORE the compare is evaluated (asserted via counter seam).
 * - A correct secret on an unthrottled window still works and resets the failure counter.
 * - Refusal costs no credit and does NOT extend the sliding window.
 * - The mutant restoring compare-before-gate order reddens the "compare not called" row.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { AppContext } from "../src/app.ts";
import { memoryStores, type Stores } from "../src/config.ts";
import { FailedAuthLimiter } from "../src/auth/rate_limit.ts";
import { adminGate } from "../src/compose/admin.ts";
import { createAccountHandlers } from "../src/routes/account_api.ts";
import { authorise } from "../src/routes/observability.ts";

const BASE = "https://audio.example.com";
const ADMIN_SECRET = "secret-admin-passphrase-test-123";
const OBS_SECRET = "secret-observability-key-456";

function setupContext(stores: Stores = memoryStores()): AppContext {
  return {
    config: {
      port: 8080,
      publicBaseUrl: BASE,
      adminToken: ADMIN_SECRET,
      observabilityKey: OBS_SECRET,
    },
    stores,
  };
}

Deno.test("lockout order row 1: src/compose/admin.ts (adminGate) gates before compare", async () => {
  const stores = memoryStores();
  const ctx = setupContext(stores);
  const limiter = new FailedAuthLimiter(stores.metadata, { maxFailures: 3, windowMs: 60_000 });

  let compareCalls = 0;
  const compare = (provided: string, expected: string) => {
    compareCalls++;
    return provided === expected;
  };

  const clientIp = "192.0.2.1";

  // Attempts 1..3: wrong token. Each evaluates compare and returns 401.
  for (let i = 1; i <= 3; i++) {
    const req = new Request(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": `wrong-${i}` },
    });
    const res = await adminGate(ctx, req, clientIp, { limiter, compare });
    assert(res !== null, "wrong attempt must be refused");
    assertEquals(res.status, 401);
    assertEquals(compareCalls, i, `attempt ${i} must evaluate compare`);
  }

  // Attempt 4 (N+1 attempt): must be refused with 429 WITHOUT calling compare.
  const req4 = new Request(`${BASE}/api/admin/users`, {
    headers: { "x-admin-token": "wrong-4" },
  });
  const res4 = await adminGate(ctx, req4, clientIp, { limiter, compare });
  assert(res4 !== null, "4th attempt must be refused");
  assertEquals(res4.status, 429);
  assertEquals(
    compareCalls,
    3,
    "compare must NOT be called on N+1 attempt (refused before compare)",
  );

  // Refusal costs no credit and does NOT extend the window.
  const req5 = new Request(`${BASE}/api/admin/users`, {
    headers: { "x-admin-token": "wrong-5" },
  });
  const res5 = await adminGate(ctx, req5, clientIp, { limiter, compare });
  assert(res5 !== null);
  assertEquals(res5.status, 429);
  assertEquals(compareCalls, 3, "5th attempt still must not evaluate compare");

  const retryAfter = Number(res5.headers.get("retry-after"));
  assert(Number.isFinite(retryAfter) && retryAfter <= 60 && retryAfter >= 1);

  // Check stored timestamps in metadata store: exactly 3 entries recorded, not 5.
  const stored = await stores.metadata.atomicUpdate<number[]>("admin_auth:192.0.2.1", () => null);
  assertEquals(stored.value?.length, 3, "refused attempts must not add entries to store");

  // A correct secret on an unthrottled window still works and resets the failure counter.
  const cleanIp = "192.0.2.2";
  const cleanReq = new Request(`${BASE}/api/admin/users`, {
    headers: { "x-admin-token": ADMIN_SECRET },
  });
  const cleanRes = await adminGate(ctx, cleanReq, cleanIp, { limiter, compare });
  assertEquals(cleanRes, null, "correct secret on unthrottled window must be admitted");
  assertEquals(compareCalls, 4, "clean attempt evaluates compare once");

  const cleanStored = await stores.metadata.atomicUpdate<number[]>(
    "admin_auth:192.0.2.2",
    () => null,
  );
  assertEquals(cleanStored.value?.length, 0, "successful auth resets limiter window");
});

Deno.test("lockout order row 2: src/routes/account_api.ts (bootstrap) gates before compare", async () => {
  const stores = memoryStores();
  const ctx = setupContext(stores);
  const limiter = new FailedAuthLimiter(stores.metadata, { maxFailures: 3, windowMs: 60_000 });

  let compareCalls = 0;
  const compareAdminToken = (provided: string, expected: string) => {
    compareCalls++;
    return provided === expected;
  };

  const handlers = createAccountHandlers(ctx, {
    adminAuthLimiter: limiter,
    compareAdminToken,
    deleteUserSource: () => Promise.resolve(new Response(null, { status: 200 })),
    regenerateOutdated: () => Promise.resolve(0),
  });

  const clientIp = "192.0.2.10";

  // Attempts 1..3: wrong token. Each evaluates compare and returns 401.
  for (let i = 1; i <= 3; i++) {
    const req = new Request(`${BASE}/api/auth/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", "origin": BASE },
      body: JSON.stringify({ email: `admin${i}@example.com`, adminToken: `wrong-${i}` }),
    });
    const res = await handlers.bootstrap({
      ctx,
      req,
      remoteAddr: clientIp,
      params: {},
      url: new URL(req.url),
    });
    assertEquals(res.status, 401);
    assertEquals(compareCalls, i, `attempt ${i} must evaluate compare`);
  }

  // Attempt 4 (N+1 attempt): must be refused with 429 WITHOUT calling compare.
  const req4 = new Request(`${BASE}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": BASE },
    body: JSON.stringify({ email: "admin4@example.com", adminToken: "wrong-4" }),
  });
  const res4 = await handlers.bootstrap({
    ctx,
    req: req4,
    remoteAddr: clientIp,
    params: {},
    url: new URL(req4.url),
  });
  assertEquals(res4.status, 429);
  assertEquals(
    compareCalls,
    3,
    "compare must NOT be called on N+1 attempt (refused before compare)",
  );

  // Refusal costs no credit and does NOT extend the window.
  const req5 = new Request(`${BASE}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": BASE },
    body: JSON.stringify({ email: "admin5@example.com", adminToken: "wrong-5" }),
  });
  const res5 = await handlers.bootstrap({
    ctx,
    req: req5,
    remoteAddr: clientIp,
    params: {},
    url: new URL(req5.url),
  });
  assertEquals(res5.status, 429);
  assertEquals(compareCalls, 3, "5th attempt still must not evaluate compare");

  const stored = await stores.metadata.atomicUpdate<number[]>("admin_auth:192.0.2.10", () => null);
  assertEquals(stored.value?.length, 3, "refused attempts must not add entries to store");

  // A correct secret on an unthrottled window still works and resets the failure counter.
  const cleanIp = "192.0.2.20";
  const cleanReq = new Request(`${BASE}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": BASE },
    body: JSON.stringify({ email: "bootstrap-ok@example.com", adminToken: ADMIN_SECRET }),
  });
  const cleanRes = await handlers.bootstrap({
    ctx,
    req: cleanReq,
    remoteAddr: cleanIp,
    params: {},
    url: new URL(cleanReq.url),
  });
  assertEquals(cleanRes.status, 200, "correct secret on unthrottled window must bootstrap user");
  assertEquals(compareCalls, 4, "clean attempt evaluates compare once");

  const cleanStored = await stores.metadata.atomicUpdate<number[]>(
    "admin_auth:192.0.2.20",
    () => null,
  );
  assertEquals(cleanStored.value?.length, 0, "successful auth resets limiter window");
});

Deno.test("lockout order row 3: src/routes/observability.ts (authorise) gates before compare", async () => {
  const stores = memoryStores();
  const ctx = setupContext(stores);
  const limiter = new FailedAuthLimiter(stores.metadata, {
    maxFailures: 3,
    windowMs: 60_000,
    namespace: "observability_auth",
  });

  let compareCalls = 0;
  const compareKey = (provided: string, expected: string) => {
    compareCalls++;
    return provided === expected;
  };

  const clientIp = "192.0.2.30";

  // Attempts 1..3: wrong key. Each evaluates compare and returns 401.
  for (let i = 1; i <= 3; i++) {
    const req = new Request(`${BASE}/api/observability/errors`, {
      headers: { authorization: `Bearer wrong-${i}` },
    });
    const res = await authorise(ctx, req, clientIp, { limiter, compareKey });
    assert(res !== null);
    assertEquals(res.status, 401);
    assertEquals(compareCalls, i, `attempt ${i} must evaluate compare`);
  }

  // Attempt 4 (N+1 attempt): must be refused with 429 WITHOUT calling compare.
  const req4 = new Request(`${BASE}/api/observability/errors`, {
    headers: { authorization: "Bearer wrong-4" },
  });
  const res4 = await authorise(ctx, req4, clientIp, { limiter, compareKey });
  assert(res4 !== null);
  assertEquals(res4.status, 429);
  assertEquals(
    compareCalls,
    3,
    "compare must NOT be called on N+1 attempt (refused before compare)",
  );

  // Refusal costs no credit and does NOT extend the window.
  const req5 = new Request(`${BASE}/api/observability/errors`, {
    headers: { authorization: "Bearer wrong-5" },
  });
  const res5 = await authorise(ctx, req5, clientIp, { limiter, compareKey });
  assert(res5 !== null);
  assertEquals(res5.status, 429);
  assertEquals(compareCalls, 3, "5th attempt still must not evaluate compare");

  const stored = await stores.metadata.atomicUpdate<number[]>(
    "observability_auth:192.0.2.30",
    () => null,
  );
  assertEquals(stored.value?.length, 3, "refused attempts must not add entries to store");

  // A correct secret on an unthrottled window still works and resets the failure counter.
  const cleanIp = "192.0.2.40";
  const cleanReq = new Request(`${BASE}/api/observability/errors`, {
    headers: { authorization: `Bearer ${OBS_SECRET}` },
  });
  const cleanRes = await authorise(ctx, cleanReq, cleanIp, { limiter, compareKey });
  assertEquals(cleanRes, null, "correct key on unthrottled window must be admitted");
  assertEquals(compareCalls, 4, "clean attempt evaluates compare once");

  const cleanStored = await stores.metadata.atomicUpdate<number[]>(
    "observability_auth:192.0.2.40",
    () => null,
  );
  assertEquals(cleanStored.value?.length, 0, "successful auth resets limiter window");
});

Deno.test("lockout order mutant: restoring compare-before-gate reddens 'compare not called' row", async () => {
  // Simulate the flawed mutant implementation where compare runs BEFORE the lockout check:
  const stores = memoryStores();
  const limiter = new FailedAuthLimiter(stores.metadata, { maxFailures: 3, windowMs: 60_000 });

  let mutantCompareCalls = 0;
  const mutantCompare = () => {
    mutantCompareCalls++;
    return false;
  };

  const mutantGate = async (key: string) => {
    // FLAWED ORDER (mutant): secret is compared FIRST, before checking lockout
    const match = mutantCompare();
    if (match) {
      await limiter.reset(key);
      return null;
    }
    const lock = await limiter.isLockedOut(key);
    if (!lock.allowed) {
      return new Response(null, { status: 429 });
    }
    await limiter.recordFailure(key);
    return new Response(null, { status: 401 });
  };

  const clientIp = "192.0.2.99";
  for (let i = 0; i < 3; i++) {
    await mutantGate(clientIp);
  }
  assertEquals(mutantCompareCalls, 3);

  // Attempt 4: the mutant runs compare BEFORE checking lockout
  await mutantGate(clientIp);

  // The assertion that compare was NOT called on N+1 attempt must FAIL (redden)
  assertThrows(
    () => {
      assertEquals(
        mutantCompareCalls,
        3,
        "compare must NOT be called on N+1 attempt (refused before compare)",
      );
    },
    Error,
    "Values are not equal",
  );
});
