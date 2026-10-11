/**
 * A blob store that makes UNSIGNED payload writes impossible to miss (audio-feed-y9kk).
 *
 * THE CLASS DEFECT this closes: the terminal-upload put was made genuinely abortable for
 * audio-feed-aqms, but the same class survived at other call sites — most importantly the
 * segment-commit put, which the turn-stage wrapper raced past while the put kept running as a
 * background zombie (the fsbk shape). A bound that must be REMEMBERED per call site is a bound
 * that comes back the moment somebody adds a call site; this wrapper is the by-construction
 * form: the worker path can only obtain its blob store through here, and a put without an
 * abort signal THROWS instead of silently starting an uninterruptible transfer.
 *
 * The allowlist is explicit and REASONED, never implicit: an entry exists only because that
 * write genuinely cannot take a signal, and its reason is stated where it is declared and
 * warned (once per key) when it fires. An allowlist with no reason is how the original defect
 * survived. The worker path uses an EMPTY allowlist — every worker-path put is signed.
 */
import type { BlobStore } from "./mod.ts";

/** One admitted unsigned write, with the reason it cannot take a signal. */
export interface UnsignedPutAllowlistEntry {
  /** Whether this entry admits the given key. */
  test: (key: string) => boolean;
  /** Why this write may proceed without a signal — stated, never implied. */
  reason: string;
}

export interface BoundedBlobStoreOptions {
  /**
   * Unsigned writes admitted per-key, each with its stated reason. Empty for the worker
   * path: every worker-path payload write must pass an abort signal.
   */
  allowlist?: readonly UnsignedPutAllowlistEntry[];
  /** Warn once per allowlisted key (default true); tests can silence the expected warnings. */
  warnOnAllowlisted?: boolean;
}

export class UnsignedPutError extends Error {
  constructor(key: string, detail: string) {
    super(
      `unsigned payload write refused for "${key}": ${detail} ` +
        `(audio-feed-y9kk: worker-path puts must pass an abort signal so the invocation ` +
        `deadline can interrupt the transfer)`,
    );
    this.name = "UnsignedPutError";
  }
}

/**
 * Wrap a blob store so payload-carrying writes (put, putIfAbsent) are either SIGNED with an
 * abort signal or explicitly allowlisted with a stated reason. Deletes and reads are not
 * bounded: a delete carries no body, so there is no large transfer to interrupt.
 */
export function boundedBlobStore(
  store: BlobStore,
  options: BoundedBlobStoreOptions = {},
): BlobStore {
  const allowlist = options.allowlist ?? [];
  const warn = options.warnOnAllowlisted ?? true;
  const warned = new Set<string>();

  const admit = (key: string): UnsignedPutAllowlistEntry | undefined =>
    allowlist.find((entry) => {
      try {
        return entry.test(key);
      } catch {
        return false;
      }
    });

  const admission = (key: string, caller: string): UnsignedPutError | null => {
    const entry = admit(key);
    if (entry) {
      if (warn && !warned.has(key)) {
        warned.add(key);
        console.warn(
          `[audio-feed] unsigned ${caller} allowed for "${key}": ${entry.reason} (audio-feed-y9kk)`,
        );
      }
      return null;
    }
    return new UnsignedPutError(
      key,
      `no allowlist entry admits it (${allowlist.length} entr${
        allowlist.length === 1 ? "y" : "ies"
      })`,
    );
  };

  const wrapped: BlobStore = {
    // Refusals surface as REJECTIONS, not sync throws, so await-based call sites see one
    // failure mode — the same shape an aborted transfer produces.
    put(key, body, opts) {
      if (!opts?.signal) {
        const refusal = admission(key, "put");
        if (refusal) return Promise.reject(refusal);
      }
      return store.put(key, body, opts);
    },
    putIfAbsent(key, body, opts) {
      if (!opts?.signal) {
        const refusal = admission(key, "putIfAbsent");
        if (refusal) return Promise.reject(refusal);
      }
      return store.putIfAbsent(key, body, opts);
    },
    get(key, opts) {
      return store.get(key, opts);
    },
    head(key) {
      return store.head(key);
    },
    delete(key) {
      return store.delete(key);
    },
    url(key, opts) {
      return store.url(key, opts);
    },
  };
  return wrapped;
}
