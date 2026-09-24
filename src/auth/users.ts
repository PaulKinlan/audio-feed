/**
 * Multi-user policy and the admin-approval gate.
 *
 * The one rule that matters: no audio is ever synthesised for a user whose
 * status is not `approved`, because synthesis is the only thing here that costs
 * money.
 *
 * THIS MODULE NO LONGER TOUCHES `Deno.Kv` (audio-feed-ruw).
 *
 * It used to write `["user", id]` directly, while `src/storage/kv.ts` wrote the
 * same key with a different record shape. Whichever ran last silently dropped
 * the other's fields — `isAdmin` vanishing is a privilege bug, and `status`
 * vanishing is an unauthorized-spend bug. Both were invisible: every unit test
 * passed, because each module only ever read back its own writes.
 *
 * The fix is structural rather than conventional. Persistence belongs to
 * `MetadataStore`; this file is policy over it: email validation, transition
 * rules, the audit ledger, and the gate. One writer, one shape, one key.
 *
 * Every function here takes a `MetadataStore`, never a `Deno.Kv`. If you find
 * yourself needing `Deno.openKv()` in this file, the interface is missing a
 * method — add it there and to the conformance suite.
 *
 * Owned by: audio-feed-7wn, restructured by audio-feed-ruw.
 */

import { newFeedToken, newUserId, timingSafeEqual } from "../ids.ts";
import type { MetadataStore } from "../storage/mod.ts";
import type { ApprovalRecord, User, UserStatus } from "../types.ts";

export type { ApprovalRecord, PublicUser, User, UserStatus } from "../types.ts";
export { redactUser } from "../types.ts";

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately permissive: something@something.tld, no whitespace. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(normaliseEmail(email));
}

/**
 * Constant-time secret comparison, hashed to a fixed width first so the
 * comparison cannot leak the secret's length.
 */
export async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(hex(new Uint8Array(a)), hex(new Uint8Array(b)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The admin gate. Every mutating HTTP path must call this before touching a
 * user record.
 */
export async function requireAdminToken(provided: string | null, expected: string): Promise<void> {
  if (!(await tokensMatch(provided ?? "", expected))) {
    throw new Error("Unauthorized: admin token required");
  }
}

/**
 * Create a pending subscriber. Never approved on creation.
 *
 * The feed token is minted here, so a user is subscribable from the moment it
 * exists and no caller has to handle a user with a missing capability.
 */
export async function createUser(
  store: MetadataStore,
  input: {
    email: string;
    displayName?: string;
    voice?: string;
    feeds?: string[];
    isAdmin?: boolean;
  },
): Promise<User> {
  const email = normaliseEmail(input.email);
  if (!isValidEmail(email)) throw new Error(`Invalid email: ${input.email}`);

  const user: User = {
    id: newUserId(),
    email,
    displayName: input.displayName?.trim() || email.split("@")[0] || email,
    // Hard-coded: signups land in the approval queue, always.
    status: "pending",
    isAdmin: input.isAdmin ?? false,
    createdAt: new Date().toISOString(),
    feedToken: newFeedToken(),
    voice: input.voice,
    feeds: input.feeds ?? [],
  };

  // Atomic in the store, so two concurrent signups for one email cannot both
  // succeed. A read-then-write here would let exactly that through.
  if (!(await store.insertUser(user))) {
    throw new Error(`Email already registered: ${email}`);
  }
  return user;
}

export function getUser(store: MetadataStore, id: string): Promise<User | null> {
  return store.getUser(id);
}

export function getUserByEmail(store: MetadataStore, email: string): Promise<User | null> {
  return store.getUserByEmail(normaliseEmail(email));
}

/**
 * Resolve the bearer of a feed URL. `null` for unknown, empty, or malformed —
 * a feed route answers 404 either way, and distinguishing "no such token" from
 * "wrong token" would confirm which tokens exist.
 */
export function getUserByFeedToken(store: MetadataStore, token: string): Promise<User | null> {
  return store.getUserByFeedToken(token);
}

export async function listUsers(store: MetadataStore, status?: UserStatus): Promise<User[]> {
  const users = await store.listUsers();
  return users
    .filter((user) => !status || user.status === status)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function listApprovalLog(store: MetadataStore): Promise<ApprovalRecord[]> {
  return store.listApprovalLog();
}

/**
 * Legal transitions, keyed by the target status.
 *
 * A pending user is decided by approve/reject; there is nothing to suspend yet.
 * A rejected or suspended user can be re-admitted by an admin.
 */
const ALLOWED_FROM: Record<UserStatus, UserStatus[]> = {
  pending: [],
  approved: ["pending", "rejected", "suspended"],
  rejected: ["pending", "approved", "suspended"],
  suspended: ["approved"],
};

async function decide(
  store: MetadataStore,
  userId: string,
  action: UserStatus,
  adminId: string,
  reason?: string,
): Promise<User> {
  const user = await store.getUser(userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  if (user.status === action) return user;
  if (!ALLOWED_FROM[action].includes(user.status)) {
    throw new Error(`Cannot move user ${userId} from ${user.status} to ${action}`);
  }

  const at = new Date().toISOString();
  const updated: User = { ...user, status: action, decidedAt: at, decidedBy: adminId, reason };
  const record: ApprovalRecord = { userId, action, adminId, at, reason };

  // One commit for both. Two calls would let the ledger disagree with the user
  // it describes, and an audit trail that can drift is not an audit trail.
  await store.recordApproval(updated, record);
  return updated;
}

export function approveUser(
  store: MetadataStore,
  userId: string,
  adminId: string,
): Promise<User> {
  return decide(store, userId, "approved", adminId);
}

export function rejectUser(
  store: MetadataStore,
  userId: string,
  adminId: string,
  reason?: string,
): Promise<User> {
  return decide(store, userId, "rejected", adminId, reason);
}

export function suspendUser(
  store: MetadataStore,
  userId: string,
  adminId: string,
  reason?: string,
): Promise<User> {
  return decide(store, userId, "suspended", adminId, reason);
}

export class NotAuthorizedError extends Error {
  constructor(userId: string, readonly status: UserStatus | "unknown") {
    super(`Audio generation not authorized for user ${userId} (status: ${status})`);
    this.name = "NotAuthorizedError";
  }
}

/**
 * The single gate every synthesis path must pass.
 *
 * Throws rather than returning a boolean, so a forgotten `!` cannot fail open.
 * Prefer this over `isSynthesisAuthorized` anywhere money is about to be spent.
 */
export async function assertAuthorizedForAudio(
  store: MetadataStore,
  userId: string,
): Promise<User> {
  const user = await store.getUser(userId);
  if (!user) throw new NotAuthorizedError(userId, "unknown");
  if (user.status !== "approved") throw new NotAuthorizedError(userId, user.status);
  return user;
}

export async function isAuthorizedForAudio(
  store: MetadataStore,
  userId: string,
): Promise<boolean> {
  try {
    await assertAuthorizedForAudio(store, userId);
    return true;
  } catch {
    return false;
  }
}

/** Update a user's own listening preferences. Does not touch status. */
export async function updatePreferences(
  store: MetadataStore,
  userId: string,
  patch: { displayName?: string; voice?: string; feeds?: string[] },
): Promise<User> {
  const user = await store.getUser(userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  const updated: User = {
    ...user,
    displayName: patch.displayName?.trim() || user.displayName,
    voice: patch.voice ?? user.voice,
    feeds: patch.feeds ?? user.feeds,
  };
  await store.putUser(updated);
  return updated;
}

/**
 * Rotate a user's feed capability.
 *
 * Every subscribed podcast client stops working immediately — that is the
 * point. It is the only way to revoke a leaked feed URL, because the clients
 * holding it cannot be asked to authenticate.
 */
export async function rotateFeedToken(store: MetadataStore, userId: string): Promise<User> {
  const user = await store.getUser(userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  const updated: User = { ...user, feedToken: newFeedToken() };
  await store.putUser(updated);
  return updated;
}

/** Same-owner check: one user's feed is not another user's business. */
export function canReadUser(requestingUser: User, targetUserId: string): boolean {
  return requestingUser.isAdmin || requestingUser.id === targetUserId;
}
