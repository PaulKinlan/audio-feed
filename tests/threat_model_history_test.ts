/**
 * Unit tests for scripts/threat-model-history.ts (audio-feed-j7580).
 */

import { assert, assertEquals } from "@std/assert";
import {
  formatJson,
  formatMarkdown,
  generateHistoryChannel,
  isSecurityText,
  mineGitCommits,
  SECURITY_KEYWORDS,
} from "../scripts/threat-model-history.ts";

Deno.test("isSecurityText correctly identifies security keywords", () => {
  assert(isSecurityText("Fix token validation in auth route"));
  assert(isSecurityText("Prevent SSRF boundary leak"));
  assert(isSecurityText("Rate-limit client requests"));
  assert(isSecurityText("Fix CORS headers"));
  assert(!isSecurityText("Update stylesheet padding"));
});

Deno.test("SECURITY_KEYWORDS includes core security and defect terms", () => {
  assert(SECURITY_KEYWORDS.includes("auth"));
  assert(SECURITY_KEYWORDS.includes("secret"));
  assert(SECURITY_KEYWORDS.includes("token"));
  assert(SECURITY_KEYWORDS.includes("bypass"));
  assert(SECURITY_KEYWORDS.includes("leak"));
});

Deno.test("mineGitCommits discovers commits touching src/ with host record fields", async () => {
  const commits = await mineGitCommits({ limit: 5 });
  assert(commits.length > 0, "should discover recent commits touching src/");

  for (const c of commits) {
    assert(c.id.startsWith("commit-"), "commit id should start with commit-");
    assertEquals(c.hash.length, 10, "short hash should be 10 characters");
    assertEquals(c.date.length, 10, "date should be YYYY-MM-DD");
    assert(c.subject.length > 0, "subject should not be empty");
    assert(Array.isArray(c.files), "files should be an array");

    // Literal host record fields: hash, date, subject, files (mine_history.py:680-685)
    assertEquals(Object.keys(c).sort(), ["date", "files", "hash", "id", "subject"]);
  }
});

Deno.test("generateHistoryChannel produces host-contract compliant schema with exact snake_case keys", async () => {
  const channel = await generateHistoryChannel({ limit: 10 });

  // Verify markdown formatting
  const md = formatMarkdown(channel);
  assert(md.includes("# Threat Model History Channel: audio-feed"));
  assert(md.includes("## 1. Recent Git Commits Touching src/"));
  assert(md.includes("## 2. Recent Beads Bugs & Security Incidents"));

  // Verify JSON formatting and host schema contract compliance
  const jsonStr = formatJson(channel);
  const parsed = JSON.parse(jsonStr);

  // Exact host top-level keys (mine_history.py:987-999)
  assertEquals(parsed["target"], "audio-feed");
  assert(typeof parsed["git_fixes_count"] === "number", "git_fixes_count must be number");
  assert(parsed["git_fixes_count"] > 0, "git_fixes_count should be non-zero");
  assert(Array.isArray(parsed["git_security_fixes"]), "git_security_fixes must be array");
  assert(parsed["git_security_fixes"].length > 0, "git_security_fixes should be non-empty");
  assert(parsed["git_security_fixes"].length <= 25, "git_security_fixes must be capped at 25");

  assert(typeof parsed["beads_bugs_count"] === "number", "beads_bugs_count must be number");
  assert(parsed["beads_bugs_count"] > 0, "beads_bugs_count should be non-zero");
  assert(Array.isArray(parsed["beads_bugs"]), "beads_bugs must be array");
  assert(parsed["beads_bugs"].length > 0, "beads_bugs should be non-empty");
  assert(parsed["beads_bugs"].length <= 25, "beads_bugs must be capped at 25");

  // Literal assertion: forbidden camelCase keys MUST NOT exist
  assert(
    !("gitFixesCount" in parsed),
    "gitFixesCount must not exist (host requires git_fixes_count)",
  );
  assert(
    !("gitSecurityFixes" in parsed),
    "gitSecurityFixes must not exist (host requires git_security_fixes)",
  );
  assert(
    !("beadsBugsCount" in parsed),
    "beadsBugsCount must not exist (host requires beads_bugs_count)",
  );
  assert(!("beadsBugs" in parsed), "beadsBugs must not exist (host requires beads_bugs)");

  // Top-level key set assertion (literal strings)
  const topKeys = Object.keys(parsed).sort();
  assertEquals(topKeys, [
    "beads_bugs",
    "beads_bugs_count",
    "git_fixes_count",
    "git_security_fixes",
    "target",
  ]);

  // Literal assertion for git commit records (mine_history.py:679-685)
  for (const commit of parsed["git_security_fixes"]) {
    assertEquals(Object.keys(commit).sort(), ["date", "files", "hash", "id", "subject"]);
    assert(typeof commit["id"] === "string" && commit["id"].startsWith("commit-"));
    assert(typeof commit["hash"] === "string" && commit["hash"].length === 10);
    assert(typeof commit["date"] === "string" && commit["date"].length === 10);
    assert(typeof commit["subject"] === "string" && commit["subject"].length > 0);
    assert(Array.isArray(commit["files"]));
  }

  // Literal assertion for beads bug records (mine_history.py:726-735)
  for (const bug of parsed["beads_bugs"]) {
    assertEquals(Object.keys(bug).sort(), [
      "close_reason",
      "id",
      "issue_type",
      "status",
      "summary_snippet",
      "title",
    ]);
    assert(typeof bug["id"] === "string" && bug["id"].length > 0);
    assert(typeof bug["title"] === "string");
    assert(typeof bug["issue_type"] === "string");
    assert(typeof bug["status"] === "string");
    assert(bug["close_reason"] === null || typeof bug["close_reason"] === "string");
    assert(typeof bug["summary_snippet"] === "string");

    // Ensure camelCase fields do not leak into beads records
    assert(!("issueType" in bug));
    assert(!("closeReason" in bug));
    assert(!("summarySnippet" in bug));
    assert(!("comments" in bug));
    assert(!("labels" in bug));
  }
});
