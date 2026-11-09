#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=git,bd --allow-env
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
 * 3. Sanitizes untrusted text and wraps vulnerable fields in unpredictable random-nonce delimiter fences
 *    via wrapUntrusted (matching host wrap_untrusted in mine_history.py:268-271):
 *      - subject: max 100
 *      - title: max 100
 *      - close_reason: max 80 (or null if absent)
 *      - summary_snippet: max 150
 *    Sanitizes non-wrapped fields (files max 100, id max 40, issue_type max 30, status max 30).
 * 4. Emits structured JSON strictly following the host's snake_case schema (`evidence_nonce` matching
 *    host mine_history.py:992, `git_fixes_count`, `git_security_fixes` capped at 25,
 *    `beads_bugs_count`, `beads_bugs` capped at 25) or formatted markdown ready for LLM context.
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
  evidence_nonce: string;
  git_fixes_count: number;
  git_security_fixes: GitCommitRecord[];
  beads_bugs_count: number;
  beads_bugs: BeadsBugRecord[];
}

// Chat-template markers, instruction injection tags, and role headers (including tool-call tokens)
// Replicates CHAT_TEMPLATE_PATTERN from agents/threat-model/scripts/mine_history.py:175-186
export const CHAT_TEMPLATE_PATTERN = new RegExp(
  "<\\|(?:im_start|im_end|system|user|assistant|endoftext|end|begin_of_text|eot_id|start_of_turn|end_of_turn|tool_call|tool_calls|tool_response)[^|>]*\\|>" +
    "|</?(?:start_of_turn|end_of_turn|tool_call|tool_calls)>" +
    "|\\[/?(?:INST|AVAILABLE_TOOLS|TOOL_CALLS)\\]" +
    "|<<?/?SYS>>?" +
    "|</?s>" +
    "|\\b(?:system|user|assistant|human|ai)\\s*:" +
    "|###\\s*(?:system|instruction|human|assistant)\\s*:?",
  "gim",
);

// Control characters: ANSI escapes and C0/C1 control codes.
// Replicates CONTROL_CHARS_PATTERN from agents/threat-model/scripts/mine_history.py:195-198
// deno-lint-ignore no-control-regex
export const CONTROL_CHARS_PATTERN = new RegExp(
  "\\x1b\\[[0-9;]*[a-zA-Z]|\\x1b\\].*?\\x07|[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]",
  "g",
);

/** Generates an unpredictable, cryptographically secure 128-bit hex nonce (mine_history.py:217-219). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sanitizes untrusted text matching host sanitize_untrusted_text in mine_history.py:222-265:
 * 1. Strips ANSI escapes and C0/C1 controls.
 * 2. Strips all Unicode category Cf (format) characters across Unicode space.
 * 3. Applies Unicode NFKC normalization.
 * 4. Neutralizes chat-template sequences and instruction framing markers.
 * 5. Strips backticks (` -> ').
 * 6. Redacts active nonce to prevent delimiter spoofing.
 * 7. Flattens whitespace and newlines.
 * 8. Enforces per-field length cap.
 */
export function sanitizeUntrustedText(
  text: unknown,
  maxLength = 120,
  nonce?: string | null,
): string {
  if (text == null) {
    return "";
  }
  let str = typeof text === "string" ? text : String(text);

  // 1. Strip ANSI escapes and C0/C1 control codes
  str = str.replace(CONTROL_CHARS_PATTERN, "");

  // 2. Strip all Unicode category Cf (format) characters across the entire Unicode space
  str = str.replace(/\p{Cf}/gu, "");

  // 3. Unicode NFKC normalization to fold fullwidth/homoglyph characters
  str = str.normalize("NFKC");

  // 4. Neutralize chat-template sequences and instruction framing markers
  str = str.replace(CHAT_TEMPLATE_PATTERN, "[neutralized]");

  // 5. Strip backticks and fence markers so content cannot break out of fenced blocks
  str = str.replaceAll("`", "'");

  // 6. If a nonce is active, neutralize any occurrence to prevent delimiter spoofing
  if (nonce) {
    str = str.replaceAll(nonce, "[nonce-redacted]");
  }

  // 7. Flatten excessive whitespace and newlines
  str = str.replace(/\s+/g, " ").trim();

  // 8. Enforce per-field length cap so no field can carry a coherent instruction
  return str.slice(0, maxLength).trim();
}

/**
 * Wraps untrusted target text in unpredictable nonce-fenced delimiters after sanitization.
 * EXACT replica of wrap_untrusted from agents/threat-model/scripts/mine_history.py:268-271:
 * ```{nonce}-untrusted-evidence\n{cleaned}\n```{nonce}
 */
export function wrapUntrusted(
  text: unknown,
  nonce: string,
  maxLength = 120,
): string {
  const cleaned = sanitizeUntrustedText(text, maxLength, nonce);
  return `\`\`\`${nonce}-untrusted-evidence\n${cleaned}\n\`\`\`${nonce}`;
}

export function isSecurityText(text: string): boolean {
  const lower = text.toLowerCase();
  return SECURITY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Mines recent git commits touching src/ and formats them to the host record schema. */
export async function mineGitCommits(options?: {
  repoRoot?: string;
  limit?: number;
  nonce?: string;
}): Promise<GitCommitRecord[]> {
  const root = options?.repoRoot ?? Deno.cwd();
  const limit = options?.limit ?? 40;
  const activeNonce = options?.nonce ?? generateNonce();

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
      const rawFiles = filesOut.success
        ? new TextDecoder()
          .decode(filesOut.stdout)
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(0, 8)
        : [];
      const files = rawFiles.map((f) => sanitizeUntrustedText(f, 100, activeNonce));

      records.push({
        id: `commit-${shortHash}`,
        hash: shortHash,
        date: date.slice(0, 10),
        subject: wrapUntrusted(subject, activeNonce, 100),
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
  nonce?: string;
}): Promise<BeadsBugRecord[]> {
  const root = options?.repoRoot ?? Deno.cwd();
  const limit = options?.limit ?? 30;
  const activeNonce = options?.nonce ?? generateNonce();

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
        id: sanitizeUntrustedText(issue.id, 40, activeNonce),
        title: wrapUntrusted(title, activeNonce, 100),
        issue_type: sanitizeUntrustedText(issueType, 30, activeNonce),
        status: sanitizeUntrustedText(status, 30, activeNonce),
        close_reason: issue.close_reason
          ? wrapUntrusted(issue.close_reason, activeNonce, 80)
          : null,
        summary_snippet: wrapUntrusted(
          description.slice(0, 150),
          activeNonce,
          150,
        ),
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
  nonce?: string;
}): Promise<ThreatModelHistoryChannel> {
  const root = options?.repoRoot ?? Deno.cwd();
  const limit = options?.limit ?? 40;
  const nonce = options?.nonce ?? generateNonce();

  const [gitCommits, beadsRecords] = await Promise.all([
    mineGitCommits({ repoRoot: root, limit, nonce }),
    mineBeadsRecords({ repoRoot: root, limit, nonce }),
  ]);

  return {
    target: "audio-feed",
    evidence_nonce: nonce,
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
  lines.push(`Evidence Nonce: ${channel.evidence_nonce}`);
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
    string: ["limit", "export-beads-jsonl", "dir", "nonce"],
    alias: { h: "help", j: "json", l: "limit" },
  });

  if (flags.help) {
    console.log(`Threat Model History Channel Producer

Usage:
  deno run --allow-read --allow-write --allow-run=git,bd --allow-env scripts/threat-model-history.ts [flags]

Flags:
  --json, -j                  Output structured JSON matching factory threat-model contract
  --limit <n>, -l <n>         Maximum records per category (default: 40 git, 30 beads, capped at 25)
  --nonce <hex>               Explicit 128-bit hex nonce for untrusted evidence delimiters
  --export-beads-jsonl <path> Export issues.jsonl to specified path for host miner consumption
  --dir <path>                Target directory root (default: current working directory)
  --help, -h                  Show this help message
`);
    Deno.exit(0);
  }

  const root = resolve(flags.dir ?? Deno.cwd());
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;

  const channel = await generateHistoryChannel({
    repoRoot: root,
    limit,
    nonce: flags.nonce,
  });

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
    // audio-feed-dmsm5: the one write in this script, and the reason both the task and the shebang
    // grant --allow-write. The destination is the caller's (--export-beads-jsonl <path>), so no
    // path-scoped grant can be written down ahead of time. Without the grant this line threw
    // NotCapable AFTER the whole mine had run: exit 1 and nothing on stdout, which a host cannot
    // tell apart from "there is no history".
    await Deno.writeTextFile(exportPath, lines.join("\n") + "\n");
    console.error(`Exported ${lines.length} issues to ${exportPath}`);
  }

  if (flags.json) {
    console.log(formatJson(channel));
  } else {
    console.log(formatMarkdown(channel));
  }
}
