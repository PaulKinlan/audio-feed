/**
 * Blob-key shape guard, shared by the HTTP routes and the blob stores.
 *
 * THE CLASS DEFECT this closes: the blob store percent-encoded each key segment but did not
 * reject dot segments, so `..` crossed the persistence boundary intact and safety depended on
 * every caller remembering `isSafeBlobKey`. A single new caller that forgot re-opened path
 * traversal at the pending layer. The predicate lives HERE — below both the routes and the
 * stores — so the store can enforce exactly what the routes enforce instead of a second,
 * slightly different copy that drifts.
 */

/** Rejected: a key whose shape could escape the store prefix. */
export class InvalidBlobKeyError extends Error {
  constructor(readonly key: string) {
    super(
      `refused blob key ${JSON.stringify(key)}: keys must satisfy isSafeBlobKey ` +
        `(no absolute or dot segments, no empty segments, no backslashes, no NUL, ` +
        `at most 512 characters, also after percent-decoding)`,
    );
    this.name = "InvalidBlobKeyError";
  }
}

/** Blob keys are path-shaped; reject anything that tries to escape the prefix. */
export function isSafeBlobKey(key: string): boolean {
  if (!isSafeKeyShape(key)) return false;
  // A key that was already percent-decoded somewhere upstream is the same key: `%2e%2e` is
  // `..` once decoded, so the decoded form is held to the identical shape.
  const decoded = decodePercent(key);
  return decoded !== null && isSafeKeyShape(decoded);
}

/**
 * Fail-closed form for the persistence boundary: throw before an unsafe key reaches a store
 * URL, a signing step, or a fetch. Typed so callers can distinguish a refusal from a
 * transport failure.
 */
export function assertSafeBlobKey(key: string): void {
  if (!isSafeBlobKey(key)) throw new InvalidBlobKeyError(key);
}

function isSafeKeyShape(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (key.startsWith("/") || key.endsWith("/") || key.includes("//")) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  return !key.split("/").some((segment) => segment === "." || segment === "..");
}

function decodePercent(key: string): string | null {
  try {
    return decodeURIComponent(key);
  } catch {
    // Malformed percent-encoding cannot be reasoned about, so it is refused rather than
    // passed through: the only keys that exist are built by this codebase.
    return null;
  }
}
