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

Deno.test("mineGitCommits discovers commits touching src/", async () => {
  const commits = await mineGitCommits({ limit: 5 });
  assert(commits.length > 0, "should discover recent commits touching src/");

  for (const c of commits) {
    assert(c.id.startsWith("commit-"), "commit id should start with commit-");
    assertEquals(c.hash.length, 10, "short hash should be 10 characters");
    assertEquals(c.fullHash.length, 40, "full hash should be 40 characters");
    assert(c.date.length === 10, "date should be YYYY-MM-DD");
    assert(c.subject.length > 0, "subject should not be empty");
    assert(typeof c.isSecurityRelated === "boolean");
  }
});

Deno.test("generateHistoryChannel produces non-empty channel with git and beads history", async () => {
  const channel = await generateHistoryChannel({ limit: 10 });
  assertEquals(channel.target, "audio-feed");
  assert(channel.gitFixesCount > 0, "gitFixesCount should be non-zero");
  assert(channel.gitSecurityFixes.length > 0, "gitSecurityFixes should be non-empty");
  assert(channel.beadsBugsCount > 0, "beadsBugsCount should be non-zero");
  assert(channel.beadsBugs.length > 0, "beadsBugs should be non-empty");

  // Verify markdown formatting
  const md = formatMarkdown(channel);
  assert(md.includes("# Threat Model History Channel: audio-feed"));
  assert(md.includes("## 1. Recent Git Commits Touching src/"));
  assert(md.includes("## 2. Recent Beads Bugs & Security Incidents"));

  // Verify JSON formatting
  const jsonStr = formatJson(channel);
  const parsed = JSON.parse(jsonStr);
  assertEquals(parsed.target, "audio-feed");
  assert(Array.isArray(parsed.gitSecurityFixes));
  assert(Array.isArray(parsed.beadsBugs));
});
