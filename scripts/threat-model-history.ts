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
 * This script provides the supply-side history channel from within the repository:
 * 1. Mines recent git commits touching `src/`, identifying security-relevant, auth, and bug-fix commits.
 * 2. Mines beads records from `bd export --all`, extracting closed bugs, security issues, and their
 *    accompanying review/resolution comments.
 * 3. Emits either structured JSON (compatible with the threat-model station's input contract)
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
  fullHash: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
  isSecurityRelated: boolean;
}

export interface BeadCommentRecord {
  id?: string;
  author?: string;
  text: string;
  createdAt?: string;
}

export interface BeadsBugRecord {
  id: string;
  title: string;
  issueType: string;
  status: string;
  closeReason?: string | null;
  summarySnippet: string;
  labels: string[];
  updatedAt: string;
  closedAt?: string | null;
  comments: BeadCommentRecord[];
}

export interface ThreatModelHistoryChannel {
  target: string;
  generatedAt: string;
  gitFixesCount: number;
  gitSecurityFixes: GitCommitRecord[];
  beadsBugsCount: number;
  beadsBugs: BeadsBugRecord[];
}

export function isSecurityText(text: string): boolean {
  const lower = text.toLowerCase();
  return SECURITY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Mines recent git commits touching src/ and categorizes them by security relevance. */
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
        "--format=%H|%ad|%an|%s",
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
      const [fullHash, date, author, subject] = line.split("|", 4);
      if (!fullHash || !date || !subject) continue;

      const shortHash = fullHash.slice(0, 10);
      const isSec = isSecurityText(subject) ||
        /^fix(\([^)]+\))?:/i.test(subject) ||
        /^sec(\([^)]+\))?:/i.test(subject) ||
        /\baudio-feed-[a-z0-9]+/i.test(subject);

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
        fullHash,
        date: date.slice(0, 10),
        author: author ?? "unknown",
        subject,
        files,
        isSecurityRelated: isSec,
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
        updated_at?: string;
        closed_at?: string | null;
        comments?: Array<{ id?: string; author?: string; text?: string; created_at?: string }>;
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

      const comments: BeadCommentRecord[] = (issue.comments ?? [])
        .filter((c) => typeof c?.text === "string" && c.text.trim().length > 0)
        .map((c) => ({
          id: c.id,
          author: c.author,
          text: c.text!.trim(),
          createdAt: c.created_at,
        }));

      matched.push({
        id: issue.id,
        title,
        issueType,
        status,
        closeReason: issue.close_reason ?? null,
        summarySnippet: description.slice(0, 200).trim(),
        labels,
        updatedAt: issue.updated_at ?? "",
        closedAt: issue.closed_at ?? null,
        comments,
      });

      if (matched.length >= limit) break;
    }

    return matched;
  } catch (err) {
    console.warn(`[threat-model-history] beads mining error: ${err}`);
    return [];
  }
}

/** Generates the complete ThreatModelHistoryChannel payload. */
export async function generateHistoryChannel(options?: {
  repoRoot?: string;
  limit?: number;
}): Promise<ThreatModelHistoryChannel> {
  const root = options?.repoRoot ?? Deno.cwd();
  const limit = options?.limit ?? 30;

  const [gitCommits, beadsRecords] = await Promise.all([
    mineGitCommits({ repoRoot: root, limit }),
    mineBeadsRecords({ repoRoot: root, limit }),
  ]);

  return {
    target: "audio-feed",
    generatedAt: new Date().toISOString(),
    gitFixesCount: gitCommits.length,
    gitSecurityFixes: gitCommits,
    beadsBugsCount: beadsRecords.length,
    beadsBugs: beadsRecords,
  };
}

/** Formats the history channel as clean Markdown. */
export function formatMarkdown(channel: ThreatModelHistoryChannel): string {
  const lines: string[] = [];

  lines.push(`# Threat Model History Channel: ${channel.target}`);
  lines.push(`Generated: ${channel.generatedAt}`);
  lines.push(`Git security/bug-fix commits touching src/: ${channel.gitFixesCount}`);
  lines.push(`Beads closed bug/security records: ${channel.beadsBugsCount}`);
  lines.push("");

  lines.push("## 1. Recent Git Commits Touching src/");
  if (channel.gitSecurityFixes.length === 0) {
    lines.push("(no git commits discovered)");
  } else {
    for (const c of channel.gitSecurityFixes) {
      const tag = c.isSecurityRelated ? " [SECURITY/FIX]" : "";
      lines.push(`- **${c.hash}** (${c.date}) by ${c.author}${tag}: ${c.subject}`);
      if (c.files.length > 0) {
        lines.push(`  Files: ${c.files.join(", ")}`);
      }
    }
  }
  lines.push("");

  lines.push("## 2. Recent Beads Bugs & Security Incidents");
  if (channel.beadsBugs.length === 0) {
    lines.push("(no beads bug records discovered)");
  } else {
    for (const b of channel.beadsBugs) {
      lines.push(`### [${b.id}] ${b.title}`);
      lines.push(
        `- **Type:** ${b.issueType} | **Status:** ${b.status}${
          b.closedAt ? ` (closed ${b.closedAt.slice(0, 10)})` : ""
        }`,
      );
      if (b.closeReason) {
        lines.push(`- **Close Reason:** ${b.closeReason}`);
      }
      if (b.summarySnippet) {
        lines.push(`- **Summary:** ${b.summarySnippet}`);
      }
      if (b.comments.length > 0) {
        lines.push("- **Comments & Post-Mortem Notes:**");
        for (const comment of b.comments.slice(-3)) {
          const author = comment.author ? `[${comment.author}]` : "[note]";
          const date = comment.createdAt ? ` at ${comment.createdAt.slice(0, 16)}` : "";
          const preview = comment.text.split("\n").slice(0, 4).join(" ").slice(0, 240);
          lines.push(`  - ${author}${date}: ${preview}`);
        }
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
  --limit <n>, -l <n>         Maximum records per category (default: 30)
  --export-beads-jsonl <path> Export issues.jsonl to specified path for host miner consumption
  --dir <path>                Target directory root (default: current working directory)
  --help, -h                  Show this help message
`);
    Deno.exit(0);
  }

  const root = resolve(flags.dir ?? Deno.cwd());
  const limit = flags.limit ? parseInt(flags.limit, 10) : 30;

  const channel = await generateHistoryChannel({ repoRoot: root, limit });

  if (flags["export-beads-jsonl"]) {
    const exportPath = resolve(flags["export-beads-jsonl"]);
    const lines = channel.beadsBugs.map((b) =>
      JSON.stringify({
        id: b.id,
        title: b.title,
        issue_type: b.issueType,
        status: b.status,
        close_reason: b.closeReason,
        description: b.summarySnippet,
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
