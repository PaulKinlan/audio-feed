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

export interface RelyingParty {
  /** e.g. `https://audio.example.com`. */
  origin: string;
  /** The origin's hostname. */
  rpID: string;
}

export function relyingParty(baseUrl: string): RelyingParty {
  const url = new URL(baseUrl);
  return { origin: url.origin, rpID: url.hostname };
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
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
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
      requireUserVerification: false,
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
    userVerification: "preferred",
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
      requireUserVerification: false,
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
