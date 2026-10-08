/**
 * Passkey (WebAuthn) ceremonies (audio-feed-8fc).
 *
 * Verification is `@simplewebauthn/server`, pinned in deno.json; this file only
 * decides which challenge, user, and setup link a response belongs to. Policy over
 * `MetadataStore`, like the rest of src/auth: nothing here touches `Deno.Kv`, and
 * nothing needs a filesystem (Deno Deploy).
 *
 * Challenges are stored, single use, and bound to their ceremony (`purpose`), so a
 * sign-in challenge cannot complete a registration, and a replayed response finds
 * its challenge already gone. The RP ID and expected origin come from
 * `resolveOrigin`, so they match what the browser was actually served on.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { MetadataStore } from "../storage/mod.ts";
import type { AuthChallenge, User } from "../types.ts";
import { base64url, hashSecret } from "./sessions.ts";

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const RP_NAME = "Audio Feed";

/** Every failure a ceremony can have. Routes answer 400 with a generic message. */
export class PasskeyError extends Error {
  /** 404 for a credential this site does not know, so the client can signal it. */
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = "PasskeyError";
  }
}

/**
 * Known public suffixes / platform eTLDs where multiple unrelated applications
 * reside under shared domains (audio-feed-1o2).
 *
 * NOTE: The primary, load-bearing security control in this codebase is that
 * relyingParty() strictly defaults rpID to the exact service hostname (e.g.
 * audio-feed.paulkinlan-ea.deno.net), preventing cross-app passkey clashes by default.
 * This public suffix check serves as defense-in-depth against explicit misconfigurations
 * or deployments directly onto a bare shared domain.
 *
 * Browsers consult the Public Suffix List (PSL) and reject WebAuthn RP IDs that match
 * a public suffix with a SecurityError DOMException.
 */
export const KNOWN_PUBLIC_SUFFIXES = new Set([
  // Cloud platform shared domains
  "deno.net",
  "deno.dev",
  "pages.dev",
  "workers.dev",
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "fly.dev",
  "onrender.com",
  "glitch.me",
  "herokuapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  // Common multi-part ccTLD public suffixes
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "ne.jp",
  "co.nz",
  "com.br",
  "co.in",
  "com.sg",
]);

/**
 * Check whether a hostname is a Public Suffix / eTLD (audio-feed-1o2).
 * WebAuthn spec §5.1.2 strictly forbids setting RP ID to an eTLD/Public Suffix.
 */
export function isPublicSuffix(hostname: string): boolean {
  const norm = hostname.toLowerCase().trim().replace(/^\.+|\.+$/g, "");
  if (!norm) return true;
  // IPv4 / IPv6 addresses are not public suffixes
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(norm) || norm.includes(":")) return false;
  // Localhost is valid for local development
  if (norm === "localhost" || norm.endsWith(".localhost")) return false;
  // Single label without dot (e.g. "com", "org", "net")
  if (!norm.includes(".")) return true;
  return KNOWN_PUBLIC_SUFFIXES.has(norm);
}

export interface RelyingParty {
  /** e.g. `https://audio.example.com`. */
  origin: string;
  /** The origin's exact hostname or an authorized registrable domain suffix. */
  rpID: string;
}

/**
 * Derive the WebAuthn Relying Party configuration (audio-feed-1o2).
 *
 * Scoping rules per web.dev/articles/webauthn-rp-id:
 * 1. Default: RP ID is strictly the exact hostname of baseUrl (e.g. audio-feed.paulkinlan-ea.deno.net)
 *    to prevent cross-app passkey clashes with other apps across *.paulkinlan-ea.deno.net.
 * 2. Guard: RP ID must NEVER be a Public Suffix / eTLD (e.g. deno.net, pages.dev, github.io),
 *    which causes browser SecurityError DOMExceptions.
 * 3. Configuration: An optional configured RP ID (WEBAUTHN_RP_ID) allows intentional
 *    custom domain pins (e.g. paulkinlan.com for audio-feed.paulkinlan.com), provided it is
 *    not a Public Suffix and is a valid suffix of the origin host.
 */
export function relyingParty(baseUrl: string, configuredRpId?: string): RelyingParty {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();

  let rpID: string;
  if (configuredRpId && configuredRpId.trim()) {
    rpID = configuredRpId.trim().toLowerCase();
    if (isPublicSuffix(rpID)) {
      throw new PasskeyError(
        `Configured WebAuthn RP ID cannot be a public suffix ("${rpID}").`,
      );
    }
    if (host !== rpID && !host.endsWith("." + rpID)) {
      throw new PasskeyError(
        `Configured WebAuthn RP ID "${rpID}" is not a valid suffix of origin host "${host}".`,
      );
    }
  } else {
    rpID = host;
    if (isPublicSuffix(rpID)) {
      throw new PasskeyError(
        `WebAuthn RP ID cannot be a public suffix ("${rpID}"). Deploy to a dedicated subdomain or configure WEBAUTHN_RP_ID.`,
      );
    }
  }

  return { origin: url.origin, rpID };
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The challenge a response claims to answer. Verified later by the library. */
function claimedChallenge(clientDataJSON: unknown): string {
  if (typeof clientDataJSON !== "string") throw new PasskeyError("Malformed response.");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(clientDataJSON)));
    if (typeof parsed?.challenge === "string" && parsed.challenge) return parsed.challenge;
  } catch {
    // fall through
  }
  throw new PasskeyError("Malformed response.");
}

async function takeChallenge(
  store: MetadataStore,
  challenge: string,
  purpose: AuthChallenge["purpose"],
): Promise<AuthChallenge> {
  const record = await store.consumeChallenge(challenge);
  if (!record || record.purpose !== purpose || !(Date.parse(record.expiresAt) > Date.now())) {
    throw new PasskeyError("This sign-in attempt expired. Try again.");
  }
  return record;
}

/**
 * Options for adding a passkey to `user`. `setupToken` is set when the ceremony
 * was started from a setup link: the link is consumed only when registration
 * succeeds, so a cancelled prompt does not burn it.
 */
export async function registrationOptions(
  store: MetadataStore,
  rp: RelyingParty,
  user: User,
  setupToken?: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await store.listCredentials(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.displayName,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    // audio-feed-9ho7: passkeys are the normal admin sign-in path, so the
    // authenticator must actually verify the human (biometric / PIN / screen
    // lock). `preferred` let a UV-less authenticator register, and the matching
    // `requireUserVerification: true` below is what refuses one.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await store.putChallenge({
    challenge: options.challenge,
    purpose: "register",
    userId: user.id,
    setupTokenHash: setupToken ? await hashSecret(setupToken) : undefined,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });
  return options;
}

/**
 * Verify a registration and store the credential. When the challenge came from a
 * setup link, the link is consumed here, after verification and before the
 * credential is stored: of two racing completions only one can hold it.
 */
export async function finishRegistration(
  store: MetadataStore,
  rp: RelyingParty,
  response: RegistrationResponseJSON,
): Promise<User> {
  const challenge = await takeChallenge(
    store,
    claimedChallenge(response?.response?.clientDataJSON),
    "register",
  );

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError("The passkey could not be verified.");
  }
  if (!verification.verified) throw new PasskeyError("The passkey could not be verified.");

  if (challenge.setupTokenHash) {
    const link = await store.consumeSetupLink(challenge.setupTokenHash);
    if (
      !link || link.userId !== challenge.userId || !(Date.parse(link.expiresAt) > Date.now())
    ) {
      throw new PasskeyError("This setup link has already been used or has expired.");
    }
  }

  const user = challenge.userId ? await store.getUser(challenge.userId) : null;
  if (!user) throw new PasskeyError("Unknown account.");

  const { credential, aaguid } = verification.registrationInfo;
  if (await store.getCredential(credential.id)) {
    throw new PasskeyError("That passkey is already registered.");
  }
  const now = new Date().toISOString();
  await store.putCredential({
    id: credential.id,
    userId: user.id,
    publicKey: base64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    name: `Passkey added ${now.slice(0, 10)}`,
    createdAt: now,
    aaguid: aaguid || undefined,
  });
  return user;
}

/** Options for signing in with any discoverable passkey on this site. */
export async function authenticationOptions(
  store: MetadataStore,
  rp: RelyingParty,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    // audio-feed-9ho7: see registrationOptions — UV is required, not preferred.
    userVerification: "required",
  });
  await store.putChallenge({
    challenge: options.challenge,
    purpose: "authenticate",
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });
  return options;
}

/** Verify a sign-in, advance the signature counter, and return the user. */
export async function finishAuthentication(
  store: MetadataStore,
  rp: RelyingParty,
  response: AuthenticationResponseJSON,
): Promise<User> {
  const challenge = await takeChallenge(
    store,
    claimedChallenge(response?.response?.clientDataJSON),
    "authenticate",
  );
  const credential = typeof response?.id === "string"
    ? await store.getCredential(response.id)
    : null;
  if (!credential) throw new PasskeyError("That passkey is not registered here.", 404);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: credential.id,
        publicKey: fromBase64url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports as AuthenticatorTransport[] | undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError("The passkey could not be verified.");
  }
  if (!verification.verified) throw new PasskeyError("The passkey could not be verified.");

  const user = await store.getUser(credential.userId);
  if (!user) throw new PasskeyError("Unknown account.");
  await store.putCredential({
    ...credential,
    counter: verification.authenticationInfo.newCounter,
    lastUsedAt: new Date().toISOString(),
  });
  return user;
}
