/**
 * Write the three feed shapes to a directory so they can be served and parsed
 * by a real podcast client / browser.
 *
 *   deno run -A scripts/gen-fixtures.ts /tmp/audiofeed-fixtures
 *
 * Verification helper, not part of the server.
 */
import { buildMasterFeed, buildSourceFeed } from "../src/feed/rss.ts";
import type { Episode, FeedSource } from "../src/feed/types.ts";

const outDir = Deno.args[0] ?? "/tmp/audiofeed-fixtures";
const ORIGIN = Deno.env.get("ORIGIN") ?? "http://localhost:8787";
/** The capability a subscriber would use; fixtures are served, not authenticated. */
const TOKEN = Deno.env.get("FEED_TOKEN") ?? "local-dev-token";

const sources: FeedSource[] = [
  {
    id: "stratechery",
    title: "Stratechery",
    link: "https://stratechery.com",
    imageUrl: `${ORIGIN}/art/stratechery.jpg`,
  },
  {
    id: "changelog",
    title: "Changelog",
    link: "https://changelog.com",
    imageUrl: `${ORIGIN}/art/changelog.jpg`,
  },
];

const episodes: Episode[] = [
  {
    guid: "stratechery-2026-09-24-aggregation",
    title: "The Aggregation Theory of Everything",
    pubDate: "2026-09-24T10:00:00Z",
    audioUrl: `${ORIGIN}/audio/stratechery-2026-09-24.mp3`,
    description: "Ben reads <b>Aggregation Theory</b> & what it means for AI.",
    kind: "direct",
    sourceId: "stratechery",
    link: "https://stratechery.com/2026/aggregation",
    byteLength: 4_200_000,
    durationSeconds: 1875,
    episodeNumber: 12,
  },
  {
    guid: "stratechery-2026-09-24-deepdive",
    title: "Deep Dive: Who Captures the Value?",
    pubDate: "2026-09-24T11:00:00Z",
    audioUrl: `${ORIGIN}/audio/stratechery-2026-09-24-deepdive.mp3`,
    description: "Two-voice discussion with counter-arguments from the ecosystem.",
    kind: "deepdive",
    sourceId: "stratechery",
    byteLength: 8_100_000,
    durationSeconds: 3610,
    chaptersUrl: `${ORIGIN}/chapters/stratechery-2026-09-24-deepdive.json`,
  },
  {
    guid: "changelog-2026-09-23-deno",
    title: "Deno 2 in Production",
    pubDate: "2026-09-23T18:30:00Z",
    audioUrl: `${ORIGIN}/audio/changelog-2026-09-23.mp3`,
    description: "Runtime notes & benchmarks.",
    kind: "direct",
    sourceId: "changelog",
    byteLength: 2_100_000,
    durationSeconds: 1500,
  },
];

await Deno.mkdir(`${outDir}/feed/stratechery`, { recursive: true });
await Deno.mkdir(`${outDir}/feed/changelog`, { recursive: true });

for (const source of sources) {
  for (const kind of ["direct", "deepdive"] as const) {
    const file = `${outDir}/feed/${source.id}/${kind}.xml`;
    await Deno.writeTextFile(
      file,
      buildSourceFeed({
        origin: ORIGIN,
        token: TOKEN,
        source,
        kind,
        episodes,
        ownerEmail: "paul@example.com",
      }),
    );
    console.log(`wrote ${file}`);
  }
}

await Deno.writeTextFile(
  `${outDir}/feed/master.xml`,
  buildMasterFeed({
    origin: ORIGIN,
    token: TOKEN,
    sources,
    episodes,
    title: "Audio Feed",
    ownerEmail: "paul@example.com",
    imageUrl: `${ORIGIN}/art/master.jpg`,
  }),
);
console.log(`wrote ${outDir}/feed/master.xml`);
