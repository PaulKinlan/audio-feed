#!/usr/bin/env -S deno run -A
/**
 * audio-feed-9ara — a closed [modern-web] bead must record a premise verdict.
 *
 * The factory's beads sink skips a candidate whose canonical feature id is already on a bead in
 * any state, so a duplicate is never *emitted* twice. What it cannot do is stop a bead being
 * closed with nothing recorded: d5c / 1vi / t8p were closed with their reasoning only in the
 * close-reason field (not in comments, where lanes look), and one lane later implemented a
 * contract nothing produced (pzwe) after re-deriving a premise a comment would have settled.
 *
 * A closed bead counts as recorded when EITHER
 *   - the bead has at least one comment, OR
 *   - its close reason is substantive (anything but empty or bd's default "Closed").
 *
 * Usage: deno run -A scripts/check-modern-web-verdicts.ts [--bd-bin <path>] [--json]
 * Exit 0 = every closed [modern-web] bead records its verdict; 1 = violations are listed.
 */

export interface BeadRow {
  id: string;
  title?: string;
  status?: string;
  close_reason?: string;
  comment_count?: number;
}

export function isModernWebBead(row: BeadRow): boolean {
  return String(row.title ?? "").includes("[modern-web]");
}

/** bd's default close reason ("Closed") records nothing; a comment also counts as a record. */
export function hasRecordedVerdict(row: BeadRow): boolean {
  const reason = String(row.close_reason ?? "").trim();
  if (reason.length > 0 && !/^closed$/i.test(reason)) return true;
  return Number(row.comment_count ?? 0) > 0;
}

/** The closed [modern-web] beads that record no verdict at all. */
export function verdictViolations(rows: BeadRow[]): BeadRow[] {
  return rows.filter((row) =>
    row?.status === "closed" && isModernWebBead(row) && !hasRecordedVerdict(row)
  );
}

function flagValue(name: string): string | null {
  const i = Deno.args.indexOf(name);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] ?? null : null;
}

function bdList(bdBin: string): BeadRow[] {
  const res = new Deno.Command(bdBin, {
    args: ["list", "--status", "closed", "--limit", "0", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const stderr = new TextDecoder().decode(res.stderr).trim();
  if (res.code !== 0) {
    throw new Error(`bd list failed (${res.code})${stderr ? `: ${stderr}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(res.stdout) || "[]");
  } catch {
    throw new Error("bd list did not return JSON");
  }
  if (Array.isArray(parsed)) return parsed as BeadRow[];
  const wrapped = (parsed as { issues?: unknown })?.issues;
  return Array.isArray(wrapped) ? (wrapped as BeadRow[]) : [];
}

if (import.meta.main) {
  const bdBin = flagValue("--bd-bin") ?? "bd";
  const asJson = Deno.args.includes("--json");
  try {
    const rows = bdList(bdBin);
    const violations = verdictViolations(rows);
    if (asJson) {
      console.log(JSON.stringify(violations, null, 2));
    } else if (violations.length > 0) {
      console.error(
        `[9ara] ${violations.length} closed [modern-web] bead(s) record no premise verdict:`,
      );
      for (const row of violations) console.error(`  ${row.id}: ${row.title ?? ""}`);
      console.error(
        'Record one with: bd close <id> --reason "premise verdict: no producer of <thing> in src/; scanner artefact" (or a comment).',
      );
    } else {
      console.log(
        `[9ara] every closed [modern-web] bead records a premise verdict (checked ${rows.length} closed bead(s)).`,
      );
    }
    Deno.exit(violations.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(`[9ara] check could not run: ${error instanceof Error ? error.message : error}`);
    Deno.exit(1);
  }
}
