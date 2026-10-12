/**
 * audio-feed-t9w1 — the census predicate is validated on NEGATIVE examples.
 *
 * The predicate this replaces matched the presence of an `audio-feed-*` string
 * in a script's source, which is a proxy for "writes evidence" and not the thing
 * itself. It fired falsely four times in the real tree (two bead ids, two
 * browser probes that commit nothing), and a 31/31 check against real
 * directories could not have caught any of them, because every case it looked at
 * was a real directory. So the fixtures below are mostly EXCLUSIONS, and one of
 * them is a POSITIVE CONTROL of the same shape: a predicate narrowed until it
 * never fires would pass every exclusion here and must fail that control.
 *
 * The last test is the real tree, which cost nothing to add and is the strongest
 * negative control available: the four scripts named on the bead must come out
 * with a mention and no write.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { census, censusSource, EVIDENCE_PREFIX } from "../scripts/evidence-census.ts";

const dir = (id: string) => `audio-feed-${id}`;

Deno.test("a write call whose target is an evidence directory is a writer", () => {
  // Both real shapes: the helper may name the slice directly, because naming it
  // IS its contract, and a generic write must sit under docs/evidence.
  const helper = `
    await writeEvidenceReadme({ dir: "audio-feed-abcd", title: "x", assertions: [] });
  `;
  assertEquals(censusSource(helper).writes, [dir("abcd")]);
  const generic = `
    await Deno.writeTextFile("docs/evidence/audio-feed-wxyz/README.md", content);
  `;
  assertEquals(censusSource(generic).writes, [dir("wxyz")]);
});

Deno.test("a bead id in a COMMENT is not a writer (the s3uk/i7vi false positive)", () => {
  const source = `
    /**
     * audio-feed-abcd — this script drives a real browser and asserts results.
     */
    const result = await page.title();
    console.log(result);
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assertEquals(result.mentions, [dir("abcd")]);
});

Deno.test("a bead id in a STRING that is not a write target is not a writer", () => {
  const source = `
    const key = \`audio-feed-positions:\${TOKEN}\`;
    Deno.env.set("REPORT_DIR", "audio-feed-abcd");
    const raw = localStorage.getItem("audio-feed-abcd");
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assert(result.mentions.length > 0, "the mention must still be visible as a mention");
});

Deno.test("a READ from an evidence directory is not a writer", () => {
  const source = `
    const readme = await Deno.readTextFile("docs/evidence/audio-feed-abcd/README.md");
    const bytes = await Deno.readFile("${EVIDENCE_PREFIX}/audio-feed-abcd/01-x.png");
  `;
  assertEquals(censusSource(source).writes, []);
});

Deno.test("a write to somewhere that is not docs/evidence is not an evidence writer", () => {
  const source = `
    await Deno.writeTextFile("/tmp/audio-feed-abcd-report.txt", report);
    await Deno.writeTextFile("docs/notes.md", "audio-feed-abcd is described here");
  `;
  assertEquals(censusSource(source).writes, []);
});

Deno.test("a browser probe that asserts but commits nothing is not an evidence slice", () => {
  const source = `
    // audio-feed-abcd — probe only, this script commits nothing
    await page.click("#open");
    assertEquals(await page.textContent("#panel"), "Disclosure");
    await chrome.close();
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assertEquals(result.mentions, [dir("abcd")]);
});

Deno.test("POSITIVE CONTROL: the same shapes AS A WRITE TARGET still fire", () => {
  // If a narrowing of the predicate ever switched it off, the exclusions above
  // would all still pass and this would fail.
  const source = `
    const OUT = new URL("../docs/evidence/audio-feed-efgh/", import.meta.url).pathname;
    await Deno.mkdir(OUT, { recursive: true });
    await Deno.writeFile(OUT + "01-shot.png", png);
    await writeEvidenceReadme({ dir: "docs/evidence/audio-feed-ijkl", title: "t", assertions: [] });
  `;
  const result = censusSource(source);
  assertEquals(result.writes.sort(), [dir("efgh"), dir("ijkl")].sort());
});

Deno.test("a write whose evidence target is assembled at runtime is REPORTED, not dropped", () => {
  const source = `
    const name = "audio-feed-" + suffix;
    await Deno.writeFile(\`docs/evidence/\${name}/01-shot.png\`, png);
  `;
  const result = censusSource(source);
  assertEquals(result.writes, []);
  assertEquals(result.runtimeAssembled.length, 1);
});

Deno.test("THE REAL TREE: the four scripts named on the bead write nothing", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const result = await census(root);
  const specimens = [
    "scripts/verify_s3uk_real_browser.ts",
    "scripts/verify_i7vi_events.ts",
    "scripts/verify_i7vi_browser.ts",
    "scripts/verify_s2pi_errors_api.ts",
  ];
  for (const script of specimens) {
    const writes = Object.entries(result.writers)
      .filter(([, scripts]) => scripts.includes(script))
      .map(([dirName]) => dirName);
    assertEquals(writes, [], `${script} must not be counted as a writer`);
    assert(
      result.namingButNotWriting[script]?.length,
      `${script} must still be visible as a mention-only script`,
    );
  }
  // ...and the predicate still finds real writers, or the exclusions above would
  // be satisfied by a predicate that never fires at all.
  assert(
    Object.keys(result.writers).length > 10,
    `expected the real tree to have writers, got ${Object.keys(result.writers).length}`,
  );
});
