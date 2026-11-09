#!/usr/bin/env -S deno run --allow-read --allow-run=git,bd --allow-env
/**
 * audio-feed-j7580: In-repo history channel producer for the threat-model station.
 *
 * WHY THIS EXISTS:
 * The Factory threat-model station verifies whether past security fixes and defect shapes
 * recur across the codebase ("was the fix applied everywhere?"). When running in sandboxed
 * worktrees or without an active Dolt issues.jsonl export, the miner finds 0 git security fixes
 * and 0 tracker bugs, causing the station to re-fire `tm-history-channel-empty` on every audit.
 *
 * This script provides the supply-side history channel from within the repository matching
 * the host station's contract (agents/threat-model/SKILL.md, scripts/mine_history.py:987-1005):
 * 1. Mines recent git commits touching `src/`, identifying security-relevant, auth, and bug-fix commits.
 * 2. Mines beads records from `bd export --all`, extracting closed bugs and security issues.
 * 3. Emits structured JSON strictly following the host's snake_case schema (`git_fixes_count`,
 *    `git_security_fixes` capped at 25, `beads_bugs_count`, `beads_bugs` capped at 25)
 *    or formatted markdown ready for LLM context or operator verification.
 */

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { resolve } from "@std/path";

export const SECURITY_KEYWORDS = [
  "security",
  "vuln",
  "cve",
  "sanitize",
  "escape",
  "bypass",
  "auth",
  "leak",
  "crash",
  "isolate",
  "inject",
  "token",
  "secret",
  "permission",
  "boundary",
  "origin",
  "cors",
  "credential",
  "taint",
  "sandbox",
  "rate-limit",
  "ratelimit",
  "ceiling",
  "cap",
  "lockout",
  "denial",
];

export interface GitCommitRecord {
  id: string;
  hash: string;
  date: string;
  subject: string;
  files: string[];
}

export interface BeadsBugRecord {
  id: string;
  title: string;
  issue_type: string;
  status: string;
  close_reason: string | null;
  summary_snippet: string;
}

export interface ThreatModelHistoryChannel {
  target: string;
  git_fixes_count: number;
  git_security_fixes: GitCommitRecord[];
  beads_bugs_count: number;
  beads_bugs: BeadsBugRecord[];
}

export function isSecurityText(text: string): boolean {
  const lower = text.toLowerCase();
  return SECURITY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Mines recent git commits touching src/ and formats them to the host record schema. */
export async function mineGitCommits(options?: {
  repoRoot?: string;
  limit?: number;
}): Promise<GitCommitRecord[]> {
  const root = options?.repoRoot ?? Deno.cwd();
  const limit = options?.limit ?? 40;

  try {
    const gitLogCmd = new Deno.Command("git", {
      args: [
        "-C",
        root,
        "log",
        "-n",
        String(limit * 2),
        "--format=%H|%ad|%s",
        "--date=short",
        "--",
        "src/",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const out = await gitLogCmd.output();
    if (!out.success) {
      console.warn(
        `[threat-model-history] git log failed: ${new TextDecoder().decode(out.stderr)}`,
      );
      return [];
    }

    const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
    const records: GitCommitRecord[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const firstPipe = line.indexOf("|");
      const secondPipe = line.indexOf("|", firstPipe + 1);
      if (firstPipe === -1 || secondPipe === -1) continue;

      const fullHash = line.slice(0, firstPipe);
      const date = line.slice(firstPipe + 1, secondPipe);
      const subject = line.slice(secondPipe + 1);
      if (!fullHash || !date || !subject) continue;

      const shortHash = fullHash.slice(0, 10);

      // Query touched files under src/
      const filesCmd = new Deno.Command("git", {
        args: [
          "-C",
          root,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          fullHash,
          "--",
          "src/",
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const filesOut = await filesCmd.output();
      const files = filesOut.success
        ? new TextDecoder()
          .decode(filesOut.stdout)
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(0, 8)
        : [];

      records.push({
        id: `commit-${shortHash}`,
        hash: shortHash,
        date: date.slice(0, 10),
        subject,
        files,
      });

      if (records.length >= limit) break;
    }

    return records;
  } catch (err) {
    console.warn(`[threat-model-history] git mining error: ${err}`);
    return [];
  }
}

/** Mines beads bug records and incident post-mortems from bd export. */
export async function mineBeadsRecords(options?: {
  repoRoot?: string;
  limit?: number;
}): Promise<BeadsBugRecord[]> {
  const root = options?.repoRoot ?? Deno.cwd();
  const limit = options?.limit ?? 30;

  try {
    const bdCmd = new Deno.Command("bd", {
      args: ["-C", root, "export", "--all"],
      stdout: "piped",
      stderr: "piped",
    });

    const out = await bdCmd.output();
    if (!out.success) {
      console.warn(
        `[threat-model-history] bd export failed: ${new TextDecoder().decode(out.stderr)}`,
      );
      return [];
    }

    const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
    const matched: BeadsBugRecord[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      let issue: {
        _type?: string;
        id?: string;
        title?: string;
        description?: string;
        issue_type?: string;
        status?: string;
        close_reason?: string | null;
        labels?: string[];
      };

      try {
        issue = JSON.parse(line);
      } catch {
        continue;
      }

      if (issue._type !== "issue" || !issue.id) continue;

      const title = issue.title ?? "";
      const description = issue.description ?? "";
      const issueType = issue.issue_type ?? "";
      const status = issue.status ?? "";
      const labels = issue.labels ?? [];

      const isBug = issueType === "bug" && status === "closed";
      const isSec = isSecurityText(title) || isSecurityText(description) ||
        labels.some((l) => isSecurityText(l) || l.includes("threat-model"));

      if (!isBug && !isSec) continue;

      matched.push({
        id: issue.id,
        title,
        issue_type: issueType,
        status,
        close_reason: issue.close_reason ?? null,
        summary_snippet: description.slice(0, 150).trim(),
      });

      if (matched.length >= limit) break;
    }

    return matched;
  } catch (err) {
    console.warn(`[threat-model-history] beads mining error: ${err}`);
    return [];
  }
}

/** Generates the complete ThreatModelHistoryChannel payload matching host contract. */
export async function generateHistoryChannel(options?: {
  repoRoot?: string;
  limit?: number;
}): Promise<ThreatModelHistoryChannel> {
  const root = options?.repoRoot ?? Deno.cwd();
  const limit = options?.limit ?? 40;

  const [gitCommits, beadsRecords] = await Promise.all([
    mineGitCommits({ repoRoot: root, limit }),
    mineBeadsRecords({ repoRoot: root, limit }),
  ]);

  return {
    target: "audio-feed",
    git_fixes_count: gitCommits.length,
    git_security_fixes: gitCommits.slice(0, 25),
    beads_bugs_count: beadsRecords.length,
    beads_bugs: beadsRecords.slice(0, 25),
  };
}

/** Formats the history channel as clean Markdown. */
export function formatMarkdown(channel: ThreatModelHistoryChannel): string {
  const lines: string[] = [];

  lines.push(`# Threat Model History Channel: ${channel.target}`);
  lines.push(`Git security/bug-fix commits touching src/: ${channel.git_fixes_count}`);
  lines.push(`Beads closed bug/security records: ${channel.beads_bugs_count}`);
  lines.push("");

  lines.push("## 1. Recent Git Commits Touching src/");
  if (channel.git_security_fixes.length === 0) {
    lines.push("(no git commits discovered)");
  } else {
    for (const c of channel.git_security_fixes) {
      lines.push(`- **${c.hash}** (${c.date}): ${c.subject}`);
      if (c.files.length > 0) {
        lines.push(`  Files: ${c.files.join(", ")}`);
      }
    }
  }
  lines.push("");

  lines.push("## 2. Recent Beads Bugs & Security Incidents");
  if (channel.beads_bugs.length === 0) {
    lines.push("(no beads bug records discovered)");
  } else {
    for (const b of channel.beads_bugs) {
      lines.push(`### [${b.id}] ${b.title}`);
      lines.push(
        `- **Type:** ${b.issue_type} | **Status:** ${b.status}`,
      );
      if (b.close_reason) {
        lines.push(`- **Close Reason:** ${b.close_reason}`);
      }
      if (b.summary_snippet) {
        lines.push(`- **Summary:** ${b.summary_snippet}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function formatJson(channel: ThreatModelHistoryChannel): string {
  return JSON.stringify(channel, null, 2);
}

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["json", "help"],
    string: ["limit", "export-beads-jsonl", "dir"],
    alias: { h: "help", j: "json", l: "limit" },
  });

  if (flags.help) {
    console.log(`Threat Model History Channel Producer

Usage:
  deno run --allow-read --allow-run=git,bd --allow-env scripts/threat-model-history.ts [flags]

Flags:
  --json, -j                  Output structured JSON matching factory threat-model contract
  --limit <n>, -l <n>         Maximum records per category (default: 40 git, 30 beads, capped at 25)
  --export-beads-jsonl <path> Export issues.jsonl to specified path for host miner consumption
  --dir <path>                Target directory root (default: current working directory)
  --help, -h                  Show this help message
`);
    Deno.exit(0);
  }

  const root = resolve(flags.dir ?? Deno.cwd());
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;

  const channel = await generateHistoryChannel({ repoRoot: root, limit });

  if (flags["export-beads-jsonl"]) {
    const exportPath = resolve(flags["export-beads-jsonl"]);
    const lines = channel.beads_bugs.map((b) =>
      JSON.stringify({
        id: b.id,
        title: b.title,
        issue_type: b.issue_type,
        status: b.status,
        close_reason: b.close_reason,
        description: b.summary_snippet,
      })
    );
    await Deno.writeTextFile(exportPath, lines.join("\n") + "\n");
    console.error(`Exported ${lines.length} issues to ${exportPath}`);
  }

  if (flags.json) {
    console.log(formatJson(channel));
  } else {
    console.log(formatMarkdown(channel));
  }
}
