// Evidence capture for audio-feed-ldsb (byline chrome in the spoken intro).
//
// Re-capture:  deno run -A docs/evidence/audio-feed-ldsb/capture.ts <output-file>
//
// Input is the bram.us page vendored for audio-feed-sa4g (same bytes, fetched
// 2026-10-06), so before/after runs compare identical input. It dumps the
// extracted author and the direct-mode narration's opening lines — the words a
// listener hears first (audioPayload -> formatNarrationIntro).
import { audioPayload, extractArticle } from "../../../src/ingest/url.ts";

const here = new URL(".", import.meta.url).pathname;
const out = Deno.args[0] ?? "/dev/stdout";
const html = await Deno.readTextFile(`${here}../audio-feed-sa4g/article.html`);
const article = extractArticle(html, "https://www.bram.us/2026/09/23/show-keystrokes/");
const payload = audioPayload(article, "direct");
if (payload.mode !== "direct") throw new Error("expected direct payload");

const lines: string[] = [];
const add = (s = "") => lines.push(s);
add("# audio-feed-ldsb evidence capture");
add(
  "# url: https://www.bram.us/2026/09/23/show-keystrokes/ (vendored ../audio-feed-sa4g/article.html)",
);
add("# command: deno run -A docs/evidence/audio-feed-ldsb/capture.ts <out>");
add();
add("=== EXTRACTED AUTHOR ===");
add(article.author ?? "(null)");
add();
add("=== DIRECT-MODE NARRATION, first 3 lines (what TTS reads first) ===");
for (const line of payload.narration.split("\n\n").slice(0, 3)) add(line);
await Deno.writeTextFile(out, lines.join("\n") + "\n");
console.log(`wrote ${out}`);
