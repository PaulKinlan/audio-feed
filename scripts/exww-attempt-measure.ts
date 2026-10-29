/**
 * audio-feed-8u4x1 — MEASURE the exww proof's per-attempt wall time under real host load, so the
 * run-bound ladder's constants are DERIVED from data instead of chosen.
 *
 * WHY THIS EXISTS: the coao proof's run bound has been three shapes (fixed 240s literal,
 * boot-derived, kill-derived ladder) and in every one the NUMBER was chosen — 240s was arbitrary,
 * 1200 was back-calibrated on a quiet host, and the ladder ratio 2 was likewise picked. Coord
 * refused to let the tree claim a measured ratio until real data exists. This script produces that
 * data: it runs the UNMUTATED proof (`scripts/exww-live-claims-browser-proof.ts`, the same
 * execution the mapped suite guards) N times in the harness's scratch tree, records each attempt's
 * wall time alongside the host's 1-minute load average, and derives the ladder constants with the
 * stated rules below — the same shape as docs/speed.md's CHECK_TIMEOUT derivation
 * (`ceil(observed_max × 1.1)`, a rule over measurements, never preference).
 *
 *     deno run --allow-read --allow-write --allow-run=timeout,deno --allow-sys --allow-env \
 *       scripts/exww-attempt-measure.ts [--attempts 12] [--bound-s 600] [--deadline-s 4800] [--out <dir>]
 *   (--allow-sys is REQUIRED: the campaign records Deno.loadavg around every attempt, and without it
 *   the first attempt dies with NotCapable before measuring anything - measured 2026-10-29, a campaign
 *   that queued 34 minutes for a heavy slot and then crashed on its first loadavg call.)
 *
 * The baseline (not a mutant row) is the measurement target: it is the run that was killed at
 * 240.6s and 241.2s under gate load (audio-feed-ybwj7's evidence), and the mutant does the same
 * work as the baseline, so one distribution covers both.
 *
 * THE DERIVATION RULES (stated here because a rule that lives only in code is a constant with
 * extra steps):
 *   - ratio = max(2, ceil(p99 / p50)). The floor exists because the ladder's pinned invariant is
 *     strictly increasing bounds; the data may only raise it.
 *   - baseMs = max(240_000, 60s × ceil(p99 / 60s)). The floor is the original r6hft quiet guard —
 *     never narrowed without cause — and the rounding is presentation granularity, the same move
 *     as CHECK_TIMEOUT's "next round hundred".
 *   - the ladder top (base × ratio^(maxAttempts-1)) must stay inside the fleet's 5400s gate
 *     budget, or the derivation FAILS rather than shipping a ladder that cannot run.
 * Percentiles are nearest-rank over UNCENSORED attempts. An attempt killed by the per-attempt
 * bound is censored (its true duration is unknown-but-larger), so it is excluded from the
 * percentiles and reported: more than one fifth censored means the bound was too tight and the
 * campaign is INCONCLUSIVE — it fails loudly rather than deriving from a tail it could not see.
 */
import { join, resolve } from "@std/path";
import { buildScratch, runProofIn } from "./exww-mutants.ts";

/** The ladder ratio's floor: the pinned invariant is that every attempt buys strictly more time
 * than the one that was killed, so a ratio of 1 is never derivable — 2 is where increasing starts. */
export const LADDER_RATIO_FLOOR = 2;

/** The base bound's floor: the original r6hft quiet guard. The measurement may raise the base;
 * it never lowers the guard below the value that has carried every gate so far. */
export const BASE_FLOOR_MS = 240_000;

/** Presentation granularity for the derived base, in ms: a guard a human can reason about. */
export const BASE_ROUNDING_MS = 60_000;

/** The fleet's heavy-slot budget (docs/speed.md): the ladder top must fit inside it. */
export const GATE_BUDGET_MS = 5_400_000;

/** A campaign loses its tail (and its honesty) once this share of attempts is censored. */
export const MAX_CENSORED_SHARE = 0.2;

/** One measured run of the unmutated proof, with the host context it ran under. */
export interface AttemptSample {
  attempt: number;
  /** Wall seconds of the whole `runProofIn` call — the number the guard is compared against. */
  seconds: number;
  /** The proof was killed by the per-attempt bound: `seconds` is the censoring point, not a duration. */
  timedOut: boolean;
  exitCode: number;
  load1Before: number;
  load1After: number;
  startedAt: string;
}

/** The constants the ladder should carry, each with the rule that produced it. */
export interface LadderDerivation {
  attemptCount: number;
  censoredCount: number;
  /** nearest-rank percentile of the uncensored attempt seconds */
  p50S: number;
  p90S: number;
  p99S: number;
  ratio: number;
  baseMs: number;
  /** the stated rules, so the JSON record is self-describing and the pin can quote it */
  rules: {
    ratio: string;
    base: string;
    budget: string;
    percentile: string;
    censoring: string;
  };
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted copy: rank = ceil(p/100 × n), 1-indexed.
 * Nearest-rank is used over interpolation because it is monotone in the data and a human can
 * recompute it from the README in their head; with a campaign-sized n (< 100) p99 IS the worst
 * observed attempt, and the README says so rather than implying more precision than n supports.
 */
export function nearestRankPercentile(seconds: number[], p: number): number {
  if (seconds.length === 0) throw new Error(`percentile(${p}) of an empty sample set`);
  const sorted = [...seconds].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/** The derivation, from raw attempt seconds. Pure, so the pin test can recompute it from the
 * committed JSON and fail the suite the moment code and data drift apart. */
export function deriveLadderConstants(
  uncensoredSeconds: number[],
  censoredCount: number,
  maxAttempts = 3,
): LadderDerivation {
  if (uncensoredSeconds.length === 0) {
    throw new Error(
      "no uncensored attempts: the campaign measured nothing — re-run with a larger per-attempt bound",
    );
  }
  const p50S = nearestRankPercentile(uncensoredSeconds, 50);
  const p90S = nearestRankPercentile(uncensoredSeconds, 90);
  const p99S = nearestRankPercentile(uncensoredSeconds, 99);
  const attemptCount = uncensoredSeconds.length + censoredCount;
  if (attemptCount > 0 && censoredCount / attemptCount > MAX_CENSORED_SHARE) {
    throw new Error(
      `INCONCLUSIVE: ${censoredCount} of ${attemptCount} attempts were killed by the bound — ` +
        `the tail was censored, so no ratio can be derived from this campaign. ` +
        `Re-run with a larger per-attempt bound.`,
    );
  }
  if (p50S <= 0) throw new Error(`p50 must be positive to divide, got ${p50S}`);
  const ratio = Math.max(LADDER_RATIO_FLOOR, Math.ceil(p99S / p50S));
  const baseMs = Math.max(
    BASE_FLOOR_MS,
    BASE_ROUNDING_MS * Math.ceil((p99S * 1000) / BASE_ROUNDING_MS),
  );
  const ladderTopMs = baseMs * ratio ** (maxAttempts - 1);
  if (ladderTopMs > GATE_BUDGET_MS) {
    throw new Error(
      `derived ladder top ${(ladderTopMs / 1000).toFixed(0)}s exceeds the fleet's ` +
        `${GATE_BUDGET_MS / 1000}s gate budget — the ladder cannot run as derived; ` +
        `the measurement demands a design conversation, not a bigger number`,
    );
  }
  return {
    attemptCount,
    censoredCount,
    p50S,
    p90S,
    p99S,
    ratio,
    baseMs,
    rules: {
      ratio:
        `max(${LADDER_RATIO_FLOOR}, ceil(p99/p50)) — the floor is the ladder's strictly-increasing invariant; data may only raise it`,
      base: `max(${BASE_FLOOR_MS / 1000}s, ceil-to-${
        BASE_ROUNDING_MS / 1000
      }s(p99)) — the floor is the original r6hft quiet guard, never narrowed without cause`,
      budget: `base × ratio^(maxAttempts-1) must stay inside the fleet's ${
        GATE_BUDGET_MS / 1000
      }s gate budget (docs/speed.md)`,
      percentile:
        "nearest-rank over uncensored attempts (with n < 100, p99 IS the worst observed attempt)",
      censoring:
        `a bound-killed attempt is excluded from the percentiles and reported; more than ` +
        `${MAX_CENSORED_SHARE * 100}% censored is INCONCLUSIVE, not a derivation`,
    },
  };
}

export interface MeasureOptions {
  attempts: number;
  boundMs: number;
  deadlineMs: number;
  outDir: string;
}

export function parseMeasureOptions(args: string[]): MeasureOptions {
  const options: MeasureOptions = {
    attempts: 12,
    boundMs: 600_000,
    deadlineMs: 4_800_000,
    outDir: "docs/evidence/audio-feed-8u4x1",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    const num = (name: string): number => {
      if (!value || !Number.isFinite(Number(value)) || Number(value) <= 0) {
        throw new Error(`${name} needs a positive number, got ${JSON.stringify(value)}`);
      }
      i++;
      return Number(value);
    };
    if (arg === "--attempts") options.attempts = Math.round(num("--attempts"));
    else if (arg === "--bound-s") options.boundMs = Math.round(num("--bound-s") * 1000);
    else if (arg === "--deadline-s") options.deadlineMs = Math.round(num("--deadline-s") * 1000);
    else if (arg === "--out") {
      if (!value) throw new Error("--out needs a directory");
      options.outDir = value;
      i++;
    } else {
      throw new Error(
        `unrecognised argument ${JSON.stringify(arg)}\n` +
          "usage: scripts/exww-attempt-measure.ts [--attempts N] [--bound-s S] [--deadline-s S] [--out <dir>]",
      );
    }
  }
  if (options.deadlineMs <= options.boundMs) {
    throw new Error(
      `the campaign deadline (${options.deadlineMs}ms) must exceed the per-attempt bound (${options.boundMs}ms), ` +
        `or the first attempt cannot finish inside it`,
    );
  }
  return options;
}

/** The host's 1-minute load average, or 0 when the platform declines to report it — recorded per
 * attempt so the evidence states the load regime the measurement actually ran under. */
function load1(): number {
  return Deno.loadavg()[0] ?? 0;
}

/** Run the campaign. One scratch tree, attempts strictly sequential (one headless browser at a
 * time), stopping at `--attempts` or when starting another attempt could not finish inside the
 * deadline. Returns the record the evidence directory carries. */
export async function runCampaign(
  options: MeasureOptions,
): Promise<Record<string, unknown>> {
  const scratch = await buildScratch();
  const attempts: AttemptSample[] = [];
  let stoppedEarly: "attempts" | "deadline" = "attempts";
  const campaignStart = Date.now();
  try {
    for (let attempt = 1; attempt <= options.attempts; attempt++) {
      if (Date.now() - campaignStart + options.boundMs > options.deadlineMs) {
        stoppedEarly = "deadline";
        console.log(
          `[measure] stopping before attempt ${attempt}: starting it could not finish inside the ` +
            `${options.deadlineMs / 1000}s deadline — ${attempts.length} attempt(s) recorded`,
        );
        break;
      }
      const load1Before = load1();
      const startedAt = new Date().toISOString();
      const outcome = await runProofIn(scratch, options.boundMs);
      const load1After = load1();
      const sample: AttemptSample = {
        attempt,
        seconds: outcome.seconds,
        timedOut: outcome.timedOut,
        exitCode: outcome.code,
        load1Before,
        load1After,
        startedAt,
      };
      attempts.push(sample);
      console.log(
        `[measure] attempt ${attempt}/${options.attempts}: ${outcome.seconds.toFixed(1)}s` +
          `${outcome.timedOut ? " CENSORED (killed by the bound)" : ""} load1 ${
            load1Before.toFixed(1)
          }→${load1After.toFixed(1)}`,
      );
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }

  const uncensored = attempts.filter((a) => !a.timedOut).map((a) => a.seconds);
  const censoredCount = attempts.length - uncensored.length;
  const derivation = deriveLadderConstants(uncensored, censoredCount);

  const record = {
    bead: "audio-feed-8u4x1",
    proof: "scripts/exww-live-claims-browser-proof.ts (unmutated baseline)",
    measuredAt: new Date().toISOString(),
    bound: { perAttemptS: options.boundMs / 1000, deadlineS: options.deadlineMs / 1000 },
    stoppedEarly,
    loadRegime:
      "the host's 1-minute load average around each attempt (Deno.loadavg), sampled before/after — " +
      "the campaign runs alongside the fleet's own gates, so the load is the real gate load, not a synthetic one",
    attempts,
    derivation,
    reproduce:
      "deno run --allow-read --allow-write --allow-run=timeout,deno --allow-sys --allow-env scripts/exww-attempt-measure.ts",
  };
  await Deno.mkdir(resolve(options.outDir), { recursive: true });
  const outPath = join(resolve(options.outDir), "attempts.json");
  await Deno.writeTextFile(outPath, JSON.stringify(record, null, 2) + "\n");
  console.log(
    `[measure] ${derivation.attemptCount} attempt(s) (${derivation.censoredCount} censored): ` +
      `p50 ${derivation.p50S.toFixed(1)}s, p90 ${derivation.p90S.toFixed(1)}s, p99 ${
        derivation.p99S.toFixed(1)
      }s ` +
      `→ ratio ${derivation.ratio}, base ${
        (derivation.baseMs / 1000).toFixed(0)
      }s; wrote ${outPath}`,
  );
  return record;
}

if (import.meta.main) {
  await runCampaign(parseMeasureOptions(Deno.args));
}
