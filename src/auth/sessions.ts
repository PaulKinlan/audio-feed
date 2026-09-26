/**
 * Sessions, setup links and the same-origin rule (audio-feed-8fc).
 *
 * Policy over `MetadataStore`, like `users.ts`: nothing here touches `Deno.Kv`.
 *
 * - A session is a random secret in a `__Host-` cookie. The store holds only its
 *   SHA-256, so a store dump is not a list of live sessions. Expiry is checked on
 *   every read; an expired row is deleted when it is found.
 * - A setup link is a one-time enrolment/recovery secret an admin passes on. Also
 *   stored hashed, single use, 7 days. The secret rides in the URL FRAGMENT, which
 *   browsers never send to a server, so it cannot land in an access log or a
 *   Referer header.
 * - Every cookie-authenticated state change must pass `sameOrigin`. SameSite=Lax
 *   already withholds the cookie from cross-site POSTs; the Origin check is the
 *   second, explicit wall, and the one that also covers same-site subdomains.
 */

import type { MetadataStore } from "../storage/mod.ts";
import type { SetupLink, User } from "../types.ts";

export const SESSION_COOKIE = "__Host-af_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SETUP_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

/** Hex SHA-256. The only form in which a session or setup secret is stored. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url: 256 bits, cookie- and fragment-safe. */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a session for `userId`. Returns the cookie secret; only its hash is stored. */
export async function createSession(store: MetadataStore, userId: string): Promise<string> {
  const secret = newSecret();
  const now = Date.now();
  await store.putSession({
    idHash: await hashSecret(secret),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  return secret;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * The signed-in user, or `null`. Unknown, expired, and orphaned sessions all
 * resolve `null`; the caller never learns which.
 */
export async function sessionUser(store: MetadataStore, req: Request): Promise<User | null> {
  const secret = readCookie(req, SESSION_COOKIE);
  if (!secret) return null;
  const idHash = await hashSecret(secret);
  const session = await store.getSession(idHash);
  if (!session) return null;
  if (!(Date.parse(session.expiresAt) > Date.now())) {
    await store.deleteSession(idHash);
    return null;
  }
  return await store.getUser(session.userId);
}

/** Delete the session this request carries, if any. */
export async function endSession(store: MetadataStore, req: Request): Promise<void> {
  const secret = readCookie(req, SESSION_COOKIE);
  if (secret) await store.deleteSession(await hashSecret(secret));
}

/** `__Host-` requires Secure, Path=/ and no Domain; browsers treat localhost as secure. */
export function sessionCookie(secret: string): string {
  return `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${
    Math.floor(SESSION_TTL_MS / 1000)
  }`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The CSRF wall for cookie-authenticated state changes: the request's Origin must
 * be exactly the origin this service answers on. A missing Origin is refused, not
 * waved through: every browser that sends cookies on a POST also sends Origin.
 */
export function sameOrigin(req: Request, expectedOrigin: string): boolean {
  const origin = req.headers.get("origin");
  if (origin === expectedOrigin) return true;
  // A form POST from a page served with Referrer-Policy: no-referrer (account,
  // admin, login) carries `Origin: null`. Sec-Fetch-Site is set by the browser
  // and cannot be written by a page, so it settles those, and only those.
  return origin === "null" && req.headers.get("sec-fetch-site") === "same-origin";
}

/** Admin rights need the flag AND an approved account: suspending an admin demotes them. */
export function isActiveAdmin(user: User | null): boolean {
  return Boolean(user?.isAdmin && user.status === "approved");
}

/**
 * Issue a one-time setup link for `userId`. Returns the secret for the admin to
 * pass on; the store keeps only its hash.
 */
export async function issueSetupLink(
  store: MetadataStore,
  userId: string,
  issuedBy: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = newSecret();
  const now = Date.now();
  const expiresAt = new Date(now + SETUP_LINK_TTL_MS).toISOString();
  await store.putSetupLink({
    tokenHash: await hashSecret(token),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt,
    issuedBy,
  });
  return { token, expiresAt };
}

/** A live link for this token, or `null` for unknown, used, or expired. Does not consume. */
export async function peekSetupLink(
  store: MetadataStore,
  token: string,
): Promise<SetupLink | null> {
  if (!token) return null;
  const link = await store.getSetupLink(await hashSecret(token));
  if (!link || !(Date.parse(link.expiresAt) > Date.now())) return null;
  return link;
}
