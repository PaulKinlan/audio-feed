/**
 * Multi-user + admin-approval gate tests.
 *
 * These run against an in-memory Deno KV so the real read-modify-write paths
 * are exercised, not a stub.
 *
 * Deno 2.9 still gates Deno.openKv behind `--unstable-kv` locally (Deno Deploy
 * needs no flag):
 *   deno test -A --unstable-kv tests/auth/
 */
import {
  approveUser,
  assertAuthorizedForAudio,
  canReadUser,
  createUser,
  getUser,
  getUserByEmail,
  isAuthorizedForAudio,
  isValidEmail,
  listApprovalLog,
  listUsers,
  normaliseEmail,
  NotAuthorizedError,
  rejectUser,
  requireAdminToken,
  suspendUser,
  tokensMatch,
  updatePreferences,
} from "../../src/auth/users.ts";

const ADMIN_TOKEN = "s3cret-admin-token-value";

async function setup() {
  const kv = await Deno.openKv(":memory:");
  const admin = await createUser(kv, {
    email: "admin@example.com",
    displayName: "Admin",
    isAdmin: true,
  });
  return { kv, admin };
}

Deno.test("signup lands in pending and cannot generate audio", async () => {
  const { kv, admin } = await setup();
  const user = await createUser(kv, { email: "Subscriber@Example.com ", displayName: "Sub" });

  if (user.status !== "pending") throw new Error(`expected pending, got ${user.status}`);
  if (user.email !== "subscriber@example.com") throw new Error("email not normalised");
  if (user.displayName !== "Sub") throw new Error("display name lost");
  // Email conflict checking must be case-insensitive.
  const byEmail = await getUserByEmail(kv, "SUBSCRIBER@example.com");
  if (byEmail?.id !== user.id) throw new Error("email lookup failed");

  const beforeApproval = await isAuthorizedForAudio(kv, user.id);
  if (beforeApproval) throw new Error("pending user must not be authorized");

  let threw = false;
  try {
    await assertAuthorizedForAudio(kv, user.id);
  } catch (error) {
    threw = error instanceof NotAuthorizedError;
  }
  if (!threw) throw new Error("assertAuthorizedForAudio must throw for pending users");

  // Admin accounts are not special-cased by the gate.
  if (await isAuthorizedForAudio(kv, admin.id)) {
    throw new Error("admin without approval must not be authorized");
  }

  kv.close();
});

Deno.test("approval is the only thing that unlocks audio", async () => {
  const { kv, admin } = await setup();
  const user = await createUser(kv, { email: "u@example.com" });

  const approved = await approveUser(kv, user.id, admin.id);
  if (approved.status !== "approved") throw new Error(approved.status);
  if (approved.decidedBy !== admin.id) throw new Error("approver not recorded");
  if (!approved.decidedAt) throw new Error("decision time not recorded");
  if (!(await isAuthorizedForAudio(kv, user.id))) throw new Error("approved user still blocked");

  // Preferences can change without re-opening the gate.
  await updatePreferences(kv, user.id, { voice: "Kore", feeds: ["stratechery"] });
  const afterPrefs = await getUser(kv, user.id);
  if (afterPrefs?.status !== "approved") throw new Error("prefs update changed status");
  if (afterPrefs.voice !== "Kore") throw new Error("voice not saved");

  // And it re-locks the moment the user is suspended or rejected.
  const suspended = await suspendUser(kv, user.id, admin.id, "payment failed");
  if (suspended.status !== "suspended") throw new Error(suspended.status);
  if (await isAuthorizedForAudio(kv, user.id)) throw new Error("suspended user still authorized");

  const rejected = await rejectUser(kv, user.id, admin.id, "spam signup");
  if (rejected.status !== "rejected" || rejected.reason !== "spam signup") {
    throw new Error("rejection reason not recorded");
  }
  if (await isAuthorizedForAudio(kv, user.id)) throw new Error("rejected user still authorized");

  kv.close();
});

Deno.test("unknown users fail closed", async () => {
  const { kv } = await setup();
  if (await isAuthorizedForAudio(kv, "no-such-user")) {
    throw new Error("unknown user must not be authorized");
  }
  let threw = false;
  try {
    await assertAuthorizedForAudio(kv, "no-such-user");
  } catch (error) {
    threw = error instanceof NotAuthorizedError && error.message.includes("unknown");
  }
  if (!threw) throw new Error("unknown user must throw");
  kv.close();
});

Deno.test("invalid transitions are refused", async () => {
  const { kv, admin } = await setup();
  const user = await createUser(kv, { email: "u@example.com" });

  // A pending user was never approved, so it cannot be suspended.
  let threw = false;
  try {
    await suspendUser(kv, user.id, admin.id);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("pending -> suspended should be refused");

  // Repeating a decision is a no-op, not an error.
  await approveUser(kv, user.id, admin.id);
  const again = await approveUser(kv, user.id, admin.id);
  if (again.status !== "approved") throw new Error("idempotent approve failed");

  let missing = false;
  try {
    await approveUser(kv, "ghost", admin.id);
  } catch {
    missing = true;
  }
  if (!missing) throw new Error("approving an unknown user should throw");
  kv.close();
});

Deno.test("the full transition matrix is enforced", async () => {
  const decide = { approved: approveUser, rejected: rejectUser, suspended: suspendUser } as const;
  const allowed: Record<string, string[]> = {
    pending: ["approved", "rejected"],
    approved: ["rejected", "suspended"],
    rejected: ["approved"],
    suspended: ["approved", "rejected"],
  };

  for (const from of ["pending", "approved", "rejected", "suspended"] as const) {
    for (const to of ["approved", "rejected", "suspended"] as const) {
      // Repeating a decision is an idempotent no-op, covered above.
      if (from === to) continue;
      const { kv, admin } = await setup();
      const user = await createUser(kv, { email: "u@example.com" });
      if (from !== "pending") {
        // Walk to the starting state through the legal path.
        if (from === "approved" || from === "suspended") await approveUser(kv, user.id, admin.id);
        if (from === "rejected") await rejectUser(kv, user.id, admin.id);
        if (from === "suspended") await suspendUser(kv, user.id, admin.id);
      }
      const current = await getUser(kv, user.id);
      if (current?.status !== from) {
        throw new Error(`setup failed: wanted ${from}, got ${current?.status}`);
      }

      const shouldPass = allowed[from]?.includes(to) ?? false;
      let passed = true;
      let message = "";
      try {
        await decide[to](kv, user.id, admin.id);
      } catch (error) {
        passed = false;
        message = String(error);
      }
      if (passed !== shouldPass) {
        throw new Error(
          `${from} -> ${to}: expected ${shouldPass ? "allowed" : "refused"}, ${
            passed ? "allowed" : message
          }`,
        );
      }
      if (shouldPass && (await getUser(kv, user.id))?.status !== to) {
        throw new Error(`${from} -> ${to} did not persist`);
      }
      kv.close();
    }
  }
});

Deno.test("duplicate and malformed signups are refused", async () => {
  const { kv } = await setup();
  await createUser(kv, { email: "dup@example.com" });

  let duplicate = false;
  try {
    await createUser(kv, { email: "DUP@Example.com" });
  } catch (error) {
    duplicate = String(error).includes("already registered");
  }
  if (!duplicate) throw new Error("duplicate email should be refused");

  for (const bad of ["nope", "a@b", "no spaces@example.com", "@example.com", ""]) {
    let threw = false;
    try {
      await createUser(kv, { email: bad });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`invalid email accepted: ${JSON.stringify(bad)}`);
  }
  if (!isValidEmail("real@example.co.uk")) throw new Error("valid email rejected");
  if (normaliseEmail("  MiXeD@Example.COM ") !== "mixed@example.com") {
    throw new Error("normalisation broken");
  }
  kv.close();
});

Deno.test("admin token gate rejects everything but an exact match", async () => {
  await requireAdminToken(ADMIN_TOKEN, ADMIN_TOKEN);

  for (const bad of [null, "", "wrong", ADMIN_TOKEN + "x", ADMIN_TOKEN.slice(0, -1), " short"]) {
    let threw = false;
    try {
      await requireAdminToken(bad, ADMIN_TOKEN);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`admin gate accepted ${JSON.stringify(bad)}`);
  }

  // Secrets of different lengths must not compare equal, and hashing keeps the
  // comparison constant width.
  if (await tokensMatch("a", "aa")) throw new Error("length mismatch compared equal");
  if (!(await tokensMatch("same", "same"))) throw new Error("identical tokens did not match");
  if (await tokensMatch("", "")) throw new Error("empty tokens must not match");
});

Deno.test("approval ledger records every decision, attributes feeds, filters status", async () => {
  const { kv, admin } = await setup();
  const a = await createUser(kv, { email: "a@example.com" });
  const b = await createUser(kv, { email: "b@example.com" });
  await approveUser(kv, a.id, admin.id);
  await rejectUser(kv, b.id, admin.id, "no source of truth");

  const log = await listApprovalLog(kv);
  if (log.length !== 2) throw new Error(`expected 2 ledger records, got ${log.length}`);
  if (!log.every((record) => record.adminId === admin.id)) throw new Error("admin not attributed");
  if (
    !log.some((record) => record.action === "rejected" && record.reason === "no source of truth")
  ) {
    throw new Error("rejection reason missing from ledger");
  }

  const approved = await listUsers(kv, "approved");
  if (approved.length !== 1 || approved[0]?.id !== a.id) throw new Error("approved filter wrong");
  const pending = await listUsers(kv, "pending");
  if (pending.length !== 1 || pending[0]?.id !== admin.id) throw new Error("pending filter wrong");
  if ((await listUsers(kv)).length !== 3) throw new Error("unfiltered list wrong");

  // One subscriber cannot read another's data; admins can.
  const subscriber = await getUser(kv, a.id);
  if (canReadUser(subscriber!, b.id)) throw new Error("cross-user read allowed");
  if (!canReadUser(subscriber!, a.id)) throw new Error("self read denied");
  if (!canReadUser(admin, b.id)) throw new Error("admin read denied");

  kv.close();
});
