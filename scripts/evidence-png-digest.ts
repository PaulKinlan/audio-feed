// Bind a proof-owned README caption to the final PNG bytes, not to a sampled capture or a Git glob.
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export async function sha256PngBytes(bytes: Uint8Array): Promise<string> {
  if (bytes.length < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error("Cannot digest an empty or non-PNG evidence image");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function evidencePngDigestLine(path: string, filename: string): Promise<string> {
  if (!filename.endsWith(".png") || path.split(/[\\/]/).at(-1) !== filename) {
    throw new Error(`Evidence digest filename does not name its PNG path: ${path}`);
  }
  const bytes = await Deno.readFile(path);
  return `- SHA-256 (\`${filename}\`): \`${await sha256PngBytes(bytes)}\``;
}

/** Requires one exact filename/digest line; the README may not silently point at old bytes. */
export async function assertEvidencePngDigest(
  readme: string,
  filename: string,
  pngBytes: Uint8Array,
): Promise<string> {
  const line = `- SHA-256 (\`${filename}\`): \`${await sha256PngBytes(pngBytes)}\``;
  const digestLines = readme.split(/\r?\n/).filter((candidate) =>
    candidate.startsWith("- SHA-256 (")
  );
  if (digestLines.length !== 1 || digestLines[0] !== line) {
    throw new Error(
      `Evidence PNG digest mismatch for ${filename}: expected ${line}, found ${
        digestLines.length === 1 ? digestLines[0] : `${digestLines.length} digest lines`
      }`,
    );
  }
  return line;
}
