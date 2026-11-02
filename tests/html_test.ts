/**
 * The shared HTML escaper (audio-feed-g8ss9).
 *
 * THE DEFECT: esc() escaped `& < > "` but NOT the single quote, so a value put
 * into a single-quoted attribute (`title='...'`) could break out of the
 * attribute. No current site interpolates into a single-quoted attribute, so
 * the gap was latent — but home.ts also carried a SECOND private copy of the
 * same escaper, defeating html.ts's one-definition invariant (the
 * audio-feed-tww lesson): the copies were identical today and free to drift
 * tomorrow, which is exactly how one page ends up escaping correctly while
 * another does not. Now html.ts owns the ONE escaper (single quote included)
 * and home.ts imports it.
 */

import { assert, assertEquals } from "@std/assert";
import { esc } from "../src/routes/html.ts";

Deno.test("g8ss9: esc() escapes the single quote as &#39;", () => {
  assertEquals(esc("it's"), "it&#39;s");
  // All five metacharacters in one value, `&` first so nothing is double-encoded.
  assertEquals(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  // A single-quoted attribute context stays closed: the payload's quotes cannot
  // terminate the attribute. (`=` needs no escaping in an attribute value.)
  assertEquals(esc(`' onmouseover='alert(1)`), `&#39; onmouseover=&#39;alert(1)`);
});

Deno.test("g8ss9: exactly ONE `function esc(` definition exists under src/ — src/routes/html.ts", async () => {
  // Asserted precisely: walking every .ts file under src/, the pattern
  // /function esc\(/ occurs in exactly ONE file, and that file is
  // src/routes/html.ts. (`escapeRegExp`/`escapeXml` do not match: the pattern
  // requires `esc(` immediately after `function `.) A second private escaper
  // copy anywhere under src/ — the defect this bead fixed in home.ts — reddens
  // this row.
  const srcRoot = new URL("../src/", import.meta.url);
  const definitions: string[] = [];

  async function walk(dir: URL): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      // readDir + a computed name stays a DYNAMIC read (the h7rhb lesson): no
      // authored hint, so one unresolved hint cannot disable the relation for
      // every change.
      if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir));
      else if (entry.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(new URL(entry.name, dir));
        if (/function esc\(/.test(text)) {
          definitions.push(new URL(entry.name, dir).href.replace(srcRoot.href, "src/"));
        }
      }
    }
  }

  await walk(srcRoot);
  assertEquals(definitions, ["src/routes/html.ts"]);
  assert(
    definitions.length === 1,
    `expected exactly one escaper definition, found: ${definitions.join(", ")}`,
  );
});
