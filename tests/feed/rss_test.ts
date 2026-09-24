/**
 * Feed generation tests.
 *
 * Deno ships no XML parser, so these assert on the emitted document plus
 * well-formedness invariants (balanced tags, escaped entities, no raw `&`).
 * A real browser parses the same fixtures in the lane's functional check.
 */
import {
  buildFeed,
  buildMasterFeed,
  buildSourceFeed,
  cdata,
  deepDiveFeedUrl,
  directFeedUrl,
  escapeXml,
  formatDuration,
  masterFeedUrl,
  sourceFeedUrl,
  toRfc2822,
} from "../../src/feed/rss.ts";
import type { Episode, FeedSource } from "../../src/feed/types.ts";

const source: FeedSource = {
  id: "stratechery",
  title: "Stratechery",
  link: "https://stratechery.com",
  imageUrl: "https://cdn.example.com/art.jpg",
};

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    guid: "ep-1",
    title: "The Aggregation Theory of Everything",
    pubDate: "2026-09-24T10:00:00Z",
    audioUrl: "https://cdn.example.com/ep-1.mp3",
    description: "A <b>deep</b> read & analysis",
    kind: "direct",
    sourceId: "stratechery",
    byteLength: 4_200_000,
    durationSeconds: 1875,
    ...overrides,
  };
}

/** Byte-level well-formedness: tags nest and balance, no bare `&` outside entities. */
function assertWellFormed(xml: string) {
  const stack: string[] = [];
  for (const match of xml.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)(?:\s[^>]*?)?(\/?)>/g)) {
    const [, closing, tag, selfClosed] = match;
    if (selfClosed || closing) {
      if (!closing) continue;
      const open = stack.pop();
      if (open !== tag) throw new Error(`Mismatched close </${tag}> for <${open}>`);
      continue;
    }
    if (tag) stack.push(tag);
  }
  if (stack.length) throw new Error(`Unclosed tags: ${stack.join(", ")}`);

  const withoutCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(withoutCdata)) {
    throw new Error("Unescaped ampersand in text");
  }
}

Deno.test("escapes XML control characters and entities", () => {
  if (
    escapeXml("a & b < c > d \" e ' f") !==
      "a &amp; b &lt; c &gt; d &quot; e &apos; f"
  ) {
    throw new Error(escapeXml("a & b < c > d \" e ' f"));
  }
  if (escapeXml("bad\u0000char\u001F") !== "badchar") throw new Error("control chars not stripped");
});

Deno.test("CDATA refuses to terminate early", () => {
  const out = cdata("closing ]]> sequence");
  if (out.startsWith("<![CDATA[") === false || out.endsWith("]]>") === false) {
    throw new Error(out);
  }
  // The literal text must survive a round trip through the two CDATA sections.
  if (out !== "<![CDATA[closing ]]]]><![CDATA[> sequence]]>") throw new Error(out);
  const decoded = [...out.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]).join("");
  if (decoded !== "closing ]]> sequence") throw new Error(decoded);
});

Deno.test("pubDate is RFC 2822 UTC", () => {
  if (toRfc2822("2026-09-24T10:00:00Z") !== "Thu, 24 Sep 2026 10:00:00 +0000") {
    throw new Error(toRfc2822("2026-09-24T10:00:00Z"));
  }
  // Offsets must be normalised, never dropped.
  if (toRfc2822("2026-09-24T12:00:00+02:00") !== "Thu, 24 Sep 2026 10:00:00 +0000") {
    throw new Error(toRfc2822("2026-09-24T12:00:00+02:00"));
  }
  let threw = false;
  try {
    toRfc2822("not a date");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("bad date should throw");
});

Deno.test("duration formats as HH:MM:SS", () => {
  if (formatDuration(1875) !== "00:31:15") throw new Error(formatDuration(1875));
  if (formatDuration(3661) !== "01:01:01") throw new Error(formatDuration(3661));
  if (formatDuration(-5) !== "00:00:00") throw new Error(formatDuration(-5));
});

Deno.test("feed URLs are the token-bearing routes the router serves", () => {
  const origin = "https://audio.example.com";
  const token = "capability-token";
  // These return router PATHS, not absolute URLs: the caller supplies its own
  // origin. One definition of the shape the router registers (audio-feed-tww).
  if (directFeedUrl(token, "stratechery") !== `/feed/${token}/stratechery/direct.xml`) {
    throw new Error(directFeedUrl(token, "stratechery"));
  }
  if (deepDiveFeedUrl(token, "stratechery") !== `/feed/${token}/stratechery/deepdive.xml`) {
    throw new Error(deepDiveFeedUrl(token, "stratechery"));
  }
  if (masterFeedUrl(token) !== `/feed/${token}/master.xml`) {
    throw new Error(masterFeedUrl(token));
  }
  // The mode-typed builder takes the same union the router's :mode uses, so a
  // misspelt mode cannot compile into a 404.
  if (
    sourceFeedUrl(token, "stratechery", "deepdive") !== `/feed/${token}/stratechery/deepdive.xml`
  ) {
    throw new Error(sourceFeedUrl(token, "stratechery", "deepdive"));
  }
  if (sourceFeedUrl(token, "stratechery", "direct") !== directFeedUrl(token, "stratechery")) {
    throw new Error("sourceFeedUrl and directFeedUrl must agree");
  }
  // A token must not be able to rewrite the route with path-significant characters.
  if (masterFeedUrl("a/../b") !== "/feed/a%2F..%2Fb/master.xml") {
    throw new Error(masterFeedUrl("a/../b"));
  }

  const master = buildMasterFeed({ origin, token, episodes: [episode()] });
  if (!master.includes(`<atom:link href="${origin}/feed/${token}/master.xml"`)) {
    throw new Error("the master self-link must carry the token");
  }
  // The self-link is what a client follows, so it must be the served route.
  const xml = buildSourceFeed({
    origin,
    token,
    source,
    kind: "direct",
    episodes: [episode()],
  });
  if (!xml.includes(`<atom:link href="${origin}/feed/${token}/stratechery/direct.xml"`)) {
    throw new Error("the per-source self-link must carry the token");
  }
});

Deno.test("per-source feed carries podcast enclosure and iTunes tags", () => {
  const xml = buildSourceFeed({
    origin: "https://audio.example.com",
    token: "tok",
    source,
    kind: "direct",
    episodes: [episode()],
    ownerEmail: "paul@example.com",
  });
  assertWellFormed(xml);

  const required = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"',
    "<title>Stratechery — Direct Read</title>",
    'href="https://audio.example.com/feed/tok/stratechery/direct.xml" rel="self"',
    '<guid isPermaLink="false">ep-1</guid>',
    "<pubDate>Thu, 24 Sep 2026 10:00:00 +0000</pubDate>",
    '<enclosure url="https://cdn.example.com/ep-1.mp3" length="4200000" type="audio/mpeg"/>',
    "<itunes:duration>00:31:15</itunes:duration>",
    "<itunes:explicit>false</itunes:explicit>",
    '<itunes:image href="https://cdn.example.com/art.jpg"/>',
    "<itunes:email>paul@example.com</itunes:email>",
  ];
  for (const needle of required) {
    if (!xml.includes(needle)) throw new Error(`missing: ${needle}`);
  }
  // HTML descriptions must survive as CDATA, unescaped.
  if (!xml.includes("<description><![CDATA[A <b>deep</b> read & analysis]]></description>")) {
    throw new Error("description CDATA missing");
  }
});

Deno.test("per-source feed excludes the other presentation mode", () => {
  const xml = buildSourceFeed({
    origin: "https://audio.example.com",
    token: "tok",
    source,
    kind: "deepdive",
    episodes: [
      episode(),
      episode({ guid: "ep-2", title: "Two voices", kind: "deepdive" }),
    ],
  });
  if (!xml.includes("ep-2")) throw new Error("deepdive episode missing from deepdive feed");
  if (xml.includes('<guid isPermaLink="false">ep-1</guid>')) {
    throw new Error("direct episode leaked into deepdive feed");
  }
  if (!xml.includes("<itunes:episodeType>bonus</itunes:episodeType>")) {
    throw new Error("deep dive should be typed bonus");
  }
});

Deno.test("per-source feeds never leak another source's episodes", () => {
  const other: FeedSource = { id: "changelog", title: "Changelog" };
  const shared: Episode[] = [
    episode({ guid: "strat-1", sourceId: "stratechery" }),
    episode({ guid: "change-1", sourceId: "changelog", title: "Deno 2" }),
    episode({ guid: "orphan-1", sourceId: undefined, title: "No source" }),
  ];

  for (const target of [source, other]) {
    for (const kind of ["direct", "deepdive"] as const) {
      const xml = buildSourceFeed({
        origin: "https://audio.example.com",
        token: "tok",
        source: target,
        kind,
        episodes: shared,
      });
      const leaked = shared.filter((episode) =>
        xml.includes(`>${episode.guid}<`) && episode.sourceId !== target.id
      );
      if (leaked.length) {
        throw new Error(
          `${target.id}/${kind} leaked: ${leaked.map((e) => e.guid).join(", ")}`,
        );
      }
      // A feed with no matching episodes is still valid, just empty.
      assertWellFormed(xml);
    }
  }
});

Deno.test("episodes are newest first and de-duplicated by guid", () => {
  const xml = buildSourceFeed({
    origin: "https://audio.example.com",
    token: "tok",
    source,
    kind: "direct",
    episodes: [
      episode({ guid: "old", pubDate: "2026-01-01T00:00:00Z" }),
      episode({ guid: "new", pubDate: "2026-09-01T00:00:00Z" }),
      episode({ guid: "new", pubDate: "2026-09-01T00:00:00Z" }),
    ],
  });
  if (xml.split("<item>").length - 1 !== 2) throw new Error("dedupe failed");
  if (xml.indexOf("new") > xml.indexOf("old")) throw new Error("not newest first");
});

Deno.test("master feed aggregates sources and attributes titles", () => {
  const other: FeedSource = { id: "other", title: "Other Blog" };
  const xml = buildMasterFeed({
    origin: "https://audio.example.com",
    token: "tok",
    sources: [source, other],
    episodes: [
      episode({ guid: "a", title: "Mine" }),
      episode({ guid: "b", title: "Theirs", sourceId: "other", kind: "deepdive" }),
      episode({ guid: "c", title: "Orphan", sourceId: undefined }),
    ],
  });
  assertWellFormed(xml);
  if (!xml.includes("<title>Stratechery: Mine</title>")) throw new Error("source prefix missing");
  if (!xml.includes("<title>Other Blog: Theirs</title>")) throw new Error("second source prefix");
  if (!xml.includes("<title>Orphan</title>")) {
    throw new Error("unknown source must keep bare title");
  }
  if (xml.split("<item>").length - 1 !== 3) throw new Error("master should carry all episodes");
});

Deno.test("well-formedness checker rejects broken XML", () => {
  let threw = false;
  try {
    assertWellFormed("<rss><channel></rss>");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("checker should reject mismatched tags");
});

Deno.test("feed stays well-formed with hostile article text", () => {
  const xml = buildFeed(
    {
      title: "Q&A: <script>alert(1)</script>",
      link: "https://audio.example.com",
      description: "R&D notes & ]] > tricks",
      selfUrl: "https://audio.example.com/feed/master.xml",
    },
    [episode({ title: "Ben & Jerry's <3", description: "5 > 3 && 2 < 4" })],
  );
  assertWellFormed(xml);
  if (xml.includes("<script>")) throw new Error("raw HTML leaked into channel title");
  if (!xml.includes("Ben &amp; Jerry&apos;s &lt;3")) throw new Error(xml);
  // A `]]>` in article text must not escape its CDATA section.
  const hostile = buildFeed(
    {
      title: "t",
      link: "https://audio.example.com",
      description: "d",
      selfUrl: "https://audio.example.com/feed/master.xml",
    },
    [episode({ description: 'sneaky ]]> <enclosure url="evil" length="1" type="x"/>' })],
  );
  assertWellFormed(hostile);
  // The evil tag must stay inert text inside CDATA, never become real markup.
  const markupOnly = hostile.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (markupOnly.includes('url="evil"')) throw new Error("description escaped its CDATA section");
  if (hostile.split('type="application/json+chapters"').length > 1) {
    throw new Error("injected element became markup");
  }
});
