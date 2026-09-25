/**
 * RSS/Atom subscription and polling (audio-feed-2e5).
 *
 * Paul: "we should be able to subscribe to RSS feeds (as a user) and have them
 * converted to audio, not just single POST send a url." The Source model, its
 * store operations and the synthesis worker all existed; nothing turned a
 * subscribed feed into queued episodes.
 *
 * This module does that one job: fetch a feed, work out which items are new,
 * fetch and extract each new article, and queue a `pending` episode for it. The
 * queue is the contract with the worker — this code never synthesises anything
 * itself, so a slow provider cannot hold a synthesis slot and a poisoned item
 * cannot fail a poll.
 *
 * Deliberate decisions:
 *
 * - ONE episode per item, in the source's first mode. Queuing every configured
 *   mode would silently double the bill for a feed the user expected to cost one
 *   synthesis per article; a deep dive is something to ask for per article.
 * - Dedupe through `findArticleByUrl`, the store's existing hook, so a re-poll, a
 *   restart or a second isolate cannot queue the same article twice.
 * - Only the article's LINK is fetched for the body, with the item summary as a
 *   fallback: the feed's own description is often truncated, but fetching the
 *   article is what makes the audio worth listening to when it works.
 * - `lastPolledAt` is written even when items fail, so one broken article cannot
 *   make the poller retry the same feed forever.
 */
import { DOMParser } from "npm:linkedom@0.18.12";
import { type ExtractedArticle, fetchArticle, fetchFeedDocument } from "./url.ts";
import type { AppContext } from "../app.ts";
import { newArticleId, newEpisodeId } from "../ids.ts";
import {
  type Article,
  type AudioMode,
  DEFAULT_VOICES,
  type Episode,
  type Source,
} from "../types.ts";

export interface FeedItem {
  title: string;
  link: string;
  publishedAt?: string;
  summary?: string;
}

/** Feeds are XML, and linkedom must parse them as XML: in HTML mode `<link>` is a
 * void element, so an RSS item's URL silently becomes empty. */
export function parseFeedItems(xml: string, baseUrl: string): FeedItem[] {
  let document: Document;
  try {
    // "text/xml", not "application/xml": linkedom's types accept only text/xml
    // (and both were verified to parse RSS and Atom identically at runtime).
    document = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    return [];
  }
  const items: FeedItem[] = [];
  for (const node of Array.from(document.querySelectorAll("item, entry"))) {
    const title = childText(node, ["title"]) ?? "";
    const link = itemLink(node, baseUrl);
    if (!link) continue;
    const published = childText(node, ["pubdate", "published", "updated", "date", "dc:date"]);
    const summary = childText(node, [
      "description",
      "summary",
      "content",
      "content:encoded",
      "encoded",
    ]);
    items.push({
      title: title.trim() || link,
      link,
      publishedAt: toIsoDate(published),
      summary: summary?.trim() || undefined,
    });
  }
  return items;
}

/**
 * Child lookup by local name, case-insensitively.
 *
 * `querySelector` cannot be trusted here: Atom uses `<link href>` while RSS uses
 * `<link>text</link>`, and `content:encoded` carries a namespace prefix that a
 * plain selector may not match. Walking the children avoids all three traps.
 */
function childText(node: Element, names: string[]): string | null {
  for (const child of Array.from(node.childNodes)) {
    const element = child as Element;
    if (!element.nodeName) continue;
    const name = element.nodeName.toLowerCase();
    if (names.includes(name)) return element.textContent ?? "";
  }
  return null;
}

function itemLink(node: Element, baseUrl: string): string | null {
  let textLink: string | null = null;
  for (const child of Array.from(node.childNodes)) {
    const element = child as Element;
    if (!element.nodeName || element.nodeName.toLowerCase() !== "link") continue;
    const href = element.getAttribute?.("href");
    if (href) {
      const rel = (element.getAttribute("rel") ?? "alternate").toLowerCase();
      // Atom: prefer the alternate link; a self link is the feed, not the item.
      if (rel === "alternate") return absolutise(href, baseUrl);
      continue;
    }
    const text = (element.textContent ?? "").trim();
    if (text) textLink = text;
  }
  if (textLink) return absolutise(textLink, baseUrl);
  // Some feeds only carry a guid that happens to be a URL.
  const guid = childText(node, ["guid", "id"])?.trim();
  if (guid && /^https?:\/\//i.test(guid)) return guid;
  return null;
}

function absolutise(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/** Feed dates are RFC 822 (RSS) or ISO (Atom); anything unparseable is dropped. */
function toIsoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export interface PollDependencies {
  /** Test seam: injected transport for the feed document itself. */
  transport?: (url: URL, signal: AbortSignal) => Promise<Response>;
  /** Test seam: how an article body is obtained. Defaults to the real fetcher. */
  fetchArticle?: (url: string, signal?: AbortSignal) => Promise<ExtractedArticle>;
  signal?: AbortSignal;
  /** Items considered per poll, newest first. Bounds both work and spend. */
  maxItems?: number;
}

export interface PollResult {
  items: number;
  queued: number;
  skipped: number;
  failed: number;
  errors: string[];
}

const DEFAULT_MAX_ITEMS = 10;

/** Fetch a feed, queue an episode for each new item, and record the poll. */
export async function pollFeedSource(
  ctx: AppContext,
  source: Source,
  deps: PollDependencies = {},
): Promise<PollResult> {
  const result: PollResult = { items: 0, queued: 0, skipped: 0, failed: 0, errors: [] };
  if (!source.feedUrl) {
    result.errors.push("source has no feedUrl");
    return result;
  }

  let items: FeedItem[];
  try {
    items = (await loadFeedItems(source.feedUrl, deps)).slice(
      0,
      deps.maxItems ?? DEFAULT_MAX_ITEMS,
    );
  } catch (error) {
    result.errors.push(String((error as Error)?.message ?? error));
    // lastPolledAt still moves: a permanently broken feed must not be retried on
    // every tick forever.
    await ctx.stores.metadata.putSource({ ...source, lastPolledAt: new Date().toISOString() });
    return result;
  }

  await queueItems(ctx, source, items, deps, result);
  await ctx.stores.metadata.putSource({ ...source, lastPolledAt: new Date().toISOString() });
  return result;
}

/**
 * Fetch and parse a feed. Throws on an unreachable or non-feed URL, which is what
 * lets a NEW subscription be refused before anything is persisted, while an
 * existing one treats the same failure as a recorded poll error.
 */
async function loadFeedItems(feedUrl: string, deps: PollDependencies): Promise<FeedItem[]> {
  const document = await fetchFeedDocument(feedUrl, {
    transport: deps.transport,
    signal: deps.signal,
  });
  return parseFeedItems(document.xml, document.url);
}

/** Queue an episode per item that the store has not already seen. */
async function queueItems(
  ctx: AppContext,
  source: Source,
  items: FeedItem[],
  deps: PollDependencies,
  result: PollResult,
): Promise<void> {
  result.items = items.length;
  const mode: AudioMode = source.modes[0] ?? "direct";

  for (const item of items) {
    const existing = await ctx.stores.metadata.findArticleByUrl(source.userId, item.link);
    if (existing) {
      result.skipped++;
      continue;
    }
    try {
      const extracted = deps.fetchArticle
        ? await deps.fetchArticle(item.link, deps.signal)
        : await fetchArticle(item.link, { signal: deps.signal });

      // audio-feed-562: re-check after article extraction to avoid inserting duplicates
      // if another concurrent poll or manual trigger completed while fetching.
      const raced = await ctx.stores.metadata.findArticleByUrl(source.userId, item.link);
      if (raced) {
        result.skipped++;
        continue;
      }

      const now = new Date().toISOString();
      const articleId = newArticleId();
      const article: Article = {
        id: articleId,
        userId: source.userId,
        sourceId: source.id,
        url: item.link,
        title: item.title || extracted.title,
        // The feed's own metadata is often better than the page's.
        author: extracted.author ?? undefined,
        publishedAt: item.publishedAt ?? extracted.publishedAt ?? undefined,
        content: extracted.body,
        excerpt: extracted.lead || item.summary,
        ingestedAt: now,
      };
      await ctx.stores.metadata.putArticle(article);
      const episode: Episode = {
        id: newEpisodeId(),
        userId: source.userId,
        sourceId: source.id,
        sourceTitle: source.title,
        articleId,
        mode,
        // The worker picks this up; this module never synthesises.
        status: "pending",
        title: article.title,
        description: article.excerpt,
        createdAt: now,
      };
      await ctx.stores.metadata.putEpisode(episode);
      result.queued++;
    } catch (error) {
      // One unfetchable article must not fail the poll or the other items.
      result.failed++;
      if (result.errors.length < 3) {
        result.errors.push(`${item.link}: ${String((error as Error)?.message ?? error)}`);
      }
    }
  }
}

/** Stable, readable source id derived from the feed host, unique per user. */
export function sourceIdForFeed(feedUrl: string, taken: Set<string>): string {
  let base = "feed";
  try {
    base = new URL(feedUrl).hostname.replace(/^www\./, "").split(".")[0] ?? "feed";
  } catch {
    // Fall through with the generic id: the caller has already validated the URL.
  }
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "feed";
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Create a subscription and poll it once, so the first episodes appear now. */
export async function subscribeToFeed(
  ctx: AppContext,
  input: { userId: string; feedUrl: string; title?: string; modes?: AudioMode[] },
  deps: PollDependencies = {},
): Promise<{ source: Source; poll: PollResult }> {
  const existing = await ctx.stores.metadata.listSources(input.userId);
  const modes = input.modes?.length ? input.modes : (["direct"] as AudioMode[]);
  const source: Source = {
    id: sourceIdForFeed(input.feedUrl, new Set(existing.map((s) => s.id))),
    userId: input.userId,
    title: input.title?.trim() || new URL(input.feedUrl).hostname.replace(/^www\./, ""),
    feedUrl: input.feedUrl,
    siteUrl: (() => {
      try {
        return new URL(input.feedUrl).origin;
      } catch {
        return undefined;
      }
    })(),
    modes,
    voices: DEFAULT_VOICES,
    createdAt: new Date().toISOString(),
  };
  // Validate BEFORE persisting: a user who pastes an article URL or an unreachable
  // host should be told, not left with a dead subscription that silently never
  // produces audio. `feedUrl` is set on the source constructed just above.
  const items = await loadFeedItems(source.feedUrl!, deps);
  await ctx.stores.metadata.putSource(source);
  const result: PollResult = { items: 0, queued: 0, skipped: 0, failed: 0, errors: [] };
  await queueItems(ctx, source, items.slice(0, deps.maxItems ?? 5), deps, result);
  await ctx.stores.metadata.putSource({ ...source, lastPolledAt: new Date().toISOString() });
  return { source, poll: result };
}

export interface FeedPollOptions {
  /** Only sources not polled within this window are considered. */
  minIntervalMs?: number;
  batchSize?: number;
  maxItemsPerSource?: number;
  signal?: AbortSignal;
}

const DEFAULT_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Poll every source that is due, across all users.
 *
 * Due-ness is judged by `lastPolledAt`, so the loop is safe to run on an
 * interval and safe to run in more than one isolate: the worst case is a
 * duplicate poll, and dedupe by article URL means a duplicate poll queues
 * nothing new.
 */
export async function runFeedPollBatch(
  ctx: AppContext,
  deps: PollDependencies & FeedPollOptions = {},
): Promise<{ polled: number; queued: number; failed: number }> {
  const minInterval = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const batchSize = deps.batchSize ?? 5;
  const cutoff = Date.now() - minInterval;

  const users = await ctx.stores.metadata.listUsers();
  const due: Source[] = [];
  for (const user of users) {
    for (const source of await ctx.stores.metadata.listSources(user.id)) {
      if (!source.feedUrl) continue;
      const last = source.lastPolledAt ? Date.parse(source.lastPolledAt) : 0;
      if (!Number.isFinite(last) || last <= cutoff) due.push(source);
      if (due.length >= batchSize) break;
    }
    if (due.length >= batchSize) break;
  }

  let queued = 0;
  let failed = 0;
  for (const source of due) {
    const result = await pollFeedSource(ctx, source, {
      ...deps,
      maxItems: deps.maxItemsPerSource ?? DEFAULT_MAX_ITEMS,
    });
    queued += result.queued;
    failed += result.failed;
  }
  return { polled: due.length, queued, failed };
}

export interface FeedPollWorkerHandle {
  stop(): Promise<void>;
  runOnce(): ReturnType<typeof runFeedPollBatch>;
}

/**
 * Poll due feeds on an interval, for the process lifetime.
 *
 * Safe in more than one isolate: due-ness comes from `lastPolledAt` and a
 * duplicate poll queues nothing, because articles are deduplicated by URL. A
 * failing tick is logged and the loop continues — one dead feed must not stop
 * every other subscriber's feed.
 */
export function startFeedPollWorker(
  ctx: AppContext,
  options: FeedPollOptions & {
    onTick?: (result: { polled: number; queued: number; failed: number }) => void;
  } = {},
): FeedPollWorkerHandle {
  const intervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  // Ticking more often than the due window is pointless: due-ness is time-based.
  const tickMs = Math.max(60_000, Math.floor(intervalMs / 3));
  let stopped = false;
  let running: ReturnType<typeof runFeedPollBatch> | null = null;

  const runOnce = () => runFeedPollBatch(ctx, { ...options, minIntervalMs: intervalMs });
  const loop = async () => {
    while (!stopped && !options.signal?.aborted) {
      try {
        running = runOnce();
        const result = await running;
        if (result.polled) options.onTick?.(result);
      } catch (error) {
        console.error("[audio-feed] feed poll tick failed:", error);
      } finally {
        running = null;
      }
      if (stopped || options.signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, tickMs));
    }
  };
  void loop();

  return {
    async stop() {
      stopped = true;
      await running?.catch(() => {});
    },
    runOnce,
  };
}
