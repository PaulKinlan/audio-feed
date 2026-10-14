/**
 * audio-feed-elnk — ONE JSONC reader for this repo's own config.
 *
 * `deno.json` is JSONC: the project writes comments in it explaining why each block exists, and the
 * project deliberately takes no dependency just to read its own config. Three test files each grew
 * their own way of dealing with that, and the weakest one (strip whole lines whose first non-space
 * characters are `//`) is a trap rather than a shortcut: `"hooks:install": "bash ... // arms the
 * guard"` — an inline comment, which Deno itself accepts — survives the strip and makes `JSON.parse`
 * throw, so a legitimate edit to deno.json reddens a gate with an opaque SyntaxError instead of a
 * named assertion. Reviewers found that on audio-feed-elnk; the fix is that there is now one reader.
 *
 * It is a string-aware scan, not a regex: a `//` inside a string value (a URL in a task command, say)
 * must survive, and a comment must not be able to swallow the next line's `"key":`. The escaper state
 * is what makes `"\\""` terminate the string rather than open a quoted region.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

/** Parse JSONC text the way Deno's own config reader does, minus the comment policy. */
export function parseJsonc<T>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T;
}

/** Parse a JSONC file from disk (relative URLs resolve against the importing module's location). */
export async function readJsonc<T>(url: URL | string): Promise<T> {
  return parseJsonc<T>(await Deno.readTextFile(url));
}
