import { DEFAULT_NARRATION_VOICE } from "./tts/gemini.ts";

/**
 * Canonical domain model for audio-feed.
 *
 * This file is the shared contract between every lane. Changing a field here is
 * a cross-lane change: announce it to coord before editing, do not fork the
 * types into a lane-local file.
 *
 * Owned by: audio-feed-0h8 (server & storage skeleton).
 */

/** Audio presentation modes, per PRODUCT.md §1. */
export type AudioMode = "direct" | "deepdive";

/** How to handle code blocks in synthesized speech (audio-feed-bdo). */
export const CODE_HANDLINGS = ["skip", "explain"] as const;
export type CodeHandling = typeof CODE_HANDLINGS[number];
export const DEFAULT_CODE_HANDLING: CodeHandling = "skip";

export const AUDIO_MODES: readonly AudioMode[] = ["direct", "deepdive"] as const;

export function isAudioMode(value: unknown): value is AudioMode {
  return value === "direct" || value === "deepdive";
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * `pending` accounts must never trigger a Gemini synthesis call — that is the
 * whole point of the approval gate (audio-feed-7wn). `rejected` and `suspended`
 * are equally closed; only `approved` opens the gate.
 */
export type UserStatus = "pending" | "approved" | "rejected" | "suspended";

export const USER_STATUSES: readonly UserStatus[] = [
  "pending",
  "approved",
  "rejected",
  "suspended",
] as const;

export function isUserStatus(value: unknown): value is UserStatus {
  return USER_STATUSES.includes(value as UserStatus);
}

/**
 * A subscriber. Each user is its own listening persona.
 *
 * ONE definition, ONE owner of the `["user", id]` record (audio-feed-ruw).
 * Before this merge two modules wrote that key with different shapes and
 * silently dropped each other's fields — `isAdmin` disappearing is a privilege
 * bug, and `status` disappearing is an unauthorized-spend bug.
 */
export interface User {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: string;
  /**
   * Per-user feed capability.
   *
   * SECRET. Podcast clients cannot authenticate, so this token in the feed URL
   * is the only credential those requests carry — anyone holding it can read
   * the user's feed. Never put it in a response body, a log line, or an error
   * message; serialise `PublicUser` (see `redactUser`) instead.
   */
  feedToken: string;
  /**
   * Preferred TTS voice preset (Aoede, Charon, Fenrir, Kore, Puck).
   *
   * This IS the user-level default (audio-feed-4xt). It was not renamed to
   * `defaultVoice`: two names for one preference means two places for it to
   * disagree. Resolution order: source voice, then this, then config `DEFAULT_VOICE`,
   * then DEFAULT_NARRATION_VOICE.
   */
  voice?: string;
  /** Source ids this user subscribes to. */
  feeds?: string[];
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  /**
   * Optional daily ceiling on synthesised episodes (audio-feed-9mp).
   * Unset/undefined means unlimited.
   */
  dailyEpisodeBudget?: number;
}

/**
 * A user without its feed capability — the only user shape safe to serialise.
 *
 * Structural, not a convention: a `PublicUser` cannot carry `feedToken`, so
 * leaking it requires deliberately widening the type rather than forgetting a
 * `delete`.
 */
export type PublicUser = Omit<User, "feedToken">;

export function redactUser(user: User): PublicUser {
  const { feedToken: _feedToken, ...rest } = user;
  return rest;
}

/**
 * Canonical UTC calendar day window for daily budget tracking (audio-feed-9mp).
 * Formatted as "YYYY-MM-DD". Resets cleanly at 00:00:00.000Z.
 */
export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export interface SynthesisCounts {
  total: number;
  totalBytes: number;
  perUser: {
    userId: string;
    count: number;
    bytes: number;
    todayCount: number;
  }[];
}

/**
 * Outbox notification for on-demand article ingest completion (audio-feed-np5).
 * Consumable by chaos-relay or webhooks.
 */
export interface OutboxNotification {
  id: string;
  userId: string;
  episodeId: string;
  status: "ready" | "failed";
  title: string;
  playerUrl: string;
  error?: string;
  createdAt: string;
  deliveredAt?: string;
}

/** One admin decision. Written atomically with the user it decided. */
export interface ApprovalRecord {
  userId: string;
  /** A status decision, or `role` for an admin grant or revoke (audio-feed-8fc). */
  action: UserStatus | "role";
  adminId: string;
  at: string;
  reason?: string;
  /** Set on `role` records only. */
  fromRole?: "admin" | "user";
  toRole?: "admin" | "user";
}

/**
 * The only gate that authorizes paid synthesis work.
 *
 * Prefer the throwing `assertAuthorizedForAudio` on a synthesis path: a boolean
 * fails open the moment a caller forgets a `!`.
 */
export function isSynthesisAuthorized(user: User | null | undefined): boolean {
  return user?.status === "approved";
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Voice assignment for a source. Preset names per PRODUCT.md §2. */
/**
 * Voice assignment for a source.
 *
 * Both fields are OPTIONAL, and that is load-bearing (audio-feed-4xt). They were
 * required, and every source was stamped with DEFAULT_VOICES at creation, so a
 * `source.voices.direct ?? ...` chain could never fall through: the first term was
 * always a non-empty string and any system or user default was dead code that read
 * as configured. Absence has to be representable for a default to mean anything.
 * Resolution order lives in `createGeminiSynthesizer`.
 */
export interface VoiceConfig {
  /** Single narrator for `direct` mode. Unset means "resolve a default". */
  direct?: string;
  /** [expert, foil] pair for `deepdive` mode. Unset means "resolve a default". */
  deepdive?: [string, string];
}

/**
 * The VoiceConfig that every optional field falls back TO, so it is precisely the
 * one that must be COMPLETE - typed `Required`, not `VoiceConfig` (audio-feed-9cz).
 *
 * With the plain type, `deepdive` was optional here and the one reader in
 * `createGeminiSynthesizer` had to write `DEFAULT_VOICES.deepdive!` to satisfy it.
 * That `!` did not express a guarantee, it switched a compile-time check off: deleting
 * `deepdive` from this constant type-checked clean and failed at runtime as
 * "undefined is not iterable" from an array destructure, far from the cause.
 *
 * Measured both ways by audiofeed-opus and re-confirmed here: `Required` + no `!`
 * compiles and passes, and removing `deepdive` then fails at COMPILE time, which is
 * where a missing default belongs.
 */
export const DEFAULT_VOICES: Required<VoiceConfig> = {
  // One source of truth for the default narrator (audio-feed-uu3). This used to be a
  // second, independent `"Charon"` literal beside src/tts/gemini.ts's
  // DEFAULT_NARRATION_VOICE - and it had NO reader at all, so the two could drift and
  // nothing would notice: retuning DEFAULT_VOICES.direct left the whole suite green
  // (measured, audio-feed-8pt/9cz review). Deriving it makes agreement structural.
  //
  // Safe from a cycle: src/tts/gemini.ts contains no import statements and references
  // nothing in this file, so `types.ts -> tts/gemini.ts` is a one-way edge. Verified
  // rather than assumed, because this import was raised as a possible cycle and closed
  // by measurement.
  direct: DEFAULT_NARRATION_VOICE,
  deepdive: ["Kore", "Puck"],
};

export interface Source {
  id: string;
  userId: string;
  title: string;
  /** Absent for the synthetic per-user "Send to Audio" inbox source. */
  feedUrl?: string;
  siteUrl?: string;
  /** Which feeds this source publishes. */
  modes: AudioMode[];
  voices: VoiceConfig;
  /** How to handle code blocks in TTS generation (audio-feed-bdo). Defaults to "skip". */
  codeHandling?: CodeHandling;
  createdAt: string;
  lastPolledAt?: string;
  lastPollError?: string;
}

/** Stable id of the per-user inbox that `Send-to-Audio` ingests land in. */
export const INBOX_SOURCE_ID = "inbox";

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export interface Article {
  id: string;
  userId: string;
  sourceId: string;
  url: string;
  title: string;
  author?: string;
  /** ISO 8601 publication date from the source, when known. */
  publishedAt?: string;
  /** Clean, reader-mode text (markdown or plain) ready for TTS. */
  content: string;
  excerpt?: string;
  ingestedAt: string;
  /** Number of chunks stored in KV when content exceeds ARTICLE_CHUNK_SIZE (audio-feed-cei). */
  chunkCount?: number;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export type EpisodeStatus = "pending" | "synthesizing" | "ready" | "failed";

export interface Episode {
  id: string;
  userId: string;
  sourceId: string;
  /**
   * Title of the source at the time the episode was queued.
   * Preserves feed attribution even if the source is subsequently deleted (audio-feed-ap6).
   */
  sourceTitle?: string;
  articleId: string;
  mode: AudioMode;
  status: EpisodeStatus;
  title: string;
  description?: string;
  /** Blob store key; set once synthesis succeeds. */
  audioKey?: string;
  /** Enclosure length in bytes — RSS `<enclosure length>` requires it. */
  byteLength?: number;
  durationSeconds?: number;
  /** e.g. `audio/mpeg`. */
  contentType?: string;
  transcript?: string;
  /** Failure reason when `status === "failed"`. */
  error?: string;
  createdAt: string;
  readyAt?: string;
  /** Which prompts made the audio (src/tts/prompt_version.ts). Absent means made before 8oz. */
  promptVersion?: string;
  /**
   * Queued for re-synthesis with the current prompts (audio-feed-8oz). While set, the
   * episode is `pending`/`synthesizing` but still publishes its OLD audio; the worker
   * swaps in the new key atomically when it is ready.
   */
  regenerating?: boolean;

  /**
   * Worker lease (audio-feed-vfs / audio-feed-kiq).
   *
   * Set atomically as part of the `pending -> synthesizing` transition, so the
   * claim and the status can never disagree. Two things depend on it:
   *
   * - MUTUAL EXCLUSION: a worker that loses the compare-and-swap does not
   *   synthesise, so two isolates cannot bill the same episode twice.
   * - RECOVERY: `claimedAt` is what makes `synthesizing` a temporary state. A
   *   worker that dies mid-synthesis leaves a claim nobody will ever finish;
   *   once the lease expires the episode is claimable again instead of being
   *   stranded in a status the queue never looks at.
   */
  claimedAt?: string;
  /** Opaque worker identity. Diagnostic only — expiry is what grants a reclaim. */
  claimedBy?: string;
  /**
   * Claims taken so far, incremented as part of the claim itself.
   *
   * Persisted rather than counted in memory because the case that needs
   * bounding is the one an in-process counter cannot see: an input that kills
   * the isolate is re-claimed by the next worker with a fresh counter, and a
   * poison job that crashes its host would otherwise be re-billed forever.
   */
  attempts?: number;
}

/**
 * How long a worker may hold an episode before another may take it over.
 *
 * Sized against the LONGEST plausible synthesis, not the average. If a lease
 * expires while the first worker is still spending, a second worker takes the
 * claim mid-call and both pay — which is audio-feed-vfs again, arriving by a
 * different route. A short article measured ~10s, but a two-voice deep dive on
 * a long article is minutes, and that is the number that matters.
 *
 * The asymmetry decides it: too long merely delays a retry after a crash; too
 * short bills twice. So err long.
 */
export const DEFAULT_CLAIM_LEASE_MS = 15 * 60_000;

/**
 * Claims allowed before an episode is abandoned as unprocessable.
 *
 * Lease-expiry recovery without a bound is a perpetual motion machine for a
 * poison job: crash, expire, re-claim, crash, bill again.
 */
export const DEFAULT_MAX_CLAIMS = 3;

/**
 * Whether an existing claim may be taken over.
 *
 * A `synthesizing` episode with NO `claimedAt` is treated as expired on
 * purpose: records written before leases existed are exactly the stranded ones
 * this is meant to rescue, and refusing to reclaim them would leave every
 * already-stuck episode stuck forever.
 */
export function isClaimExpired(
  episode: Pick<Episode, "claimedAt">,
  nowMs: number,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): boolean {
  if (!episode.claimedAt) return true;
  const claimedAtMs = Date.parse(episode.claimedAt);
  if (!Number.isFinite(claimedAtMs)) return true;
  return nowMs - claimedAtMs >= leaseMs;
}

/**
 * An episode is publishable in a feed only when it has playable audio. A regenerating
 * episode keeps publishing its old audio until the new audio replaces it (audio-feed-8oz).
 */
export function isPublishable(
  episode: Episode,
): episode is Episode & { audioKey: string; contentType: string } {
  const live = episode.status === "ready" ||
    (!!episode.regenerating &&
      (episode.status === "pending" || episode.status === "synthesizing"));
  return live && !!episode.audioKey && !!episode.contentType;
}

/**
 * The record to write when a claimed synthesis ends without new audio: `failed` for a
 * first synthesis, but back to `ready` on the old audio for a regeneration, so a
 * failed or abandoned regeneration never takes a playable episode out of the feed.
 * Claim fields are left to the caller.
 */
export function unsynthesized(episode: Episode, error: string): Episode {
  if (episode.regenerating && episode.audioKey && episode.contentType) {
    return { ...episode, status: "ready", regenerating: undefined, error };
  }
  return { ...episode, status: "failed", error };
}

/**
 * Canonical blob key for an episode's audio. Every lane must use this helper so
 * keys stay predictable across adapters.
 *
 * `revision` gives regenerated audio a NEW key (audio-feed-8oz): /audio is served
 * `immutable`, so reusing a key would leave caches serving the old bytes forever.
 */
export function audioBlobKey(
  episode: Pick<Episode, "userId" | "id" | "mode">,
  ext = "mp3",
  revision?: string,
) {
  const name = revision ? `${episode.id}-${revision}` : episode.id;
  return `audio/${episode.userId}/${episode.mode}/${name}.${ext}`;
}

/**
 * One persisted TTS segment of an episode's synthesis (audio-feed-wr1u).
 *
 * A long episode is several paid TTS calls. gueb made a run that would outlive its
 * claim lease stop cleanly instead of re-billing the whole episode; this record is what
 * lets the NEXT claim pick up where the dead one stopped: each completed segment's audio
 * is stored under its own blob key and described here, keyed by the hash of the exact
 * text it speaks, so a re-split (a breath boundary moving, an article edit landing
 * between attempts) never reuses audio for different words.
 *
 * Lifecycle: `reserve` (claim-conditional CAS, before the paid call) -> `finalize`
 * (claim-conditional, after the blob write) -> reused by any later claim whose split
 * produces the same text at the same prompt version and voice -> deleted with its blobs
 * once the episode's stitched audio is committed. A reservation whose claim lease
 * expired is stealable, exactly like the episode claim itself.
 */
export interface SynthesisSegmentRecord {
  /** Stable id of the segment text: FNV-1a hex of the UTF-8 bytes. */
  textHash: string;
  /** The exact segment text, kept so a reuse can be eyeballed and seam-checked. */
  text: string;
  /** Segments are only reusable for the same prompt generation (see PROMPT_VERSION). */
  promptVersion: string;
  /** The voice that spoke it; a voice change must not reuse another voice's audio. */
  voice: string;
  /** Blob key holding this segment's WAV bytes. Empty until finalized. */
  audioKey: string;
  byteLength: number;
  /** Worker identity that reserved/finalized it; the CAS compares this. */
  owner: string;
  /** ISO instant of the claim under which it was reserved. */
  claimAt: string;
  createdAt: string;
  /** Reserved = paid call in flight or done but not yet blob-written. */
  finalized: boolean;
}

/** Blob key for one persisted synthesis segment. Per-attempt, like episode audio. */
export function segmentBlobKey(
  episode: Pick<Episode, "userId" | "id">,
  textHash: string,
  revision: string,
) {
  return `audio-segments/${episode.userId}/${episode.id}/${textHash}-${revision}.wav`;
}

/**
 * Stable, collision-cheap id for a segment text. Not a security boundary — an identity
 * for reuse — so a fast non-cryptographic hash over the exact UTF-8 bytes is enough, and
 * the record keeps the text itself for seam checks.
 */
export function segmentTextHash(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // FNV-1a 64-bit over the exact UTF-8 bytes, xor-folded to 64 bits of hex.
  let h = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const folded = (h ^ (h >> 32n)) & 0xffffffffffffffffn;
  return folded.toString(16).padStart(16, "0");
}

// ---------------------------------------------------------------------------
// Accounts: sessions, passkeys, setup links (audio-feed-8fc)
// ---------------------------------------------------------------------------

/**
 * A signed-in browser. Keyed by the SHA-256 of the cookie value, never the value
 * itself: a leaked store dump must not be a list of live sessions.
 */
export interface Session {
  /** Hex SHA-256 of the cookie secret. */
  idHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** A registered WebAuthn credential. Public material only. */
export interface PasskeyCredential {
  /** base64url credential id, as the authenticator reports it. */
  id: string;
  userId: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports?: string[];
  /** A human label, e.g. "Added 2026-09-26". */
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Authenticator Attestation GUID (RFC 4122 UUID, audio-feed-25t). */
  aaguid?: string;
}

/**
 * A one-time enrolment or recovery link issued by an admin. Stored by the hash of
 * its token; the token itself exists only in the URL the admin passes on.
 */
export interface SetupLink {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  issuedBy: string;
}

/**
 * A WebAuthn challenge awaiting its response. Single use and short-lived.
 * `purpose` binds it to the ceremony that minted it, so a sign-in challenge cannot
 * complete a registration.
 */
export interface AuthChallenge {
  challenge: string;
  purpose: "register" | "authenticate";
  /** Registration only: who the new credential belongs to. */
  userId?: string;
  /** Registration by setup link: the link consumed when the ceremony completes. */
  setupTokenHash?: string;
  expiresAt: string;
}
