/**
 * RFC 9110 HTTP ETag generation and conditional `If-None-Match` evaluation.
 *
 * Shared by RSS feed routes (`src/compose/feeds.ts`) and WebVTT transcript
 * routes (`src/routes/transcript.ts`). Uses Web Crypto (`crypto.subtle`) so it
 * runs identically in Cloudflare Workers (`workerd`), Node 22+, and Deno.
 */

const ENCODER = new TextEncoder();

/** Compute a truncated hex SHA-256 digest of a UTF-8 string. */
export async function sha256Hex(input: string, hexChars = 32): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(input));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length && hex.length < hexChars; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex.slice(0, hexChars);
}

/** Build a quoted strong ETag (`"<hex>"`) or weak ETag (`W/"<hex>"`). */
export async function computeEtag(
  material: string,
  options: { weak?: boolean; hexChars?: number } = {},
): Promise<string> {
  const hex = await sha256Hex(material, options.hexChars ?? 32);
  return options.weak ? `W/"${hex}"` : `"${hex}"`;
}

/**
 * Extract the quoted opaque-tag (`"..."`) for RFC 9110 §8.8.3.2 weak comparison,
 * stripping an optional case-sensitive `W/` prefix. Returns `null` for malformed tokens.
 */
function normalizeWeakOpaqueTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const opaque = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
  if (opaque.length >= 2 && opaque.startsWith('"') && opaque.endsWith('"')) {
    return opaque;
  }
  return null;
}

/**
 * Split a comma-separated `If-None-Match` header value without breaking on
 * commas inside quoted entity-tags.
 */
function splitEntityTagList(header: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) tokens.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const trailing = current.trim();
  if (trailing) tokens.push(trailing);
  return tokens;
}

/**
 * Evaluate an `If-None-Match` header against the current representation's ETag
 * using RFC 9110 §13.1.2 weak comparison.
 *
 * Supports `*`, strong quoted tags (`"abc"`), weak tags (`W/"abc"`), and
 * comma-separated lists (`"old", W/"abc"`).
 */
export function ifNoneMatchMatches(
  ifNoneMatchHeader: string | null | undefined,
  currentEtag: string,
): boolean {
  if (!ifNoneMatchHeader) return false;
  const trimmed = ifNoneMatchHeader.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;

  const target = normalizeWeakOpaqueTag(currentEtag);
  if (!target) return false;

  for (const token of splitEntityTagList(trimmed)) {
    if (token === "*") return true;
    const candidate = normalizeWeakOpaqueTag(token);
    if (candidate !== null && candidate === target) {
      return true;
    }
  }
  return false;
}
