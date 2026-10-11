/**
 * Request paths are where this codebase carries capabilities with no field name attached
 * (audio-feed-wzv9).
 *
 * `/listen/<feedToken>` opens a subscriber's private feed, `/audio/<key>` is the enclosure and
 * `/feed/<token>/master.xml` is what a podcast client holds. The store redacts by FIELD NAME, so
 * none of that protection reaches a token sitting in a path — which is why the path is turned into
 * a label before it ever becomes a field, and why these cases exist.
 */

import { assertEquals } from "@std/assert";
import { isHighVolumeAssetPath, redactRoutePath } from "../src/log.ts";

Deno.test("a feed token in a path never reaches the log (audio-feed-wzv9)", () => {
  const token = "kR7fQ2mZ8pLx4Vn1Tb6Ys3Wd"; // capability-shaped, as a real one is
  assertEquals(redactRoutePath(`/listen/${token}`), "/listen/:token");
  assertEquals(redactRoutePath(`/feed/${token}/master.xml`), "/feed/:token/master.xml");
  assertEquals(redactRoutePath(`/feed/${token}`), "/feed/:token");
  // The enclosure key is a capability too: /audio/:key+ is what an authorized fetch presents.
  // Everything after the capability position is redacted too, so the label keeps the route's depth
  // without keeping any of its content.
  assertEquals(
    redactRoutePath("/audio/user-1/episode-9/abc123.wav"),
    "/audio/:key/:redacted/:redacted",
  );
});

Deno.test("a query string is never logged, whatever it holds (audio-feed-wzv9)", () => {
  // Query strings are where a token ends up when nobody was thinking about it.
  assertEquals(redactRoutePath("/account?token=secret-value"), "/account");
  assertEquals(redactRoutePath("/api/request-access?key=abc&code=def"), "/api/request-access");
});

Deno.test("an ordinary route is recorded as itself (audio-feed-wzv9)", () => {
  assertEquals(redactRoutePath("/account"), "/account");
  assertEquals(redactRoutePath("/admin/synthesis"), "/admin/synthesis");
  assertEquals(redactRoutePath("/"), "/");
});

Deno.test("an unrecognised path cannot smuggle a token through (audio-feed-wzv9)", () => {
  // Belt and braces for the routes that do not exist yet: anything long and uniform enough to be a
  // capability is replaced even when the shape is unknown to this function.
  assertEquals(
    redactRoutePath("/something/kR7fQ2mZ8pLx4Vn1Tb6Ys3Wd/rest"),
    "/something/:redacted/rest",
  );
  // A word is not a token: a short segment is left alone so routes stay readable.
  assertEquals(redactRoutePath("/episodes/latest"), "/episodes/latest");
});

Deno.test("high-volume asset successes are identified so they can be left out (audio-feed-wzv9)", () => {
  // Podcast clients hammer these; a log write per enclosure fetch would be cost with no diagnosis.
  assertEquals(isHighVolumeAssetPath("/audio/user/ep/seg.wav"), true);
  assertEquals(isHighVolumeAssetPath("/assets/abc123.js"), true);
  assertEquals(isHighVolumeAssetPath("/icon.svg"), true);
  assertEquals(isHighVolumeAssetPath("/manifest.json"), true);
  // Anything a person or an agent drives is recorded, and every failure is recorded regardless.
  assertEquals(isHighVolumeAssetPath("/account"), false);
  assertEquals(isHighVolumeAssetPath("/listen"), false);
  assertEquals(isHighVolumeAssetPath("/admin"), false);
});

Deno.test("every malformed shape of a capability path is redacted (audio-feed-pwu4)", () => {
  // The finding: an exact-shape match let `GET /feed/<token>/master.xml/<token>` store the token,
  // because the matched branch copied its remaining segments through. Each case below is a shape
  // that broke the old version or was named in the finding as one that must not.
  const token = "kR7fQ2mZ8pLx4Vn1Tb6Ys3Wd";
  const cases: [input: string, expected: string][] = [
    [`/feed/${token}/master.xml/${token}`, "/feed/:token/master.xml/:redacted"],
    [`/listen/${token}/extra`, "/listen/:token/:redacted"],
    [`/audio/${token}/foo/bar`, "/audio/:key/:redacted/:redacted"],
    [`/feed//${token}//master.xml`, "/feed/:token/master.xml"],
    [`/feed/${token}/master.xml?dl=1&token=${token}`, "/feed/:token/master.xml"],
    [`/${token}/anything`, "/:redacted/anything"],
    // Percent-encoded: the router decodes, so a redaction that judged the raw text judged a
    // different path than the one being served.
    [`/feed/${encodeURIComponent(token)}/master.xml`, "/feed/:token/master.xml"],
    [`/feed/a%2Fb/master.xml`, "/feed/:token/:redacted/master.xml"],
    [`/listen/${token}%2Fextra`, "/listen/:token/:redacted"],
    // A token short enough to survive a "looks random" test: the position decides, not the shape.
    ["/feed/abc/master.xml", "/feed/:token/master.xml"],
    ["/listen/abc", "/listen/:token"],
  ];
  for (const [input, expected] of cases) {
    const actual = redactRoutePath(input);
    assertEquals(actual, expected, `redacting ${input}`);
    // The property that actually matters, asserted per case rather than assumed from the shape.
    assertEquals(actual.includes(token), false, `${input} must not retain the token`);
  }
});

Deno.test("NO capability reaches any stored record, in the whole serialised store (audio-feed-pwu4)", async () => {
  // The reviewer's assertion, at the level the store is actually read at: not "the route field
  // looks right" but "the bytes a reader would receive contain no capability anywhere". The record
  // is built the way src/server.ts builds it, including the message, which is the second place the
  // leaked token appeared.
  const { MemoryMetadataStore } = await import("../src/storage/memory.ts");
  const store = new MemoryMetadataStore();
  const token = "kR7fQ2mZ8pLx4Vn1Tb6Ys3Wd";
  const paths = [
    `/feed/${token}/master.xml/${token}`,
    `/listen/${token}/extra?next=${token}`,
    `/audio/${token}/x/y`,
    `/feed/${token}%2Fmore`,
    `/${token}`,
  ];

  for (const path of paths) {
    const route = redactRoutePath(path);
    const status = 404;
    await store.appendLog({
      time: new Date().toISOString(),
      severity: "warn",
      type: "http.request",
      message: `GET ${route} -> ${status}`,
      process: "app",
      correlationId: "corr-1",
      route,
      context: { method: "GET", status },
    });
  }

  const serialised = JSON.stringify(await store.listLogs());
  assertEquals(serialised.includes(token), false, `no record may contain the capability`);
  assertEquals(serialised.includes(encodeURIComponent(token)), false, "nor its encoded form");
  // And the records are still useful: a reader can see which route was hit.
  const records = await store.listLogs();
  assertEquals(records[0]?.route, "/feed/:token/master.xml/:redacted");
});
