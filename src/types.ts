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
  /** Preferred TTS voice preset (Aoede, Charon, Fenrir, Kore, Puck). */
  voice?: string;
  /** Source ids this user subscribes to. */
  feeds?: string[];
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
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

/** One admin decision. Written atomically with the user it decided. */
export interface ApprovalRecord {
  userId: string;
  action: UserStatus;
  adminId: string;
  at: string;
  reason?: string;
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
export interface VoiceConfig {
  /** Single narrator for `direct` mode. */
  direct: string;
  /** [expert, foil] pair for `deepdive` mode. */
  deepdive: [string, string];
}

export const DEFAULT_VOICES: VoiceConfig = {
  direct: "Charon",
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
  createdAt: string;
  lastPolledAt?: string;
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
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export type EpisodeStatus = "pending" | "synthesizing" | "ready" | "failed";

export interface Chapter {
  /** Offset from the start of the audio, in seconds. */
  startSeconds: number;
  title: string;
}

export interface Episode {
  id: string;
  userId: string;
  sourceId: string;
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
  chapters?: Chapter[];
  transcript?: string;
  /** Failure reason when `status === "failed"`. */
  error?: string;
  createdAt: string;
  readyAt?: string;

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

/** An episode is publishable in a feed only when it has playable audio. */
export function isPublishable(
  episode: Episode,
): episode is Episode & { audioKey: string; contentType: string } {
  return episode.status === "ready" && !!episode.audioKey && !!episode.contentType;
}

/**
 * Canonical blob key for an episode's audio. Every lane must use this helper so
 * keys stay predictable across adapters.
 */
export function audioBlobKey(episode: Pick<Episode, "userId" | "id" | "mode">, ext = "mp3") {
  return `audio/${episode.userId}/${episode.mode}/${episode.id}.${ext}`;
}
