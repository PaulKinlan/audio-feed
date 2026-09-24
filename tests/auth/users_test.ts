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
  getUserByFeedToken,
  isAuthorizedForAudio,
  isValidEmail,
  listApprovalLog,
  listUsers,
  normaliseEmail,
  NotAuthorizedError,
  redactUser,
  rejectUser,
  requireAdminToken,
  rotateFeedToken,
  suspendUser,
  tokensMatch,
  updatePreferences,
} from "../../src/auth/users.ts";
import { KvMetadataStore } from "../../src/storage/kv.ts";

const ADMIN_TOKEN = "s3cret-admin-token-value";

async function setup() {
  const store = await KvMetadataStore.open(":memory:");
  const admin = await createUser(store, {
    email: "admin@example.com",
    displayName: "Admin",
    isAdmin: true,
  });
  return { store, admin };
}

Deno.test("signup lands in pending and cannot generate audio", async () => {
  const { store, admin } = await setup();
  const user = await createUser(store, { email: "Subscriber@Example.com ", displayName: "Sub" });

  if (user.status !== "pending") throw new Error(`expected pending, got ${user.status}`);
  if (user.email !== "subscriber@example.com") throw new Error("email not normalised");
  if (user.displayName !== "Sub") throw new Error("display name lost");
  // Email conflict checking must be case-insensitive.
  const byEmail = await getUserByEmail(store, "SUBSCRIBER@example.com");
  if (byEmail?.id !== user.id) throw new Error("email lookup failed");

  const beforeApproval = await isAuthorizedForAudio(store, user.id);
  if (beforeApproval) throw new Error("pending user must not be authorized");

  let threw = false;
  try {
    await assertAuthorizedForAudio(store, user.id);
  } catch (error) {
    threw = error instanceof NotAuthorizedError;
  }
  if (!threw) throw new Error("assertAuthorizedForAudio must throw for pending users");

  // Admin accounts are not special-cased by the gate.
  if (await isAuthorizedForAudio(store, admin.id)) {
    throw new Error("admin without approval must not be authorized");
  }

  await store.close();
});

Deno.test("approval is the only thing that unlocks audio", async () => {
  const { store, admin } = await setup();
  const user = await createUser(store, { email: "u@example.com" });

  const approved = await approveUser(store, user.id, admin.id);
  if (approved.status !== "approved") throw new Error(approved.status);
  if (approved.decidedBy !== admin.id) throw new Error("approver not recorded");
  if (!approved.decidedAt) throw new Error("decision time not recorded");
  if (!(await isAuthorizedForAudio(store, user.id))) throw new Error("approved user still blocked");

  // Preferences can change without re-opening the gate.
  await updatePreferences(store, user.id, { voice: "Kore", feeds: ["stratechery"] });
  const afterPrefs = await getUser(store, user.id);
  if (afterPrefs?.status !== "approved") throw new Error("prefs update changed status");
  if (afterPrefs.voice !== "Kore") throw new Error("voice not saved");

  // And it re-locks the moment the user is suspended or rejected.
  const suspended = await suspendUser(store, user.id, admin.id, "payment failed");
  if (suspended.status !== "suspended") throw new Error(suspended.status);
  if (await isAuthorizedForAudio(store, user.id)) {
    throw new Error("suspended user still authorized");
  }

  const rejected = await rejectUser(store, user.id, admin.id, "spam signup");
  if (rejected.status !== "rejected" || rejected.reason !== "spam signup") {
    throw new Error("rejection reason not recorded");
  }
  if (await isAuthorizedForAudio(store, user.id)) throw new Error("rejected user still authorized");

  await store.close();
});

Deno.test("unknown users fail closed", async () => {
  const { store } = await setup();
  if (await isAuthorizedForAudio(store, "no-such-user")) {
    throw new Error("unknown user must not be authorized");
  }
  let threw = false;
  try {
    await assertAuthorizedForAudio(store, "no-such-user");
  } catch (error) {
    threw = error instanceof NotAuthorizedError && error.message.includes("unknown");
  }
  if (!threw) throw new Error("unknown user must throw");
  await store.close();
});

Deno.test("invalid transitions are refused", async () => {
  const { store, admin } = await setup();
  const user = await createUser(store, { email: "u@example.com" });

  // A pending user was never approved, so it cannot be suspended.
  let threw = false;
  try {
    await suspendUser(store, user.id, admin.id);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("pending -> suspended should be refused");

  // Repeating a decision is a no-op, not an error.
  await approveUser(store, user.id, admin.id);
  const again = await approveUser(store, user.id, admin.id);
  if (again.status !== "approved") throw new Error("idempotent approve failed");

  let missing = false;
  try {
    await approveUser(store, "ghost", admin.id);
  } catch {
    missing = true;
  }
  if (!missing) throw new Error("approving an unknown user should throw");
  await store.close();
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
      const { store, admin } = await setup();
      const user = await createUser(store, { email: "u@example.com" });
      if (from !== "pending") {
        // Walk to the starting state through the legal path.
        if (from === "approved" || from === "suspended") {
          await approveUser(store, user.id, admin.id);
        }
        if (from === "rejected") await rejectUser(store, user.id, admin.id);
        if (from === "suspended") await suspendUser(store, user.id, admin.id);
      }
      const current = await getUser(store, user.id);
      if (current?.status !== from) {
        throw new Error(`setup failed: wanted ${from}, got ${current?.status}`);
      }

      const shouldPass = allowed[from]?.includes(to) ?? false;
      let passed = true;
      let message = "";
      try {
        await decide[to](store, user.id, admin.id);
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
      if (shouldPass && (await getUser(store, user.id))?.status !== to) {
        throw new Error(`${from} -> ${to} did not persist`);
      }
      await store.close();
    }
  }
});

Deno.test("duplicate and malformed signups are refused", async () => {
  const { store } = await setup();
  await createUser(store, { email: "dup@example.com" });

  let duplicate = false;
  try {
    await createUser(store, { email: "DUP@Example.com" });
  } catch (error) {
    duplicate = String(error).includes("already registered");
  }
  if (!duplicate) throw new Error("duplicate email should be refused");

  for (const bad of ["nope", "a@b", "no spaces@example.com", "@example.com", ""]) {
    let threw = false;
    try {
      await createUser(store, { email: bad });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`invalid email accepted: ${JSON.stringify(bad)}`);
  }
  if (!isValidEmail("real@example.co.uk")) throw new Error("valid email rejected");
  if (normaliseEmail("  MiXeD@Example.COM ") !== "mixed@example.com") {
    throw new Error("normalisation broken");
  }
  await store.close();
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
  const { store, admin } = await setup();
  const a = await createUser(store, { email: "a@example.com" });
  const b = await createUser(store, { email: "b@example.com" });
  await approveUser(store, a.id, admin.id);
  await rejectUser(store, b.id, admin.id, "no source of truth");

  const log = await listApprovalLog(store);
  if (log.length !== 2) throw new Error(`expected 2 ledger records, got ${log.length}`);
  if (!log.every((record) => record.adminId === admin.id)) throw new Error("admin not attributed");
  if (
    !log.some((record) => record.action === "rejected" && record.reason === "no source of truth")
  ) {
    throw new Error("rejection reason missing from ledger");
  }

  const approved = await listUsers(store, "approved");
  if (approved.length !== 1 || approved[0]?.id !== a.id) throw new Error("approved filter wrong");
  const pending = await listUsers(store, "pending");
  if (pending.length !== 1 || pending[0]?.id !== admin.id) throw new Error("pending filter wrong");
  if ((await listUsers(store)).length !== 3) throw new Error("unfiltered list wrong");

  // One subscriber cannot read another's data; admins can.
  const subscriber = await getUser(store, a.id);
  if (canReadUser(subscriber!, b.id)) throw new Error("cross-user read allowed");
  if (!canReadUser(subscriber!, a.id)) throw new Error("self read denied");
  if (!canReadUser(admin, b.id)) throw new Error("admin read denied");

  await store.close();
});

// ---------------------------------------------------------------------------
// audio-feed-ruw: one model, one key owner
// ---------------------------------------------------------------------------

Deno.test("policy and storage agree on every field of one user record", async () => {
  const { store } = await setup();
  const user = await createUser(store, {
    email: "both@example.com",
    displayName: "Both Ways",
    voice: "Kore",
    isAdmin: true,
  });

  // Written through the policy module, read through the storage interface.
  const viaStore = await store.getUser(user.id);
  if (viaStore?.isAdmin !== true) throw new Error("isAdmin lost between modules");
  if (viaStore?.displayName !== "Both Ways") throw new Error("displayName lost between modules");
  if (viaStore?.status !== "pending") throw new Error("status lost between modules");
  if (!viaStore?.feedToken) throw new Error("feedToken lost between modules");

  // Written through the storage interface, read through the policy module.
  await store.putUser({ ...viaStore, voice: "Puck" });
  const viaPolicy = await getUser(store, user.id);
  if (viaPolicy?.isAdmin !== true) throw new Error("isAdmin lost on the way back");
  if (viaPolicy?.displayName !== "Both Ways") throw new Error("displayName lost on the way back");
  if (viaPolicy?.voice !== "Puck") throw new Error("voice not persisted");

  await store.close();
});

Deno.test("an admin decision preserves the fields it did not decide", async () => {
  const { store, admin } = await setup();
  const user = await createUser(store, {
    email: "keep@example.com",
    displayName: "Keeper",
    voice: "Kore",
    feeds: ["stratechery"],
    isAdmin: true,
  });

  const approved = await approveUser(store, user.id, admin.id);
  if (approved.isAdmin !== true) throw new Error("approval dropped isAdmin");
  if (approved.displayName !== "Keeper") throw new Error("approval dropped displayName");
  if (approved.voice !== "Kore") throw new Error("approval dropped voice");
  if (approved.feedToken !== user.feedToken) throw new Error("approval rotated the feed token");
  if (approved.feeds?.[0] !== "stratechery") throw new Error("approval dropped feeds");

  await store.close();
});

Deno.test("every user is subscribable the moment it exists", async () => {
  const { store } = await setup();
  const user = await createUser(store, { email: "sub@example.com" });

  if (!user.feedToken) throw new Error("createUser must mint a feed token");
  const resolved = await getUserByFeedToken(store, user.feedToken);
  if (resolved?.id !== user.id) throw new Error("feed token did not resolve to its owner");

  // Two users must never share a capability.
  const other = await createUser(store, { email: "other@example.com" });
  if (other.feedToken === user.feedToken) throw new Error("feed tokens collided");

  await store.close();
});

Deno.test("an unknown or empty feed token resolves null rather than throwing", async () => {
  const { store } = await setup();
  // Empty matters: an empty Deno KV key part throws, and the feed route must be
  // able to answer 404 uniformly instead of 500.
  for (const token of ["", "nope", "../etc"]) {
    if (await getUserByFeedToken(store, token) !== null) {
      throw new Error(`expected null for ${JSON.stringify(token)}`);
    }
  }
  await store.close();
});

Deno.test("rotating a feed token revokes the old URL", async () => {
  const { store } = await setup();
  const user = await createUser(store, { email: "rotate@example.com" });

  const rotated = await rotateFeedToken(store, user.id);
  if (rotated.feedToken === user.feedToken) throw new Error("rotation produced the same token");
  // The whole point of rotation is that a leaked URL stops working.
  if (await getUserByFeedToken(store, user.feedToken) !== null) {
    throw new Error("the old feed token still resolves, so nothing was revoked");
  }
  if ((await getUserByFeedToken(store, rotated.feedToken))?.id !== user.id) {
    throw new Error("the new feed token does not resolve");
  }

  await store.close();
});

Deno.test("redactUser removes the feed token from anything serialisable", async () => {
  const { store } = await setup();
  const user = await createUser(store, { email: "redact@example.com", displayName: "Redact" });

  const redacted = redactUser(user);
  // Assert on the SERIALISED form. This exact leak shipped past a green suite
  // on this branch: an admin endpoint JSON-encoded the full record, and no test
  // looked at the bytes that actually left the process.
  const serialised = JSON.stringify(redacted);
  if (serialised.includes("feedToken")) throw new Error("redactUser left the key in place");
  if (serialised.includes(user.feedToken)) throw new Error("redactUser leaked the token value");

  // Everything an admin UI actually needs must survive redaction.
  if (redacted.id !== user.id) throw new Error("redaction dropped the id");
  if (redacted.displayName !== "Redact") throw new Error("redaction dropped displayName");
  if (redacted.status !== "pending") throw new Error("redaction dropped status");
  if (redacted.email !== "redact@example.com") throw new Error("redaction dropped email");

  await store.close();
});

Deno.test("a user list rendered for an admin carries no feed capability", async () => {
  const { store } = await setup();
  await createUser(store, { email: "a@example.com" });
  await createUser(store, { email: "b@example.com" });

  // The exact shape the admin queue serialises.
  const body = JSON.stringify({ pending: (await listUsers(store, "pending")).map(redactUser) });
  if (body.includes("feedToken")) {
    throw new Error("the admin queue is leaking feed capabilities");
  }

  await store.close();
});

Deno.test("concurrent signups for one email produce exactly one user", async () => {
  const { store } = await setup();
  // Sequential duplicate detection is covered above; this is the race a
  // read-then-write cannot win, which is why createUser relies on an atomic
  // insert rather than a lookup followed by a write.
  const attempts = await Promise.allSettled([
    createUser(store, { email: "race@example.com" }),
    createUser(store, { email: "race@example.com" }),
    createUser(store, { email: "RACE@example.com" }),
  ]);

  const winners = attempts.filter((result) => result.status === "fulfilled");
  if (winners.length !== 1) {
    throw new Error(`expected exactly one signup to win, got ${winners.length}`);
  }
  // The admin from setup() plus exactly one race winner.
  const stored = await listUsers(store);
  if (stored.length !== 2) throw new Error(`expected 2 users, got ${stored.length}`);

  await store.close();
});
