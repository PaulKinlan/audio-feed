/**
 * Multi-user model and the admin-approval gate.
 *
 * Storage is Deno KV (see PRODUCT.md). The one rule that matters: no audio is
 * ever synthesised for a user whose status is not `approved`, because
 * synthesis is the only thing here that costs money.
 */
export type UserStatus = "pending" | "approved" | "rejected" | "suspended";

/** A subscriber. Each user is its own listening persona. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: string;
  /** Preferred TTS voice preset (Aoede, Charon, Fenrir, Kore, Puck). */
  voice?: string;
  /** Source ids this user subscribes to. */
  feeds?: string[];
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalRecord {
  userId: string;
  action: UserStatus;
  adminId: string;
  at: string;
  reason?: string;
}

const userKey = (id: string) => ["user", id];
const emailKey = (email: string) => ["user-email", normaliseEmail(email)];

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately permissive: something@something.tld, no whitespace. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(normaliseEmail(email));
}

/**
 * Constant-time-ish secret comparison. `===` on secrets leaks length and
 * prefix through timing, so both sides are hashed to a fixed width first.
 */
export async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
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

/** Create a pending subscriber. Never approved on creation. */
export async function createUser(
  kv: Deno.Kv,
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

  const existing = await kv.get<string>(emailKey(email));
  if (existing.value) throw new Error(`Email already registered: ${email}`);

  const user: User = {
    id: crypto.randomUUID(),
    email,
    displayName: input.displayName?.trim() || email.split("@")[0] || email,
    // Hard-coded: signups land in the approval queue, always.
    status: "pending",
    isAdmin: input.isAdmin ?? false,
    createdAt: new Date().toISOString(),
    voice: input.voice,
    feeds: input.feeds ?? [],
  };

  const result = await kv.atomic()
    .check(existing)
    .set(userKey(user.id), user)
    .set(emailKey(email), user.id)
    .commit();
  if (!result.ok) throw new Error(`Email already registered: ${email}`);
  return user;
}

export async function getUser(kv: Deno.Kv, id: string): Promise<User | null> {
  return (await kv.get<User>(userKey(id))).value;
}

export async function getUserByEmail(kv: Deno.Kv, email: string): Promise<User | null> {
  const id = (await kv.get<string>(emailKey(email))).value;
  return id ? await getUser(kv, id) : null;
}

export async function listUsers(kv: Deno.Kv, status?: UserStatus): Promise<User[]> {
  const users: User[] = [];
  for await (const entry of kv.list<User>({ prefix: ["user"] })) {
    if (!status || entry.value.status === status) users.push(entry.value);
  }
  return users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listApprovalLog(kv: Deno.Kv): Promise<ApprovalRecord[]> {
  const records: ApprovalRecord[] = [];
  for await (const entry of kv.list<ApprovalRecord>({ prefix: ["approval-log"] })) {
    records.push(entry.value);
  }
  return records.sort((a, b) => a.at.localeCompare(b.at));
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
  kv: Deno.Kv,
  userId: string,
  action: UserStatus,
  adminId: string,
  reason?: string,
): Promise<User> {
  const user = await getUser(kv, userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  if (user.status === action) return user;
  if (!ALLOWED_FROM[action].includes(user.status)) {
    throw new Error(`Cannot move user ${userId} from ${user.status} to ${action}`);
  }

  const updated: User = {
    ...user,
    status: action,
    decidedAt: new Date().toISOString(),
    decidedBy: adminId,
    reason,
  };
  const record: ApprovalRecord = {
    userId,
    action,
    adminId,
    at: updated.decidedAt!,
    reason,
  };

  await kv.atomic()
    .set(userKey(userId), updated)
    .set(["approval-log", record.at, userId], record)
    .commit();
  return updated;
}

export function approveUser(kv: Deno.Kv, userId: string, adminId: string): Promise<User> {
  return decide(kv, userId, "approved", adminId);
}

export function rejectUser(
  kv: Deno.Kv,
  userId: string,
  adminId: string,
  reason?: string,
): Promise<User> {
  return decide(kv, userId, "rejected", adminId, reason);
}

export function suspendUser(
  kv: Deno.Kv,
  userId: string,
  adminId: string,
  reason?: string,
): Promise<User> {
  return decide(kv, userId, "suspended", adminId, reason);
}

export class NotAuthorizedError extends Error {
  constructor(userId: string, status: UserStatus | "unknown") {
    super(`Audio generation not authorized for user ${userId} (status: ${status})`);
    this.name = "NotAuthorizedError";
  }
}

/**
 * The single gate every synthesis path must pass. Throws for anything that is
 * not an approved user, so a missing check fails closed rather than open.
 */
export async function assertAuthorizedForAudio(kv: Deno.Kv, userId: string): Promise<User> {
  const user = await getUser(kv, userId);
  if (!user) throw new NotAuthorizedError(userId, "unknown");
  if (user.status !== "approved") throw new NotAuthorizedError(userId, user.status);
  return user;
}

export async function isAuthorizedForAudio(kv: Deno.Kv, userId: string): Promise<boolean> {
  try {
    await assertAuthorizedForAudio(kv, userId);
    return true;
  } catch {
    return false;
  }
}

/** Update a user's own listening preferences. Does not touch status. */
export async function updatePreferences(
  kv: Deno.Kv,
  userId: string,
  patch: { displayName?: string; voice?: string; feeds?: string[] },
): Promise<User> {
  const user = await getUser(kv, userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  const updated: User = {
    ...user,
    displayName: patch.displayName?.trim() || user.displayName,
    voice: patch.voice ?? user.voice,
    feeds: patch.feeds ?? user.feeds,
  };
  await kv.set(userKey(userId), updated);
  return updated;
}

/** Same-owner check: one user's feed is not another user's business. */
export function canReadUser(requestingUser: User, targetUserId: string): boolean {
  return requestingUser.isAdmin || requestingUser.id === targetUserId;
}
