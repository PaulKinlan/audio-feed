/**
 * Shared helpers for the server-rendered pages (home, admin, listen).
 *
 * Extracted so there is ONE definition of each: the admin console and the player
 * both embed request-derived values in a `<script>` block and interpolate text
 * into markup, and a second copy of either helper is how one page ends up escaping
 * correctly while the other does not (the lesson from audio-feed-tww's two feed-URL
 * definitions).
 */

/** Escapes text interpolated into an HTML document. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JSON that is safe inside a `<script>` block.
 *
 * `JSON.stringify` escapes quotes but NOT `<`, so a value containing `</script>`
 * closes the element and everything after it becomes markup. Values here can be
 * request-derived (an origin from a Host header, a feed token from the path),
 * which makes that an injection path rather than a theoretical one.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
