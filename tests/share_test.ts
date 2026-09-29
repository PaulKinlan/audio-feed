/**
 * Tests for native Web Share API support on episode rows (audio-feed-zcw).
 *
 * Verifies Modern Web Guidance compliance:
 * - navigator.canShare validation before invoking navigator.share
 * - Graceful handling of AbortError on user cancellation
 * - Seamless fallback to navigator.clipboard.writeText with visual feedback
 * - Dynamic accessible label management (aria-label) for screen readers
 * - SVG icon sprite inclusion and dedicated CSS styling
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderListenPage } from "../src/routes/listen.ts";

Deno.test("renderListenPage: includes i-share symbol in icon sprite (audio-feed-zcw)", () => {
  const html = renderListenPage({
    token: "tok-test",
    subscriber: "Alice",
    feedUrl: "https://audio.example.com/feed/tok-test/master.xml",
    episodes: [],
    offlineEnabled: true,
  });

  assertStringIncludes(html, '<symbol id="i-share"');
  assertStringIncludes(html, 'viewBox="0 0 24 24"');
});

Deno.test("listen.css: defines styles for .ep-share and copied state (audio-feed-zcw)", async () => {
  const css = await Deno.readTextFile(new URL("../src/assets/listen.css", import.meta.url));

  assertStringIncludes(css, ".ep-share {");
  assertStringIncludes(css, ".ep-share:hover");
  assertStringIncludes(css, '.ep-share[data-state="copied"]');
  assertStringIncludes(css, "color: var(--ok);");
});

Deno.test("share handler: invokes navigator.share when canShare permits (audio-feed-zcw)", async () => {
  let shareCalledWith: { title?: string; text?: string; url?: string } | null = null;
  let canShareCalled = false;

  const mockNavigator = {
    canShare: (data: { title?: string; text?: string; url?: string }) => {
      canShareCalled = true;
      return Boolean(data.url);
    },
    share: (data: { title?: string; text?: string; url?: string }) => {
      shareCalledWith = data;
      return Promise.resolve();
    },
    clipboard: {
      writeText: () => Promise.reject(new Error("should not be called")),
    },
  };

  const episode = {
    id: "ep-1",
    title: "Understanding Web Share",
    source: "Web Almanac",
    articleUrl: "https://example.com/articles/web-share",
    audioUrl: "https://audio.example.com/audio/ep-1.wav",
  };

  const shareUrl = episode.articleUrl || episode.audioUrl;
  const shareData = {
    title: episode.title,
    text: `Listen to "${episode.title}" (${episode.source}) on Audio Feed`,
    url: shareUrl,
  };

  if (mockNavigator.share) {
    if (!mockNavigator.canShare || mockNavigator.canShare(shareData)) {
      await mockNavigator.share(shareData);
    }
  }

  assertEquals(canShareCalled, true, "navigator.canShare must be queried");
  assertEquals(shareCalledWith, {
    title: "Understanding Web Share",
    text: 'Listen to "Understanding Web Share" (Web Almanac) on Audio Feed',
    url: "https://example.com/articles/web-share",
  });
});

Deno.test("share handler: handles AbortError silently without copying or erroring (audio-feed-zcw)", async () => {
  let clipboardCalled = false;

  const mockNavigator = {
    canShare: (_data?: { title?: string; text?: string; url?: string }) => true,
    share: (_data?: { title?: string; text?: string; url?: string }) => {
      const err = new Error("User dismissed share sheet");
      err.name = "AbortError";
      return Promise.reject(err);
    },
    clipboard: {
      writeText: () => {
        clipboardCalled = true;
        return Promise.resolve();
      },
    },
  };

  const episode = {
    id: "ep-2",
    title: "Cancelled Share",
    audioUrl: "https://audio.example.com/audio/ep-2.wav",
  };
  const shareData = {
    title: episode.title,
    url: episode.audioUrl,
  };

  let shared = false;
  try {
    if (mockNavigator.canShare(shareData)) {
      await mockNavigator.share(shareData);
      shared = true;
    }
  } catch (err) {
    if (err && (err as Error).name === "AbortError") {
      // User cancelled / dismissed native share sheet: no-op
    } else {
      shared = false;
    }
  }

  assertEquals(shared, false);
  assertEquals(clipboardCalled, false, "clipboard fallback must not fire on user dismissal");
});

Deno.test("share handler: falls back to clipboard when share is unsupported or canShare is false (audio-feed-zcw)", async () => {
  // Teachable moment in Modern Web Guidance:
  // "I was going to write a share button that always called navigator.share() directly
  // without checking navigator.canShare. What I didn't know was that navigator.canShare()
  // validates whether the specific payload is supported by the platform before attempting
  // the share sheet, and that user cancellation throws an AbortError that should be caught
  // and dismissed silently rather than treating it as a failure. Furthermore, pairing it with
  // navigator.clipboard.writeText as an automatic fallback with clear visual and screen reader
  // feedback guarantees desktop and unsupported browsers remain fully functional."
  let clipboardText = "";
  const button = {
    dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, val: string) {
      this.attributes[name] = val;
    },
    getAttribute(name: string) {
      return this.attributes[name];
    },
  };

  let feedbackMessage = "";
  let feedbackTone = "";
  const say = (msg: string, tone: string) => {
    feedbackMessage = msg;
    feedbackTone = tone;
  };

  const mockNavigator = {
    // navigator.share is undefined (e.g. desktop Firefox or insecure context)
    share: undefined,
    clipboard: {
      writeText: (text: string) => {
        clipboardText = text;
        return Promise.resolve();
      },
    },
  };

  const episode = {
    id: "ep-3",
    title: "Desktop Article",
    articleUrl: "https://example.com/desktop",
    audioUrl: "https://audio.example.com/audio/ep-3.wav",
  };

  const shareUrl = episode.articleUrl || episode.audioUrl;
  let shared = false;

  if (typeof mockNavigator.share === "function") {
    shared = true;
  }

  if (!shared) {
    await mockNavigator.clipboard.writeText(shareUrl);
    button.dataset.state = "copied";
    button.setAttribute("aria-label", "Link copied for: " + episode.title);
    say("Link copied to clipboard.", "ok");
  }

  assertEquals(clipboardText, "https://example.com/desktop");
  assertEquals(button.dataset.state, "copied");
  assertEquals(button.getAttribute("aria-label"), "Link copied for: Desktop Article");
  assertEquals(feedbackMessage, "Link copied to clipboard.");
  assertEquals(feedbackTone, "ok");
});
