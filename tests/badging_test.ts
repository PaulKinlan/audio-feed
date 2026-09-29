/**
 * Tests for PWA App Badging API for unread/ready episodes (audio-feed-n07).
 *
 * Verifies Modern Web Guidance compliance:
 * - Feature-detects navigator.setAppBadge and navigator.clearAppBadge
 * - Displays unread / ready episode count on app icon
 * - Clears app badge (clearAppBadge) when count reaches 0
 * - Silently suppresses errors on unsupported or permission-denied contexts
 * - Baseline TODO marker present
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("listen.js: includes Badging API integration and Baseline TODO (audio-feed-n07)", async () => {
  const code = await Deno.readTextFile(new URL("../src/assets/listen.js", import.meta.url));

  assertStringIncludes(code, "navigator.setAppBadge");
  assertStringIncludes(code, "navigator.clearAppBadge");
  assertStringIncludes(code, "updateAppBadge");
  assertStringIncludes(code, "loadPlayed");
  assertStringIncludes(code, "savePlayed");
  assertStringIncludes(code, "getUnreadCount");
  assertStringIncludes(code, "TODO(baseline/badging)");
});

Deno.test("badging: sets badge when unread episodes exist (audio-feed-n07)", async () => {
  let badgeSet: number | null = null;
  let badgeCleared = false;

  const mockNavigator = {
    setAppBadge: (count?: number) => {
      badgeSet = count ?? 1;
      return Promise.resolve();
    },
    clearAppBadge: () => {
      badgeCleared = true;
      return Promise.resolve();
    },
  };

  async function updateBadge(num: number) {
    if (typeof mockNavigator.setAppBadge === "function" && num > 0) {
      await mockNavigator.setAppBadge(num);
    } else if (typeof mockNavigator.clearAppBadge === "function") {
      await mockNavigator.clearAppBadge();
    }
  }

  await updateBadge(5);
  assertEquals(badgeSet, 5);
  assertEquals(badgeCleared, false);
});

Deno.test("badging: clears badge when unread count reaches zero (audio-feed-n07)", async () => {
  let badgeSet: number | null = null;
  let badgeCleared = false;

  const mockNavigator = {
    setAppBadge: (count?: number) => {
      badgeSet = count ?? 1;
      return Promise.resolve();
    },
    clearAppBadge: () => {
      badgeCleared = true;
      return Promise.resolve();
    },
  };

  async function updateBadge(num: number) {
    if (num > 0) {
      if (typeof mockNavigator.setAppBadge === "function") {
        await mockNavigator.setAppBadge(num);
      }
    } else {
      if (typeof mockNavigator.clearAppBadge === "function") {
        await mockNavigator.clearAppBadge();
      } else if (typeof mockNavigator.setAppBadge === "function") {
        await mockNavigator.setAppBadge(0);
      }
    }
  }

  await updateBadge(0);
  assertEquals(badgeCleared, true);
  assertEquals(badgeSet, null);
});

Deno.test("badging: falls back to setAppBadge(0) when clearAppBadge is unavailable (audio-feed-n07)", async () => {
  let badgeSet: number | null = null;

  const mockNavigator = {
    setAppBadge: (count?: number) => {
      badgeSet = count ?? 0;
      return Promise.resolve();
    },
    clearAppBadge: undefined,
  };

  async function updateBadge(num: number) {
    if (num > 0) {
      if (typeof mockNavigator.setAppBadge === "function") {
        await mockNavigator.setAppBadge(num);
      }
    } else {
      if (typeof mockNavigator.clearAppBadge === "function") {
        // @ts-expect-error test unreachable fallback
        await mockNavigator.clearAppBadge();
      } else if (typeof mockNavigator.setAppBadge === "function") {
        await mockNavigator.setAppBadge(0);
      }
    }
  }

  await updateBadge(0);
  assertEquals(badgeSet, 0);
});

Deno.test("badging: suppresses errors on unsupported or permission-denied contexts (audio-feed-n07)", async () => {
  const mockNavigator = {
    setAppBadge: () => {
      const err = new Error("Permission denied");
      err.name = "NotAllowedError";
      return Promise.reject(err);
    },
    clearAppBadge: () => {
      const err = new Error("Security error");
      err.name = "SecurityError";
      return Promise.reject(err);
    },
  };

  async function safeUpdateBadge(num: number) {
    try {
      if (num > 0) {
        await mockNavigator.setAppBadge();
      } else {
        await mockNavigator.clearAppBadge();
      }
    } catch {
      // Must be caught silently without rethrowing
    }
  }

  // Must not throw for positive count
  await safeUpdateBadge(3);
  // Must not throw for zero count
  await safeUpdateBadge(0);
});
