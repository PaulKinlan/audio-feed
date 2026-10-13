import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { assertEvidencePngDigest, sha256PngBytes } from "../scripts/evidence-png-digest.ts";

async function checkCommittedEvidence(
  pngPath: URL,
  pngBytes: Uint8Array,
  readme: string,
  filename: string,
): Promise<void> {
  const digest = await sha256PngBytes(pngBytes);
  assertEquals(digest.length, 64);
  const line = await assertEvidencePngDigest(readme, filename, pngBytes);
  console.log(`evidence PNG digest verified: ${pngPath.pathname} sha256=${digest}`);
  assertEquals(line, `- SHA-256 (\`${filename}\`): \`${digest}\``);

  // The SAME verifier must reject a changed artefact with unchanged prose.
  // Mutate only an in-memory copy: no committed evidence file is modified by this control.
  const altered = pngBytes.slice();
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  assertNotEquals(await sha256PngBytes(altered), digest);
  await assertRejects(
    () => assertEvidencePngDigest(readme, filename, altered),
    Error,
    `Evidence PNG digest mismatch for ${filename}`,
  );
}

Deno.test("audio-feed-e3d0: 3asd README digest matches the named committed screenshot", async () => {
  const pngPath = new URL(
    "../docs/evidence/audio-feed-3asd/01-bookmarklet-disclosure-open.png",
    import.meta.url,
  );
  // Direct literal reads keep the fast-gate's derived evidence relation able to select this test.
  const bytes = await Deno.readFile(
    new URL("../docs/evidence/audio-feed-3asd/01-bookmarklet-disclosure-open.png", import.meta.url),
  );
  const readme = await Deno.readTextFile(
    new URL("../docs/evidence/audio-feed-3asd/README.md", import.meta.url),
  );
  await checkCommittedEvidence(pngPath, bytes, readme, "01-bookmarklet-disclosure-open.png");
});

Deno.test("audio-feed-e3d0: kvnw README digest matches the named committed screenshot", async () => {
  const pngPath = new URL(
    "../docs/evidence/audio-feed-kvnw/01-account-bookmarklet-disclosure-open.png",
    import.meta.url,
  );
  const bytes = await Deno.readFile(
    new URL(
      "../docs/evidence/audio-feed-kvnw/01-account-bookmarklet-disclosure-open.png",
      import.meta.url,
    ),
  );
  const readme = await Deno.readTextFile(
    new URL("../docs/evidence/audio-feed-kvnw/README.md", import.meta.url),
  );
  await checkCommittedEvidence(
    pngPath,
    bytes,
    readme,
    "01-account-bookmarklet-disclosure-open.png",
  );
});
