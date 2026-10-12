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
    const young = await agedDir(scratch, "u8nv-live-", HOUR);
    const swept = await sweepStaleProfiles("u8nv-live-");
    assertEquals(swept, [], "nothing young is reclaimed");
    const info = await Deno.stat(young);
    assert(info.isDirectory, "the young directory is still there");
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
