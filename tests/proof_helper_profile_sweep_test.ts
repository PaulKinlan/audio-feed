/**
 * audio-feed-u8nv, widened by audio-feed-h62q: an abandoned Chrome profile is reclaimed by AGE and
 * PROFILE SIGNATURE - and NOTHING ELSE is, whatever it is called.
 *
 * WHY THE RULE IS A SIGNATURE AND NOT A NAME. The original reclaim matched the caller's prefix, which
 * is safe but unreachable: a directory created by a path that does not go through
 * `createTempChromeProfile` can never be named by a later sweep, so it sits there forever. MEASURED on
 * this VM before this change: of 9408 directories under /tmp that are >=45 minutes stale, 82 carry the
 * signature (`Default/` present, `.git` absent) - 66 reachable by some caller's prefix and 16 NOT,
 * among them six `i9hq-*-prof` at ~1027 minutes, `regen-prof`, `l6tl-mutant-prof` and five
 * `audiofeed-txcz-*`. The 16 are the defect this file now fences.
 *
 * WHY THE SIGNATURE IS THE SAFER HALF, ALSO MEASURED: `Default/` was present in 20 of 20 profiles and
 * 0 of 22 non-profiles when u8nv first tried this shape, and 9326 of those 9408 stale directories do
 * NOT carry it. Age alone is not enough - a by-age sweep deleted other lanes' git worktrees under /tmp
 * earlier that night - so the checkout exclusion is asserted here as a WALL, not as a comment.
 *
 * THE WAYS TO BE WRONG, one assertion each, and the negative rows are the load-bearing ones:
 *   1. a STALE PROFILE                -> reclaimed   (the reclaim is load-bearing)
 *   2. a YOUNG PROFILE                -> kept        (a live run is not destroyed)
 *   3. a STALE PLAIN DIRECTORY        -> kept        (the signature is the rule, never the age)
 *   4. a STALE CHECKOUT               -> kept        (a worktree is not a profile, marker or not)
 *   5. a STALE FILE                   -> kept        (only directories are candidates)
 *   6. another prefix's stale profile -> reclaimed   (THE WIDENING: no name decides any more)
 *
 * EVERY DIRECTORY HERE IS CREATED UNDER A TMPDIR POINTING AT A SCRATCH DIRECTORY, so the test cannot
 * observe, depend on, or disturb the real /tmp pile or another lane's profile - which is also why it
 * needs no browser: the sweep is the behaviour under test, not Chrome.
 *
 * THE FIXTURES CARRY `Default/` BECAUSE THE RULE READS IT, AND THEY ARE AGED AFTER IT IS CREATED:
 * `mkdir` bumps the parent's mtime, so aging first leaves the fixture YOUNG and a row can pass on the
 * age guard while claiming to test the signature. u8nv hit exactly that in its checkout row, which is
 * why `profileDir` below owns the ordering instead of leaving it to each row.
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

/**
 * A profile-shaped directory with an EXPLICIT name, aged by `ageMs`.
 *
 * The name is explicit rather than `makeTempDir({prefix})` because the rule under test does not read
 * names at all, and the names used below are the names of real orphans measured in the pile. `Default/`
 * is created FIRST and the fixture is aged LAST, for the mtime reason in the file header.
 */
async function profileDir(scratch: string, name: string, ageMs: number): Promise<string> {
  const dir = `${scratch}/${name}`;
  await Deno.mkdir(`${dir}/Default`, { recursive: true });
  await age(dir, ageMs);
  return dir;
}

/** A stale directory that is NOT a profile: same age, no marker inside. */
async function plainDir(scratch: string, name: string, ageMs: number): Promise<string> {
  const dir = `${scratch}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  await age(dir, ageMs);
  return dir;
}

/** Assert a path is still on disk, without throwing out of the row. */
async function assertSurvives(path: string, why: string): Promise<void> {
  const info = await Deno.stat(path);
  assert(info.isDirectory, `${why} (${path})`);
}

Deno.test("audio-feed-h62q: a STALE PROFILE is reclaimed WHATEVER IT IS CALLED", async () => {
  await withScratchTmp(async (scratch) => {
    // The name is a real orphan's: created by something that never went through the helper, so no
    // prefix sweep will ever ask for it. This is the row the old name rule fails.
    const orphan = await profileDir(scratch, "i9hq-parent-prof", STALE);
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [orphan], "the stale profile is what the reclaim removed");
    let gone = false;
    try {
      await Deno.stat(orphan);
    } catch {
      gone = true;
    }
    assert(gone, "and it is gone from disk, not merely reported");
  });
});

Deno.test("audio-feed-h62q: a YOUNG profile survives, whatever its name is", async () => {
  await withScratchTmp(async (scratch) => {
    // TWO SIDES OF THE BOUND, and the margin is wide on purpose: u8nv's first version aged its "young"
    // profile by an hour, which was young under the retired 2-hour bound and OLD under this one.
    const fresh = await profileDir(scratch, "i9hq-live-fresh", 0);
    const justInside = await profileDir(
      scratch,
      "i9hq-live-inside",
      Math.floor(STALE_PROFILE_AGE_MS / 2),
    );
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [], "nothing younger than the bound is reclaimed");
    await assertSurvives(fresh, "a freshly created profile belongs to a run that is starting");
    await assertSurvives(
      justInside,
      "and one inside the bound may belong to a run that is running",
    );
  });
});

/**
 * THE ROW A PURE-AGE RULE FAILS, and the reason the signature is the rule rather than a nicety: aged,
 * a directory, and it would be swept by age alone. 9326 of the 9408 stale directories on this VM look
 * like this one, and among them are other lanes' git worktrees - one of which a by-age sweep actually
 * deleted. Nothing here is profile-shaped, so nothing here is ours to remove.
 */
Deno.test("audio-feed-h62q: a STALE PLAIN DIRECTORY is kept - the signature is the rule, not the age", async () => {
  await withScratchTmp(async (scratch) => {
    const plain = await plainDir(scratch, "rxa2-scratch-notes", STALE);
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [], "age alone is not ownership");
    await assertSurvives(plain, "a stale directory that holds no profile is not reclaimed");
  });
});

/**
 * THE WALL, ASSERTED SEPARATELY FROM THE PLAIN-DIRECTORY ROW because it is a different mistake in a
 * different direction: this directory DOES hold a profile marker, so the signature alone would reclaim
 * it - only the checkout exclusion saves it. `.git` is written as a FILE, because that is what it is
 * inside a LINKED WORKTREE, and the exclusion tests existence rather than `isDirectory` for exactly
 * that reason. An exclusion no test exercises is a claim, not a guard.
 */
Deno.test("audio-feed-h62q: a stale CHECKOUT survives even when it contains a profile marker", async () => {
  await withScratchTmp(async (scratch) => {
    const checkout = `${scratch}/audiofeed-mytask`;
    await Deno.mkdir(`${checkout}/Default`, { recursive: true });
    await Deno.writeTextFile(
      `${checkout}/.git`,
      "gitdir: /home/exedev/audio-feed/.git/worktrees/x\n",
    );
    await age(checkout, STALE);
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [], "a checkout is never reclaimed, whatever it holds");
    await assertSurvives(checkout, "another lane's worktree is still there");
  });
});

/**
 * The FILE case, asserted because the reclaim decides on `entry.isDirectory` and that decision is one
 * line away from deleting something that is not a profile at all.
 */
Deno.test("audio-feed-u8nv: a stale FILE that looks like a profile is left alone", async () => {
  await withScratchTmp(async (scratch) => {
    const file = `${scratch}/i9hq-file-not-a-profile`;
    await Deno.writeTextFile(file, "not a chrome profile\n");
    const when = new Date(Date.now() - STALE);
    await Deno.utime(file, when, when);
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [], "a file is not a profile directory");
    await Deno.stat(file);
  });
});

/**
 * THE WIDENING, STATED AS A ROW RATHER THAN LEFT TO INFERENCE: this is the deliberate change of
 * behaviour, and it is the one that retires audio-feed-3nit's guard. Under the name rule a sweep for
 * `audiofeed-chrome-` had to leave `audiofeed-chrome-test-` alone - a shorter prefix could not tell a
 * sibling from its own - and two tests existed to hold that. Nothing compares names now, so both are
 * reclaimed, and the invariant that replaces it is the one asserted above: never a non-profile, never a
 * checkout, whatever the name. If this row ever looks wrong, the fix is to argue the widening, not to
 * reinstate a name comparison as the ownership rule.
 */
Deno.test("audio-feed-h62q: another prefix's stale profile IS reclaimed - 3nit's guard retired with the name rule", async () => {
  await withScratchTmp(async (scratch) => {
    const shorter = await profileDir(scratch, "audiofeed-chrome-a1b2c3", STALE);
    const overlapping = await profileDir(scratch, "audiofeed-chrome-test-d4e5f6", STALE);
    const swept = await sweepStaleProfiles();
    assertEquals(
      swept.sort(),
      [shorter, overlapping].sort(),
      "both are abandoned profiles, so both are reclaimed",
    );
  });
});

/**
 * The other half of the retired boundary, kept because the fact behind it is still true: `makeTempDir`
 * always appends a tail, so a directory named EXACTLY the prefix was made by something else. It is kept
 * here for a different reason than before - it holds no profile marker - and the name it carries is now
 * irrelevant, which is the point.
 */
Deno.test("audio-feed-h62q: a directory named EXACTLY like an old prefix is kept when it holds no profile", async () => {
  await withScratchTmp(async (scratch) => {
    const bare = await plainDir(scratch, "audiofeed-bare-", STALE);
    const swept = await sweepStaleProfiles();
    assertEquals(swept, [], "no marker, no reclaim - the name is not consulted");
    await assertSurvives(bare, "and it is still there");
  });
});

/**
 * AND THE INTEGRATION, because every guard above is about the sweep in isolation: the thing callers
 * actually get must (a) hand back a FRESH directory of its own prefix and (b) have reclaimed the
 * abandoned profile on the way in, reporting how many it took. The planted orphan is deliberately
 * NOT of the caller's prefix: that is the widening, seen from the only call site that matters.
 */
Deno.test("audio-feed-u8nv: createTempChromeProfile reclaims before it allocates, and says how many", async () => {
  await withScratchTmp(async (scratch) => {
    const stale = await profileDir(scratch, "l6tl-mutant-prof", STALE);
    const { profileDir: allocated, cleanup, sweptStale } = await createTempChromeProfile(
      "audiofeed-u8nv-integration-",
    );
    assertEquals(sweptStale, 1, "the call reports the one directory it reclaimed");
    assert(
      allocated !== stale,
      "and the directory it returns is a NEW one, not the reclaimed path",
    );
    const info = await Deno.stat(allocated);
    assert(info.isDirectory, "the returned profile exists");
    await cleanup();
    await Deno.remove(allocated, { recursive: true }).catch(() => {});
  });
});
