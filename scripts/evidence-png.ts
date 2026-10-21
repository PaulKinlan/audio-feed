/**
 * scripts/evidence-png.ts — safe palette quantisation for browser proof evidence (audio-feed-az9j).
 *
 * Replaces inline `convert` invocations across screenshot proof generators with a safe,
 * verified helper that fails loudly rather than silently retaining raw uncompressed PNGs
 * when ImageMagick fails or is missing from PATH.
 *
 * Why named `quantiseEvidencePng`:
 * - Domain: targets evidence screenshots under `docs/evidence/` written by proof scripts.
 * - Operation: quantises 24-bit PNGs to indexed 256-colour (or custom palette) PNG8 with metadata stripped.
 * - Intent: explicit, descriptive, and matches the moral contract approved by coord.
 */

import { getActiveProof } from "./proof-helper.ts";

export interface QuantiseEvidencePngOptions {
  /** Target colour count (default: 256). */
  colors?: number;
  /** Compression level for png:compression-level define (e.g. 9). */
  compressionLevel?: number;
  /** Format prefix (default: "png8"). Site 8 uses "PNG8". */
  formatPrefix?: string;
  /** Explicit opt-out for maintenance tools (e.g. evidence-compress.ts) running outside a proof transaction. */
  allowOutsideProof?: boolean;
  /** Optional injectable runner for unit testing without spawning real binaries. */
  runner?: (
    cmd: string,
    args: string[],
  ) => Promise<{ success: boolean; code: number; stdout?: Uint8Array; stderr?: Uint8Array }>;
  /**
   * The convert binary to spawn (default "convert", resolved via PATH).
   * audio-feed-lnnjd: the seam for the failure-path tests is the BINARY PATH,
   * not process-global PATH mutation and not `runner` — a named binary still
   * exercises the real Deno.Command spawn, while `runner` would mock it away.
   */
  convertBin?: string;
}

/**
 * Quantises an evidence PNG in place to a paletted PNG8 format using ImageMagick `convert`.
 *
 * Guarantees:
 * 1. Byte-for-byte argument compatibility with existing inline calls.
 * 2. Unconditional metadata strip: "-strip" is prepended unconditionally in the helper
 *    so callers cannot drop or omit it, ensuring evidence PNGs carry no encode-time tIME chunks.
 * 3. On spawn failure (e.g. ENOENT): removes the `.tmp` file and throws an Error naming the file and error code.
 * 4. On nonzero exit: removes the `.tmp` file and throws an Error naming the file and exit code.
 * 5. On success: atomically renames `.tmp` over `filePath` and returns `filePath`.
 *
 * @param filePath Absolute or relative path to the PNG image on disk.
 * @param opts Configuration options for colors, compression, format prefix, or runner injection.
 * @returns The resolved `filePath` so callers can chain or push directly into screenshot shot lists.
 */
export async function quantiseEvidencePng(
  filePath: string,
  opts?: QuantiseEvidencePngOptions,
): Promise<string> {
  if (!getActiveProof() && !opts?.allowOutsideProof) {
    throw new Error(
      `quantiseEvidencePng() called outside of runProof() context for '${filePath}'. Evidence must be written inside await runProof(name, async (checker) => { ... }) to ensure atomic rollback and transactional integrity. (Pass allowOutsideProof: true only for non-proof maintenance tools).`,
    );
  }

  const tmpPath = `${filePath}.tmp`;
  const formatPrefix = opts?.formatPrefix ?? "png8";
  const colors = opts?.colors !== undefined ? String(opts.colors) : "256";
  const args = [
    filePath,
    "-strip",
    "-colors",
    colors,
    ...(opts?.compressionLevel !== undefined
      ? ["-define", `png:compression-level=${opts.compressionLevel}`]
      : []),
    `${formatPrefix}:${tmpPath}`,
  ];

  let out: { success: boolean; code: number };
  try {
    if (opts?.runner) {
      out = await opts.runner("convert", args);
    } else {
      const cmd = new Deno.Command(opts?.convertBin ?? "convert", { args });
      out = await cmd.output();
    }
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    const code = (err && typeof err === "object" && "code" in err)
      ? ` (code ${(err as { code: unknown }).code})`
      : "";
    throw new Error(`convert failed for ${filePath}${code}: ${detail}`);
  }

  if (!out.success) {
    await Deno.remove(tmpPath).catch(() => {});
    throw new Error(`convert failed for ${filePath} with exit code ${out.code}`);
  }

  await Deno.rename(tmpPath, filePath);
  return filePath;
}

/**
 * Maintenance entrypoint for post-hoc CLI tools (e.g. evidence-compress.ts)
 * that re-encode committed evidence outside of a proof transaction.
 */
export async function quantiseMaintenancePng(
  filePath: string,
  opts?: Omit<QuantiseEvidencePngOptions, "allowOutsideProof">,
): Promise<string> {
  return await quantiseEvidencePng(filePath, { ...opts, allowOutsideProof: true });
}
