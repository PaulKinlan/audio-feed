/**
 * The collections one `MemoryMetadataStore` owns (audio-feed-8r1e).
 *
 * They are created per store, never shared: every test builds its own adapter. Each collection
 * belongs to exactly one domain module; they are declared together here because a memory
 * adapter's state has to be reachable from the paths that cross entities — the article+episode
 * pair write (audio-feed-2th) needs the episode indexes from the article path.
 */
import type {
  ApprovalRecord,
  Article,
  AuthChallenge,
  Episode,
  OutboxNotification,
  PasskeyCredential,
  Session,
  SetupLink,
  Source,
  SynthesisSegmentRecord,
  User,
} from "../../types.ts";
import { type LogRecord, type RunRecord } from "../mod.ts";

export interface MemoryState {
  users: Map<string, User>;
  approvals: ApprovalRecord[];
  sources: Map<string, Source>;
  articles: Map<string, Article>;
  /** URL → article id, mirroring KV's `article_by_url` index (audio-feed-d8q). */
  articleByUrl: Map<string, string>;
  episodes: Map<string, Episode>;
  // Sorted indexes of pending and synthesizing episodes (audio-feed-7li)
  pendingIndex: { sortKey: string; userId: string; id: string }[];
  synthesizingIndex: { sortKey: string; userId: string; id: string }[];
  /** audio-feed-wr1u: persisted TTS segments per episode, keyed by slot (hash@version@voice). */
  segments: Map<string, Map<string, SynthesisSegmentRecord>>;
  orphanBlobs: Set<string>;
  // Operational stats (audio-feed-ndc). Single-threaded here, so a plain
  // counter is already atomic; the KV adapter needs `.sum()` for the same job.
  downloadTotal: number;
  downloadsByUser: Map<string, number>;
  synthesisTotal: number;
  synthesisTotalBytes: number;
  synthesisByUser: Map<string, { count: number; bytes: number }>;
  synthesisByUserAndDay: Map<string, number>;
  /** Paid episodes per UTC day across all subscribers (audio-feed-m182). */
  synthesisByDay: Map<string, number>;
  outbox: OutboxNotification[];
  runs: RunRecord[];
  /**
   * Structured log records, oldest first (audio-feed-wzv9). Single-threaded here, so a plain
   * counter is already the atomic sequence the KV adapter needs a compare-and-swap for.
   */
  logs: LogRecord[];
  logSeq: number;
  /** Keys committed with a detector warning; pruned with that warning's log record. */
  logOnce: Set<string>;
  /** The newest seq pruned, contiguously from the start. What `bounds()` reports from. */
  logWatermark: number;
  // Accounts (audio-feed-8fc).
  sessions: Map<string, Session>;
  credentials: Map<string, PasskeyCredential>;
  setupLinks: Map<string, SetupLink>;
  challenges: Map<string, AuthChallenge>;
}

/** Builds the state every domain repository takes. */
export function createMemoryState(): MemoryState {
  return {
    users: new Map<string, User>(),
    approvals: [],
    sources: new Map<string, Source>(),
    articles: new Map<string, Article>(),
    articleByUrl: new Map<string, string>(),
    episodes: new Map<string, Episode>(),
    pendingIndex: [],
    synthesizingIndex: [],
    segments: new Map<string, Map<string, SynthesisSegmentRecord>>(),
    orphanBlobs: new Set<string>(),
    downloadTotal: 0,
    downloadsByUser: new Map<string, number>(),
    synthesisTotal: 0,
    synthesisTotalBytes: 0,
    synthesisByUser: new Map<string, { count: number; bytes: number }>(),
    synthesisByUserAndDay: new Map<string, number>(),
    synthesisByDay: new Map<string, number>(),
    outbox: [],
    runs: [],
    logs: [],
    logSeq: 0,
    logOnce: new Set(),
    logWatermark: 0,
    sessions: new Map<string, Session>(),
    credentials: new Map<string, PasskeyCredential>(),
    setupLinks: new Map<string, SetupLink>(),
    challenges: new Map<string, AuthChallenge>(),
  };
}

// -- episodes -------------------------------------------------------------

export function writeEpisode(state: MemoryState, episode: Episode): void {
  const key = scoped(episode.userId, episode.id);
  const existing = state.episodes.get(key);
  if (existing) {
    removePendingPointer(state, existing);
    removeSortedIndex(state.synthesizingIndex, `${existing.createdAt}\u0000${existing.id}`);
  }
  if (episode.status === "pending") {
    insertSortedIndex(state.pendingIndex, {
      sortKey: pendingSortKey(episode),
      userId: episode.userId,
      id: episode.id,
    });
  } else if (episode.status === "synthesizing") {
    // The claim index keeps the plain date key: an in-flight job is not queued work, so it
    // has no priority segment (audio-feed-15e).
    insertSortedIndex(state.synthesizingIndex, {
      sortKey: `${episode.createdAt}\u0000${episode.id}`,
      userId: episode.userId,
      id: episode.id,
    });
  }
  state.episodes.set(key, structuredClone(episode));
}

/** Clear a pending pointer from the queue, whichever priority it was written under. */
export function removePendingPointer(state: MemoryState, episode: {
  createdAt: string;
  id: string;
  regenerating?: boolean;
}): void {
  const [newWork, regeneration] = pendingSortKeys(episode);
  removeSortedIndex(state.pendingIndex, newWork);
  removeSortedIndex(state.pendingIndex, regeneration);
}

/**
 * The pending-index sort keys for an episode's date — BOTH priorities, so a removal can never
 * miss the pointer it means to clear (audio-feed-15e). The leading segment is what makes new
 * work sort ahead of regenerations; see `pendingSortKey`.
 */
export function pendingSortKeys(episode: {
  createdAt: string;
  id: string;
  regenerating?: boolean;
}): [string, string] {
  return [
    `0\u0000${episode.createdAt}\u0000${episode.id}`,
    `1\u0000${episode.createdAt}\u0000${episode.id}`,
  ];
}

/** The one queue key an episode's pending pointer lives under, chosen by its flag. */
export function pendingSortKey(episode: {
  createdAt: string;
  id: string;
  regenerating?: boolean;
}): string {
  return episode.regenerating ? pendingSortKeys(episode)[1] : pendingSortKeys(episode)[0];
}

export function compareSortKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function binarySearchIndex(list: IndexEntry[], sortKey: string): number {
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const item = list[mid];
    if (!item) break;
    const cmp = compareSortKeys(item.sortKey, sortKey);
    if (cmp === 0) return mid;
    if (cmp < 0) low = mid + 1;
    else high = mid - 1;
  }
  return ~low;
}

export function insertSortedIndex(list: IndexEntry[], entry: IndexEntry): void {
  const idx = binarySearchIndex(list, entry.sortKey);
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.splice(~idx, 0, entry);
  }
}

export function removeSortedIndex(list: IndexEntry[], sortKey: string): void {
  const idx = binarySearchIndex(list, sortKey);
  if (idx >= 0) {
    list.splice(idx, 1);
  }
}

/** Oldest first, tie-broken by id: the passkey list order both adapters share. */
export function byCreatedThenId(
  a: Pick<PasskeyCredential, "createdAt" | "id">,
  b: Pick<PasskeyCredential, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Newest first, tie-broken by id so ordering is total and stable — episodes
 * minted in the same millisecond must not swap places between reads.
 */

export function byNewestFirst(a: EpisodeKey, b: EpisodeKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id.localeCompare(a.id);
}

export function byOldestFirst(a: Episode, b: Episode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** One slot per (text, prompt version, voice): drift opens a new slot, never a fight. */
export function slotKeyFor(
  slot: { textHash: string; promptVersion: string; voice: string },
): string {
  return `${slot.textHash}\u0000${slot.promptVersion}\u0000${slot.voice}`;
}

export function scoped(userId: string, id: string) {
  return `${userId}\u0000${id}`;
}

export interface IndexEntry {
  sortKey: string;
  userId: string;
  id: string;
}

/** The two fields that fully order an episode; an anchor cursor holds only these. */
export type EpisodeKey = Pick<Episode, "createdAt" | "id">;
