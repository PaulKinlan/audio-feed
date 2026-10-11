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
  assertEquals(redactRoutePath("/audio/user-1/episode-9/abc123.wav"), "/audio/:key");
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
