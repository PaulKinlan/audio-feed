/**
 * audio-feed-u8nv: an abandoned Chrome profile directory is reclaimed by the next run of the SAME
 * prefix - and NOTHING ELSE is.
 *
 * WHY THIS TEST EXISTS IN THIS SHAPE. The leak does not come from a missing `finally`: measured on
 * this VM, a browser test on its SUCCESS path left zero new directories, both `finally` blocks guard
 * `chrome.kill()` and then run `await cleanup()`, and there were zero orphaned Chrome processes. The
 * leak is that a KILLED run executes no `finally` at all, and 1926 directories totalling 1.5 GB had
 * accumulated in /tmp as a result. So the repair is a reclaim, and the reclaim's whole risk is that
 * it removes a directory that is IN USE. That is what the three assertions below are for, one per
 * way of being wrong:
 *
 *   1. a STALE directory of this prefix is gone               (the reclaim is load-bearing)
 *   2. a YOUNG directory of this prefix is KEPT               (a live run is not destroyed)
 *   3. a STALE directory of ANOTHER prefix is KEPT            (another proof or lane is not destroyed)
 *   4. a stale FILE sharing the name shape is KEPT            (only makeTempDir() dirs are ours)
 *
 * EVERY DIRECTORY HERE IS CREATED UNDER A TMPDIR POINTING AT A SCRATCH DIRECTORY, so the test cannot
 * observe, depend on, or disturb the real /tmp pile or another lane's profile - which is also why it
 * needs no browser: the sweep is the behaviour under test, not Chrome.
 */
import { assert, assertEquals } from "@std/assert";
import {
  createTempChromeProfile,
  STALE_PROFILE_AGE_MS,
  sweepStaleProfiles,
} from "../scripts/proof-helper.ts";

const HOUR = 60 * 60 * 1000;
const STALE = STALE_PROFILE_AGE_MS + HOUR;

/** Run the body with TMPDIR redirected to a scratch directory, restoring it afterwards. */
async function withScratchTmp(body: (scratch: string) => Promise<void>): Promise<void> {
  const original = Deno.env.get("TMPDIR");
  const scratch = await Deno.makeTempDir({ prefix: "u8nv-scratch-" });
  Deno.env.set("TMPDIR", scratch);
  try {
    await body(scratch);
  } finally {
    if (original === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", original);
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
}

/** Set a path's mtime back by `ageMs`. Needed on its own when the fixture must be aged LAST. */
async function age(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await Deno.utime(path, when, when);
}

/** A directory of `prefix` under `scratch`, aged by `ageMs` so the bound can be exercised. */
async function agedDir(scratch: string, prefix: string, ageMs: number): Promise<string> {
  const dir = (await Deno.makeTempDir({ dir: scratch, prefix })).replace(/\/$/, "");
  const when = new Date(Date.now() - ageMs);
  await Deno.utime(dir, when, when);
  return dir;
}

Deno.test("audio-feed-u8nv: the reclaim takes THIS prefix's stale profile and reports it", async () => {
  await withScratchTmp(async (scratch) => {
    const stale = await agedDir(scratch, "u8nv-sweep-", STALE_PROFILE_AGE_MS + HOUR);
    const swept = await sweepStaleProfiles("u8nv-sweep-");
    assertEquals(swept, [stale], "the stale directory of this prefix is what the reclaim removed");
    let gone = false;
    try {
      await Deno.stat(stale);
    } catch {
      gone = true;
    }
    assert(gone, "and it is gone from disk, not merely reported");
  });
});

Deno.test("audio-feed-u8nv: a YOUNG profile of this prefix survives - a live run is not destroyed", async () => {
  await withScratchTmp(async (scratch) => {
    // Younger than the bound by a wide margin: this is what an in-flight run looks like.
    // TWO SIDES OF THE BOUND: the first version aged its "young" profile by an hour, which was
    // young under the retired 2-hour bound and OLD under the 45-minute one.
    // THE SWEPT PREFIX MUST MATCH THE PLANTED ONE or this row CANNOT FIRE: it planted `u8nv-fresh-`
    // and `u8nv-inside-` while the sweep asked for `u8nv-live-`, so it passed with the age guard
    // removed. A check that cannot fire is worse than one that cannot fail.
    const fresh = await agedDir(scratch, "u8nv-live-", 0);
    const justInside = await agedDir(scratch, "u8nv-live-", Math.floor(STALE_PROFILE_AGE_MS / 2));
    const swept = await sweepStaleProfiles("u8nv-live-");
    assertEquals(swept, [], "nothing younger than the bound is reclaimed");
    for (const dir of [fresh, justInside]) {
      const info = await Deno.stat(dir);
      assert(info.isDirectory, `${dir} is still there`);
    }
  });
});

Deno.test("audio-feed-u8nv: a STALE profile of ANOTHER prefix survives - scoping is load-bearing", async () => {
  await withScratchTmp(async (scratch) => {
    const other = await agedDir(scratch, "u8nv-other-", STALE_PROFILE_AGE_MS + HOUR);
    const mine = await agedDir(scratch, "u8nv-mine-", STALE_PROFILE_AGE_MS + HOUR);
    const swept = await sweepStaleProfiles("u8nv-mine-");
    assertEquals(swept, [mine], "only this prefix is in scope");
    await Deno.stat(other); // throws if the scoping leaked
  });
});

/**
 * The FILE case, asserted because the reclaim decides on `entry.isDirectory` and that decision is
 * one line away from deleting something that is not a profile at all.
 */
Deno.test("audio-feed-u8nv: a stale FILE that shares the prefix is left alone", async () => {
  await withScratchTmp(async (scratch) => {
    const file = `${scratch}/u8nv-file-not-a-profile`;
    await Deno.writeTextFile(file, "not a chrome profile\n");
    const when = new Date(Date.now() - (STALE_PROFILE_AGE_MS + HOUR));
    await Deno.utime(file, when, when);
    const swept = await sweepStaleProfiles("u8nv-file-");
    assertEquals(swept, [], "a file is not a profile directory");
    await Deno.stat(file);
  });
});

/**
 * AND THE INTEGRATION, because the guard above is about the sweep in isolation: the thing callers
 * actually get must (a) hand back a FRESH directory of its own prefix and (b) have reclaimed the
 * stale one on the way in, reporting how many it took.
 */
Deno.test("audio-feed-u8nv: createTempChromeProfile reclaims before it allocates, and says how many", async () => {
  await withScratchTmp(async (scratch) => {
    const stale = await agedDir(
      scratch,
      "audiofeed-u8nv-integration-",
      STALE_PROFILE_AGE_MS + HOUR,
    );
    const { profileDir, cleanup, sweptStale } = await createTempChromeProfile(
      "audiofeed-u8nv-integration-",
    );
    assertEquals(sweptStale, 1, "the call reports the one directory it reclaimed");
    assert(
      profileDir !== stale,
      "and the directory it returns is a NEW one, not the reclaimed path",
    );
    const info = await Deno.stat(profileDir);
    assert(info.isDirectory, "the returned profile exists");
    await cleanup();
    await Deno.remove(profileDir, { recursive: true }).catch(() => {});
  });
});

/**
 * audio-feed-3nit: THE OWN-PREFIX GUARD AGAINST A COUNTEREXAMPLE, WHICH IS THE CASE THE SUITE ABOVE
 * COULD NOT SEE. Every prefix in the earlier tests is disjoint from every other, so `startsWith(prefix)`
 * passed all of them - a predicate validated only on positive examples. The reviewer supplied the
 * counterexample instead: `audiofeed-chrome-test-` STARTS WITH `audiofeed-chrome-`, so a sweep for the
 * shorter prefix reclaimed a longer prefix's directories. One overlapping pair exists in this tree by
 * construction, because the helper's own suite creates `audiofeed-chrome-test-` profiles under the
 * helper's default `audiofeed-chrome-`.
 *
 * BOTH DIRECTIONS ARE ASSERTED, because they are different mistakes: the shorter prefix must not reach
 * the longer one, and the longer prefix must still reclaim its own.
 */
Deno.test("audio-feed-3nit: a SIBLING prefix survives a sweep for the shorter prefix", async () => {
  await withScratchTmp(async (scratch) => {
    const own = await agedDir(scratch, "audiofeed-chrome-", STALE_PROFILE_AGE_MS + HOUR);
    const sibling = await agedDir(scratch, "audiofeed-chrome-test-", STALE_PROFILE_AGE_MS + HOUR);
    const swept = await sweepStaleProfiles("audiofeed-chrome-");
    assertEquals(swept, [own], "only this prefix's OWN directory is in scope");
    const info = await Deno.stat(sibling);
    assert(info.isDirectory, "the overlapping sibling prefix is still there");
  });
});

Deno.test("audio-feed-3nit: the LONGER prefix still reclaims its own, and not the shorter one's", async () => {
  await withScratchTmp(async (scratch) => {
    const shorter = await agedDir(scratch, "audiofeed-chrome-", STALE_PROFILE_AGE_MS + HOUR);
    const longer = await agedDir(scratch, "audiofeed-chrome-test-", STALE_PROFILE_AGE_MS + HOUR);
    const swept = await sweepStaleProfiles("audiofeed-chrome-test-");
    assertEquals(swept, [longer], "the longer prefix reclaims its own");
    const info = await Deno.stat(shorter);
    assert(info.isDirectory, "and leaves the shorter prefix's directory alone");
  });
});

/** The other half of the boundary: name === prefix is not an owned profile either. */
Deno.test("audio-feed-3nit: a directory named EXACTLY the prefix was not made by makeTempDir", async () => {
  await withScratchTmp(async (scratch) => {
    const bare = `${scratch}/audiofeed-bare-`;
    await Deno.mkdir(bare);
    const when = new Date(Date.now() - (STALE_PROFILE_AGE_MS + HOUR));
    await Deno.utime(bare, when, when);
    const swept = await sweepStaleProfiles("audiofeed-bare-");
    assertEquals(swept, [], "makeTempDir always appends a tail, so a bare prefix is not ours");
    await Deno.stat(bare);
  });
});

/**
 * THE INSURANCE'S OWN FENCE ROW. The prefix matcher alone WOULD reclaim this: it is aged, it is a
 * directory, and its name is the caller's prefix plus a separator-free tail. What saves it is that it
 * is a CHECKOUT - which coord discovered is what the other /tmp piles actually are (ten of the newest
 * 22 entries under `af-*`/`audio-feed-*` were git worktrees). Asserted separately because an exclusion
 * that no test exercises is a claim, not a guard.
 */
Deno.test("audio-feed-u8nv: an aged CHECKOUT under our own prefix survives - a worktree is not a profile", async () => {
  await withScratchTmp(async (scratch) => {
    // SEPARATOR-FREE TAIL, so the prefix rule REACHES it and only the `.git` insurance can save it: a
    // name like `audiofeed-checkout-<rand>` is rejected by the boundary rule first, which would make
    // this row theatre. Real worktrees are named `audiofeed-<word>`.
    // AND THE DIRECTORY IS AGED **AFTER** THE `.git` IS CREATED, which is not tidiness: `mkdir` bumps
    // the parent's mtime, so aging first left the fixture YOUNG and the row passed on the AGE guard
    // while claiming to test the insurance. It only read as green because the exclusion was inert.
    const checkout = (await Deno.makeTempDir({ dir: scratch, prefix: "audiofeed-w" })).replace(
      /\/$/,
      "",
    );
    await Deno.mkdir(`${checkout}/.git`, { recursive: true });
    await age(checkout, STALE);
    const swept = await sweepStaleProfiles("audiofeed-");
    assertEquals(swept, [], "a checkout is never reclaimed, whatever it is called");
    const info = await Deno.stat(checkout);
    assert(info.isDirectory, "the worktree is still there");
  });
});
