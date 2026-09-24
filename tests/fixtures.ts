/**
 * Shared test fixtures. Lanes should build their test data from these so a
 * change to the domain model breaks one file, not twelve.
 */

import type { Article, AudioMode, Episode, Source, User } from "../src/types.ts";
import { DEFAULT_VOICES } from "../src/types.ts";

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "paul@example.com",
    name: "Paul",
    role: "user",
    status: "approved",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "stratechery",
    userId: "user-1",
    title: "Stratechery",
    feedUrl: "https://stratechery.com/feed/",
    siteUrl: "https://stratechery.com/",
    modes: ["direct", "deepdive"],
    voices: DEFAULT_VOICES,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: "article-1",
    userId: "user-1",
    sourceId: "stratechery",
    url: "https://stratechery.com/2026/an-article/",
    title: "An Article",
    author: "Ben Thompson",
    publishedAt: "2026-09-10T08:00:00.000Z",
    content: "Body text ready for synthesis.",
    excerpt: "Body text…",
    ingestedAt: "2026-09-10T08:05:00.000Z",
    ...overrides,
  };
}

export function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const mode: AudioMode = overrides.mode ?? "direct";
  return {
    id: "episode-1",
    userId: "user-1",
    sourceId: "stratechery",
    articleId: "article-1",
    mode,
    status: "ready",
    title: "An Article",
    description: "A read of An Article",
    audioKey: "audio/user-1/direct/episode-1.mp3",
    byteLength: 1024,
    durationSeconds: 300,
    contentType: "audio/mpeg",
    createdAt: "2026-09-10T08:10:00.000Z",
    readyAt: "2026-09-10T08:12:00.000Z",
    ...overrides,
  };
}

/** Deterministic bytes, so range assertions can check content not just length. */
export function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 256;
  return out;
}
