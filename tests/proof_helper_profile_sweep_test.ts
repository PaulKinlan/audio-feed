/**
 * audio-feed-u8nv: an abandoned Chrome profile is reclaimed by age and SIGNATURE - and nothing else is.
 *
 * WHY THIS SUITE LOOKS DIFFERENT FROM ITS FIRST VERSION, STATED SO NOBODY THINKS A GUARD WAS DROPPED
 * QUIETLY. The first version swept by PREFIX and its tests were about prefix boundaries
 * (`audiofeed-chrome-` must not reach `audiofeed-chrome-test-`, etc). That whole row is GONE, and it
 * is gone as a CONSEQUENCE of a reshape rather than by tidy-up: the rule no longer compares names at
 * all, so there is nothing left for a `startsWith` to get wrong. What replaces it is a rule decided by
 * what is INSIDE the directory, and the tests below are the rows that now carry the weight.
 *
 * THE THREE ROWS THAT MATTER, AND WHY EACH IS SEPARATE:
 *   1. A YOUNG profile survives            - the AGE guard. A prefix or signature rule without it
 *                                            would eat a run that is in flight.
 *   2. An aged NON-profile survives        - the SIGNATURE guard, and this is TONIGHT'S INCIDENT. On
 *                                            this VM the non-profile temp directories are OTHER
 *                                            LANES' GIT WORKTREES: measured, 10 of the newest 22
 *                                            entries under `af-*`/`audio-feed-*` were checkouts. An
 *                                            age-only rule deletes those, which is exactly what a
 *                                            by-age sweep did earlier tonight.
 *   3. An aged profile is reclaimed        - including under names the original prefix rule NEVER
 *      WHATEVER ITS NAME                      MATCHED. That is the rename-proof row: the prefix has
 *                                            already changed once on this VM, so a rule that survives
 *                                            a rename has to be name-agnostic.
 * EVERY DIRECTORY IS CREATED UNDER A SCRATCH TMPDIR, so the suite cannot observe, depend on, or
 * disturb the real /tmp pile or another lane's worktree - which is also why it needs no browser.
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

async function age(path: string, ageMs: number): Promise<string> {
  const when = new Date(Date.now() - ageMs);
  await Deno.utime(path, when, when);
  return path;
}

/** A directory of `prefix` under `scratch`, aged by `ageMs` - the general shape. */
async function agedDir(scratch: string, prefix: string, ageMs: number): Promise<string> {
  const dir = (await Deno.makeTempDir({ dir: scratch, prefix })).replace(/\/$/, "");
  return await age(dir, ageMs);
}

/** An AGED CHROME PROFILE: the marker `Default/` is what makes it one. */
async function agedProfile(scratch: string, prefix: string, ageMs: number): Promise<string> {
  const dir = (await Deno.makeTempDir({ dir: scratch, prefix })).replace(/\/$/, "");
  await Deno.mkdir(`${dir}/Default`, { recursive: true });
  return await age(dir, ageMs);
}

/** An AGED GIT CHECKOUT: `.git` present, `Default/` absent - i.e. another lane's worktree. */
async function agedCheckout(scratch: string, prefix: string, ageMs: number): Promise<string> {
  const dir = (await Deno.makeTempDir({ dir: scratch, prefix })).replace(/\/$/, "");
  await Deno.mkdir(`${dir}/.git`, { recursive: true });
  return await age(dir, ageMs);
}

const STALE = STALE_PROFILE_AGE_MS + HOUR;

Deno.test("audio-feed-u8nv: an aged profile is reclaimed", async () => {
  await withScratchTmp(async (scratch) => {
    const profile = await agedProfile(scratch, "u8nv-sweep-", STALE);
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [profile], "the aged profile is what the reclaim removed");
    let gone = false;
    try {
      await Deno.stat(profile);
    } catch {
      gone = true;
    }
    assert(gone, "and it is gone from disk, not merely reported");
  });
});

Deno.test("audio-feed-u8nv: a YOUNG profile survives - a live run is not destroyed", async () => {
  await withScratchTmp(async (scratch) => {
    // TWO SIDES OF THE BOUND, because one side cannot show where it is. A fresh profile is the plain
    // live case; the second sits just INSIDE the bound, so the assertion fails if the bound is ever
    // widened or removed. The first version of this test aged its "young" profile by an hour, which was
    // young under the old 2-hour bound and OLD under the 45-minute one - the test was wrong, not the
    // rule, and it only looked like a failure because the boundary moved.
    const fresh = await agedProfile(scratch, "u8nv-fresh-", 0);
    const justInside = await agedProfile(
      scratch,
      "u8nv-inside-",
      Math.floor(STALE_PROFILE_AGE_MS / 2),
    );
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [], "nothing younger than the bound is reclaimed");
    for (const dir of [fresh, justInside]) {
      const info = await Deno.stat(dir);
      assert(info.isDirectory, `${dir} is still there`);
    }
  });
});

/**
 * TONIGHT'S INCIDENT, AS A FENCE ROW. The directory is older than the bound and would be reclaimed by
 * an age-only rule; it is another lane's worktree, so the signature is what saves it.
 */
Deno.test("audio-feed-u8nv: an aged GIT CHECKOUT survives - the worktree that an age rule would eat", async () => {
  await withScratchTmp(async (scratch) => {
    const checkout = await agedCheckout(scratch, "af-some-other-lane-", STALE);
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [], "a checkout is not a profile, however old it is");
    const info = await Deno.stat(checkout);
    assert(info.isDirectory, "the worktree is still there");
  });
});

/**
 * Belt-and-braces: a repository that HAPPENS to contain a `Default/` directory is still not a profile.
 */
Deno.test("audio-feed-u8nv: a directory with BOTH Default/ and .git is left alone", async () => {
  await withScratchTmp(async (scratch) => {
    const odd = (await Deno.makeTempDir({ dir: scratch, prefix: "u8nv-odd-" })).replace(/\/$/, "");
    await Deno.mkdir(`${odd}/Default`, { recursive: true });
    await Deno.mkdir(`${odd}/.git`, { recursive: true });
    await age(odd, STALE);
    assertEquals(await sweepStaleProfiles(), [], "a checkout wins over the profile marker");
    await Deno.stat(odd);
  });
});

Deno.test("audio-feed-u8nv: an aged directory with no marker at all survives", async () => {
  await withScratchTmp(async (scratch) => {
    const plain = await agedDir(scratch, "u8nv-plain-", STALE);
    assertEquals(await sweepStaleProfiles(), [], "not a profile");
    await Deno.stat(plain);
  });
});

/** The FILE case, asserted because the reclaim decides on `entry.isDirectory` first. */
Deno.test("audio-feed-u8nv: a stale FILE that shares the name shape is left alone", async () => {
  await withScratchTmp(async (scratch) => {
    const file = `${scratch}/audiofeed-chrome-not-a-dir`;
    await Deno.writeTextFile(file, "not a chrome profile\n");
    await age(file, STALE);
    assertEquals(await sweepStaleProfiles(), [], "a file is not a profile directory");
    await Deno.stat(file);
  });
});

/**
 * THE RENAME-PROOF ROW, and the reason the reshape happened at all: the SAME aged profile is reclaimed
 * under three different name families, including the two the original prefix rule could never match.
 */
Deno.test("audio-feed-u8nv: an aged profile is reclaimed WHATEVER its name - a rename cannot outlive the rule", async () => {
  await withScratchTmp(async (scratch) => {
    const today = await agedProfile(scratch, "audiofeed-", STALE);
    const yesterday = await agedProfile(scratch, "audio-feed-", STALE);
    const older = await agedProfile(scratch, "af-", STALE);
    const swept = (await sweepStaleProfiles()).sort();
    assertEquals(
      swept,
      [today, yesterday, older].sort(),
      "name-agnostic: all three families are in scope",
    );
  });
});

/**
 * AND THE INTEGRATION, because the guard above is the sweep in isolation: the thing callers get must
 * hand back a FRESH directory and report how many it reclaimed on the way in.
 */
Deno.test("audio-feed-u8nv: createTempChromeProfile reclaims before it allocates, and says how many", async () => {
  await withScratchTmp(async (scratch) => {
    const stale = await agedProfile(scratch, "audiofeed-u8nv-integration-", STALE);
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
