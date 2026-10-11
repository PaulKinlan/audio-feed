/** Shared synthesis limit management for any model path that needs multiple bounded turns.
 * The output continuation path may reuse runManagedTurns with a different segment type,
 * split strategy and stitcher; see audio-feed-ls92 for JSON-safe script continuation.
 */

/** Split text under a caller-supplied UTF-8 budget. Prefer natural paragraph/sentence
 * boundaries, then words, then Unicode code points for an unbroken oversized token. */
export function splitTextUnderByteBudget(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error("Synthesis segment byte budget is too small");
  const result: string[] = [];
  const encoder = new TextEncoder();
  let rest = text.trim();
  while (encoder.encode(rest).length > maxBytes) {
    let end = 0;
    let bytes = 0;
    for (const point of rest) {
      const size = encoder.encode(point).length;
      if (bytes + size > maxBytes) break;
      bytes += size;
      end += point.length;
    }
    const available = rest.slice(0, end);
    const preferred = /\n\s*\n|[.!?。！？][”"')\]]?\s+/gu;
    let boundary = 0;
    for (const match of available.matchAll(preferred)) {
      const candidate = match.index + match[0].length;
      if (candidate > end / 2) boundary = candidate;
    }
    if (!boundary) {
      const word = /\s+\S*$/u.exec(available);
      if (word && word.index > end / 2) boundary = word.index;
    }
    if (boundary) end = boundary;
    const segment = rest.slice(0, end).trim();
    if (!segment) throw new Error("Synthesis segment cannot fit in byte budget");
    result.push(segment);
    rest = rest.slice(end).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}

/** Check the exact non-whitespace text sequence, including repeated words and punctuation.
 * Whitespace may move at a breath boundary; a dropped/duplicated spoken character may not.
 * A segment carrying no spoken characters is rejected outright. */
export function assertTextSeams(source: string, turns: readonly string[]): void {
  const compact = (text: string) => text.replace(/\s+/gu, "");
  if (turns.some((turn) => !turn.trim())) {
    throw new Error("Synthesis turn boundary has an empty transcript segment");
  }
  if (compact(turns.join("")) !== compact(source)) {
    throw new Error("Synthesis turn boundary lost or duplicated transcript text");
  }
}

/**
 * Thrown when an ongoing multi-turn synthesis intentionally yields execution
 * back to the queue because an invocation budget (time or segment limit) was reached (audio-feed-vqu4).
 * Completed segments have already been committed to the resume cache.
 */
export class SynthesisYieldError extends Error {
  constructor(
    public readonly completedTurns: number,
    public readonly totalTurns: number,
    message =
      `Synthesis yielded after ${completedTurns}/${totalTurns} turns to respect invocation budget`,
  ) {
    super(message);
    this.name = "SynthesisYieldError";
  }
}

/**
 * Sentinel abort reason used to identify an invocation-budget abort by provenance (audio-feed-zni7).
 * Prevents third-party or provider-originated AbortErrors from being misclassified as budget yields.
 */
export const INVOCATION_BUDGET_ABORT_REASON = Symbol.for("audio-feed.invocation-budget-abort");

export class InvocationBudgetAbortError extends SynthesisYieldError {
  readonly sentinel = INVOCATION_BUDGET_ABORT_REASON;
  constructor(
    completedTurns = 0,
    totalTurns = 0,
    message = "Invocation budget exceeded",
  ) {
    super(completedTurns, totalTurns, message);
    this.name = "InvocationBudgetAbortError";
  }
}

/**
 * Determine if an error originated from our own invocation budget abort by provenance.
 */
export function isInvocationBudgetAbort(error: unknown): boolean {
  if (error instanceof InvocationBudgetAbortError) return true;
  if (error instanceof SynthesisYieldError) return true;
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (rec.sentinel === INVOCATION_BUDGET_ABORT_REASON) return true;
    if (rec.reason && typeof rec.reason === "object") {
      const inner = rec.reason as Record<string, unknown>;
      if (inner.sentinel === INVOCATION_BUDGET_ABORT_REASON) return true;
    }
  }
  return false;
}

/** Worst-case estimated duration for a single TTS turn in ms (audio-feed-9wqt). */
export const ESTIMATED_TTS_TURN_DURATION_MS = 15_000;
/** Worst-case estimated duration for grounded script generation stage in ms (audio-feed-9wqt). */
export const ESTIMATED_SCRIPT_STAGE_DURATION_MS = 20_000;
/** Worst-case estimated duration for terminal audio blob upload in ms (audio-feed-dv4p). */
export const ESTIMATED_UPLOAD_DURATION_MS = 5_000;
/**
 * Assumed upload throughput in bytes per ms (audio-feed-aqms): 10_000 = 10 MB/s.
 *
 * THE ARITHMETIC THIS CONSTANT HAS TO SURVIVE (measured from the repo, 2026-10-13):
 * Gemini TTS emits 24 kHz 16-bit mono PCM = 48_000 B/s of audio. Input is capped
 * at MAX_TTS_INPUT_BYTES (6 KB) x MAX_TTS_SEGMENTS (12) = 72 KB of text ~= 80
 * minutes of narration at typical speaking rates, so the WAV ceiling is
 * 80 min x 48 KB/s ~= 230 MB; a typical 2_000-4_000 word article narrates to
 * 13-27 min = 37-77 MB. To fit the default upload window (45 s budget - 5 s
 * margin = 40 s) those payloads need 1-2 MB/s sustained to R2 from a Deploy
 * isolate; the 230 MB absolute cap needs ~6 MB/s. R2-class object stores
 * sustain an order of magnitude more than that, so 10 MB/s is the planning
 * floor, not the ceiling.
 *
 * NOT MEASURED ON PRODUCTION from this VM (no deploy token): if reality is
 * slower than assumed, the preflight defers more often than it should - and
 * since audio-feed-aqms the put is GENUINELY ABORTABLE (the budget signal is
 * threaded to the underlying fetch), a too-optimistic estimate degrades to an
 * interrupt-and-retry at the deadline, not an uninterruptible await running
 * past the isolate's lifetime. The estimate is advisory; the deadline is the
 * bound. A first version of this constant was 10 (bytes/ms = 10 KB/s) - a
 * units error of 1000x that would have refused every real episode; caught in
 * review before landing.
 */
export const ASSUMED_UPLOAD_BYTES_PER_MS = 10_000;

/**
 * Honest worst-case duration for uploading `byteLength` bytes (audio-feed-aqms).
 *
 * `floorMs` seeds the estimate for small payloads (connection setup, signing, the
 * first write); the byte-scaled term dominates for real episode audio.
 */
export function estimateUploadDurationMs(
  byteLength: number,
  floorMs: number = ESTIMATED_UPLOAD_DURATION_MS,
  bytesPerMs: number = ASSUMED_UPLOAD_BYTES_PER_MS,
): number {
  if (byteLength <= 0 || bytesPerMs <= 0) return Math.max(0, floorMs);
  return Math.max(floorMs, Math.ceil(byteLength / bytesPerMs));
}
/** Safety margin reserved for flushing checkpoints, commits, and claim yields in ms (audio-feed-9wqt). */
export const INVOCATION_FLUSH_MARGIN_MS = 5_000;

export type BudgetedOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "budget-yield"; error: InvocationBudgetAbortError }
  | { kind: "error"; error: unknown };

export interface InvocationBudgetSpec {
  maxDurationMs?: number;
  startTimeMonotonicMs?: number;
}

/**
 * Universal wrapper for EVERY awaitable synthesis stage (audio-feed-dv4p):
 * (a) computes the deadline from the remaining budget minus flush margin.
 * (b) refuses to START if worst case cannot fit (preflight check).
 * (c) passes an AbortSignal tagged with InvocationBudgetAbortError for automatic provenance.
 * (d) returns a typed outcome (completed | budget-yield | error) so the caller cannot forget to handle it.
 */
export interface BudgetedInvocationOptions<T> {
  name: string;
  budget?: InvocationBudgetSpec;
  flushMarginMs?: number;
  worstCaseEstimateMs: number;
  completedTurns?: number;
  totalTurns?: number;
  fn: (signal?: AbortSignal) => Promise<T>;
  /**
   * Optional cleanup handler for uncancellable operations (e.g. background blob put).
   * Called immediately on budget abort/refusal, and ALSO chained onto the in-flight
   * promise so that when the uncancellable operation eventually settles in the background,
   * cleanup executes again idempotently, eliminating races where delayed writes recreate blobs.
   */
  cleanupOnAbort?: () => Promise<void> | void;
}

/**
 * Universal wrapper for EVERY awaitable synthesis stage (audio-feed-dv4p, audio-feed-mv1d, audio-feed-fsbk):
 * (a) computes the deadline from the remaining budget minus flush margin.
 * (b) refuses to START if worst case cannot fit (preflight check).
 * (c) passes an AbortSignal tagged with InvocationBudgetAbortError for automatic provenance.
 * (d) returns a typed outcome (completed | budget-yield | error) so the caller cannot forget to handle it.
 * (e) supports idempotent settlement cleanup for uncancellable background operations.
 */
export async function withInvocationBudget<T>(
  options: BudgetedInvocationOptions<T>,
): Promise<BudgetedOutcome<T>> {
  const { budget } = options;
  if (budget?.maxDurationMs !== undefined && budget?.maxDurationMs > 0) {
    const startTime = budget.startTimeMonotonicMs ?? performance.now();
    const flushMargin = options.flushMarginMs ?? INVOCATION_FLUSH_MARGIN_MS;
    const elapsed = performance.now() - startTime;
    const remaining = budget.maxDurationMs - elapsed;
    const available = remaining - flushMargin;

    // (b) Preflight check: refuse to start if worst-case estimate cannot fit
    if (available < options.worstCaseEstimateMs) {
      if (options.cleanupOnAbort) {
        try {
          await options.cleanupOnAbort();
        } catch {
          // best-effort immediate cleanup
        }
      }
      const error = new InvocationBudgetAbortError(
        options.completedTurns ?? 0,
        options.totalTurns ?? 0,
        `Invocation budget preflight refused stage "${options.name}": available ${
          Math.round(Math.max(0, available))
        }ms < worst-case estimate ${options.worstCaseEstimateMs}ms`,
      );
      return { kind: "budget-yield", error };
    }

    // (a) Compute deadline from remaining budget
    const timeoutMs = Math.max(0, available);
    const controller = new AbortController();
    const abortErr = new InvocationBudgetAbortError(
      options.completedTurns ?? 0,
      options.totalTurns ?? 0,
      `Invocation budget deadline (${
        Math.round(timeoutMs)
      }ms) exceeded during stage "${options.name}"`,
    );

    const timer = setTimeout(() => {
      // (c) Passes AbortSignal tagged with InvocationBudgetAbortError (automatic provenance)
      controller.abort(abortErr);
    }, timeoutMs);

    try {
      const stagePromise = options.fn(controller.signal);
      if (options.cleanupOnAbort) {
        // (e) Settlement cleanup: hook into uncancellable promise so delayed background
        // operations trigger cleanup upon resolution, preventing recreated/orphaned blobs.
        stagePromise
          .finally(async () => {
            if (controller.signal.aborted) {
              try {
                await options.cleanupOnAbort?.();
              } catch {
                // idempotent settlement cleanup
              }
            }
          })
          .catch(() => {}); // stagePromise is already awaited via Promise.race; avoid unhandled rejection
      }
      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason);
        }, { once: true });
      });
      const value = await Promise.race([stagePromise, abortPromise]);
      // (d) Typed outcome: completed
      return { kind: "completed", value };
    } catch (error) {
      if (controller.signal.aborted) {
        if (options.cleanupOnAbort) {
          try {
            await options.cleanupOnAbort();
          } catch {
            // best-effort immediate cleanup
          }
        }
        const reason = controller.signal.reason;
        const yieldErr = isInvocationBudgetAbort(reason)
          ? (reason as InvocationBudgetAbortError)
          : abortErr;
        // (d) Typed outcome: budget-yield
        return { kind: "budget-yield", error: yieldErr };
      }
      if (isInvocationBudgetAbort(error)) {
        if (options.cleanupOnAbort) {
          try {
            await options.cleanupOnAbort();
          } catch {
            // best-effort immediate cleanup
          }
        }
        // (d) Typed outcome: budget-yield
        return { kind: "budget-yield", error: error as InvocationBudgetAbortError };
      }
      // (d) Typed outcome: error
      return { kind: "error", error };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // Unbounded invocation
  try {
    const value = await options.fn();
    return { kind: "completed", value };
  } catch (error) {
    if (isInvocationBudgetAbort(error)) {
      return { kind: "budget-yield", error: error as InvocationBudgetAbortError };
    }
    return { kind: "error", error };
  }
}

/** Limit total paid turns, including a refused output and its smaller replacements.
 * Failed turns are never silently added to the stitched result. */
export async function runManagedTurns<T, R, S = R>(options: {
  segments: T[];
  maxTurns: number;
  /** Completed turns let a text model request a continuation with overlap context. */
  request: (segment: T, completed: readonly R[]) => Promise<R>;
  splitOnOutputLimit?: (segment: T, error: unknown) => T[] | null;
  /** A model may return a safe partial completion along with a continuation cursor.
   * The caller alone decides whether its partial output is valid for stitching; incomplete
   * structured JSON must not be accepted until its continuation strategy validates it. */
  continueOnOutputLimit?: (
    segment: T,
    error: unknown,
    completed: readonly R[],
  ) => { partial?: R; next: T[] } | null;
  stitch: (results: R[]) => S;
  /** Optional callback invoked as each turn begins (1-indexed turn, total turns). */
  onProgress?: (turn: number, total: number) => Promise<void> | void;
  /** Preflight check invoked before each turn begins whether the invocation should yield (audio-feed-vqu4, audio-feed-9wqt). */
  shouldYield?: (completedCount: number, totalCount: number) => boolean;
}): Promise<S> {
  const {
    segments,
    maxTurns,
    request,
    splitOnOutputLimit,
    continueOnOutputLimit,
    stitch,
    onProgress,
    shouldYield,
  } = options;
  if (segments.length === 0 || segments.length > maxTurns) {
    throw new Error(`Synthesis needs ${segments.length} turns (limit ${maxTurns})`);
  }
  const results: R[] = [];
  let calls = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    // Preflight yield check: check BEFORE starting this turn whether the invocation budget can fit it (audio-feed-9wqt)
    if (shouldYield?.(results.length, segments.length)) {
      throw new SynthesisYieldError(
        results.length,
        segments.length,
        `Synthesis yielded before turn ${
          index + 1
        }/${segments.length} to respect invocation budget`,
      );
    }
    if (onProgress) {
      await onProgress(index + 1, segments.length);
    }
    try {
      calls++;
      results.push(await request(segment, results));
    } catch (error) {
      const continuation = continueOnOutputLimit?.(segment, error, results);
      const replacement = continuation?.next ?? splitOnOutputLimit?.(segment, error);
      if (
        !replacement || replacement.length < (continuation?.partial === undefined ? 2 : 1) ||
        calls >= maxTurns || segments.length + replacement.length - 1 > maxTurns
      ) throw error;
      if (continuation?.partial !== undefined) results.push(continuation.partial);
      segments.splice(index, 1, ...replacement);
      index--;
      continue;
    }
  }
  return stitch(results);
}
