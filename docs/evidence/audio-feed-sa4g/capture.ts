// Evidence capture for audio-feed-sa4g (https://www.bram.us/2026/09/23/show-keystrokes/).
//
// Re-capture:  deno run -A docs/evidence/audio-feed-sa4g/capture.ts <output-file>
// The input HTML is the page fetched 2026-10-06 and vendored next to this script
// (article.html), so before/after runs compare the same bytes.
//
// It dumps the EXACT text that reaches the script/TTS layer: the direct-mode
// narration is [title, author, date, lead, body] (audioPayload) and the deep-dive
// script prompt carries title + body. Rows that matter here: the lead and the
// first body paragraphs.
import { extractArticle } from "../../../src/ingest/url.ts";

const here = new URL(".", import.meta.url).pathname;
const out = Deno.args[0] ?? "/dev/stdout";
const html = await Deno.readTextFile(`${here}article.html`);
const article = extractArticle(html, "https://www.bram.us/2026/09/23/show-keystrokes/");

const lines: string[] = [];
const add = (s = "") => lines.push(s);
add("# audio-feed-sa4g evidence capture");
add(`# url: https://www.bram.us/2026/09/23/show-keystrokes/ (fetched 2026-10-06, vendored article.html)`);
add(`# command: deno run -A docs/evidence/audio-feed-sa4g/capture.ts <out>`);
add(`# extractor: src/ingest/url.ts extractArticle() -> article.lead / article.body`);
add();
add("=== TITLE ===");
add(article.title);
add("=== AUTHOR ===");
add(article.author ?? "(null)");
add("=== PUBLISHED ===");
add(article.publishedAt ?? "(null)");
add("=== LEAD (narrated right after the intro by formatNarrationIntro) ===");
add(article.lead);
add();
add(`=== BODY — first 40 paragraphs of ${article.body.split("\n\n").length} ===`);
for (const [i, p] of article.body.split("\n\n").slice(0, 40).entries()) add(`[${i}] ${p}`);
await Deno.writeTextFile(out, lines.join("\n") + "\n");
console.log(`wrote ${out}`);
