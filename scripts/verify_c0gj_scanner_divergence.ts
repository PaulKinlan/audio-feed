/**
 * scripts/verify_c0gj_scanner_divergence.ts
 *
 * Committed artefact harness for verifying code-block scanner divergence across branches
 * for issue audio-feed-diqd (investigating audio-feed-c0gj).
 *
 * Evaluates:
 * 1. origin/main baseline regex (commit 4e402eb)
 * 2. fleet/audit1 implementation (tip f70e3fa, tree f330bb5)
 * 3. fleet/fixc0gj v1 initial implementation (tip 9f18cc1, tree c64c0b6)
 * 4. fleet/fixc0gj v2 repaired tip (tip 3d32fc4, tree 09976b8)
 *
 * Verifies equivalence on both "skip" mode (narration text) and "explain" mode,
 * as well as raw extracted block matches [{ full, code, index }].
 *
 * Usage:
 *   deno run --allow-run=git scripts/verify_c0gj_scanner_divergence.ts
 *   deno run scripts/verify_c0gj_scanner_divergence.ts --fuzz-count 10000
 */

export interface CodeBlockMatch {
  index: number;
  full: string;
  code: string;
}

export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// ============================================================================
// 1. BASELINE IMPLEMENTATION (origin/main)
// ============================================================================
export const MAIN_REGEX =
  /(?:```+|~~~+)(?:[^\n\r]*\r?\n)?([\s\S]*?)(?:```+|~~~+)|<pre\b[^>]*>(?:<code\b[^>]*>)?([\s\S]*?)(?:<\/code>)?<\/pre>/gi;

export function extractCodeBlocks_main(text: string): CodeBlockMatch[] {
  const matches: CodeBlockMatch[] = [];
  MAIN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MAIN_REGEX.exec(text)) !== null) {
    const rawCode = match[1] ?? (match[2] ? decodeHtmlEntities(match[2]) : "");
    matches.push({ full: match[0], code: rawCode.trim(), index: match.index });
  }
  return matches;
}

export function formatCodeForTts_main(
  text: string,
  codeHandling: "skip" | "explain" = "skip",
  summarizer: (code: string) => string = (c) => `summary(${c})`,
): string {
  if (!MAIN_REGEX.test(text)) {
    return text;
  }
  MAIN_REGEX.lastIndex = 0;

  if (codeHandling === "explain") {
    const matches: CodeBlockMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = MAIN_REGEX.exec(text)) !== null) {
      const rawCode = match[1] ?? (match[2] ? decodeHtmlEntities(match[2]) : "");
      matches.push({ full: match[0], code: rawCode.trim(), index: match.index });
    }

    let result = "";
    let lastIndex = 0;
    for (const m of matches) {
      result += text.slice(lastIndex, m.index);
      const explanation = summarizer(m.code);
      if (explanation) {
        result += `\nHere is what that code does: ${explanation}\n`;
      }
      lastIndex = m.index + m.full.length;
    }
    result += text.slice(lastIndex);
    return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
  }

  return text
    .replace(MAIN_REGEX, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n\n");
}

// ============================================================================
// 2. AUDIT1 IMPLEMENTATION (fleet/audit1: tip f70e3fa)
// ============================================================================
const WORD_CHAR_AUDIT1 = /[A-Za-z0-9_]/;
const PRE_OPEN_AUDIT1 = /<pre/gi;
const CODE_OPEN_AUDIT1 = /<code/gi;
const PRE_CLOSE_AUDIT1 = /<\/pre>/gi;
const CODE_CLOSE_AUDIT1 = /<\/code>/gi;

function nextCi_audit1(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? match.index : -1;
}

function nextFenceRun_audit1(
  text: string,
  from: number,
): { index: number; end: number } | null {
  const ticks = text.indexOf("```", from);
  const tildes = text.indexOf("~~~", from);
  const index = ticks < 0 ? tildes : tildes < 0 ? ticks : Math.min(ticks, tildes);
  if (index < 0) return null;
  const char = text[index];
  let end = index;
  while (end < text.length && text[end] === char) end++;
  return { index, end };
}

function nextPreTag_audit1(
  text: string,
  from: number,
): { index: number; end: number } | null {
  let index = nextCi_audit1(PRE_OPEN_AUDIT1, text, from);
  while (index >= 0) {
    const after = text[index + 4];
    if (after !== undefined && !WORD_CHAR_AUDIT1.test(after)) {
      const close = text.indexOf(">", index + 4);
      if (close >= 0) return { index, end: close + 1 };
    }
    index = nextCi_audit1(PRE_OPEN_AUDIT1, text, index + 1);
  }
  return null;
}

function fenceInfoEnd_audit1(text: string, openerEnd: number): number | null {
  let lineEnd = openerEnd;
  while (lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") {
    lineEnd++;
  }
  if (text[lineEnd] === "\n") return lineEnd + 1;
  if (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n") return lineEnd + 2;
  return null;
}

function matchFence_audit1(
  text: string,
  run: { index: number; end: number },
): CodeBlockMatch | null {
  const length = run.end - run.index;
  const shortest = Math.max(3, length - 3);
  for (let openerLength = length; openerLength >= shortest; openerLength--) {
    const openerEnd = run.index + openerLength;
    const infoEnd = fenceInfoEnd_audit1(text, openerEnd);
    for (const contentStart of infoEnd === null ? [openerEnd] : [infoEnd, openerEnd]) {
      const close = nextFenceRun_audit1(text, contentStart);
      if (close) {
        return {
          index: run.index,
          full: text.slice(run.index, close.end),
          code: text.slice(contentStart, close.index).trim(),
        };
      }
    }
  }
  return null;
}

function codeTagEnd_audit1(text: string, from: number): number | null {
  if (nextCi_audit1(CODE_OPEN_AUDIT1, text, from) !== from) return null;
  const after = text[from + 5];
  if (after === undefined || WORD_CHAR_AUDIT1.test(after)) return null;
  const close = text.indexOf(">", from + 5);
  return close < 0 ? null : close + 1;
}

function matchPreAt_audit1(
  text: string,
  tag: { index: number; end: number },
  contentStart: number,
): CodeBlockMatch | null {
  const pre = nextCi_audit1(PRE_CLOSE_AUDIT1, text, contentStart);
  if (pre < 0) return null;
  let contentEnd = pre;
  if (pre - 7 >= contentStart && nextCi_audit1(CODE_CLOSE_AUDIT1, text, pre - 7) === pre - 7) {
    contentEnd = pre - 7;
  }
  return {
    index: tag.index,
    full: text.slice(tag.index, pre + 6),
    code: decodeHtmlEntities(text.slice(contentStart, contentEnd)).trim(),
  };
}

function matchPre_audit1(
  text: string,
  tag: { index: number; end: number },
): CodeBlockMatch | null {
  const codeEnd = codeTagEnd_audit1(text, tag.end);
  if (codeEnd !== null) {
    const withCode = matchPreAt_audit1(text, tag, codeEnd);
    if (withCode) return withCode;
  }
  return matchPreAt_audit1(text, tag, tag.end);
}

export function extractCodeBlocks_audit1(text: string): CodeBlockMatch[] {
  const blocks: CodeBlockMatch[] = [];
  let fencesExhausted = false;
  let presExhausted = false;
  let from = 0;
  while (from < text.length) {
    const fence = fencesExhausted ? null : nextFenceRun_audit1(text, from);
    const pre = presExhausted ? null : nextPreTag_audit1(text, from);
    if (!fence && !pre) break;
    if (fence && (!pre || fence.index < pre.index)) {
      const block = matchFence_audit1(text, fence);
      if (block) {
        blocks.push(block);
        from = block.index + block.full.length;
      } else {
        fencesExhausted = true;
      }
    } else {
      const block = matchPre_audit1(text, pre!);
      if (block) {
        blocks.push(block);
        from = block.index + block.full.length;
      } else {
        presExhausted = true;
      }
    }
  }
  return blocks;
}

export function formatCodeForTts_audit1(
  text: string,
  codeHandling: "skip" | "explain" = "skip",
  summarizer: (code: string) => string = (c) => `summary(${c})`,
): string {
  const matches = extractCodeBlocks_audit1(text);
  if (matches.length === 0) {
    return text;
  }

  if (codeHandling === "explain") {
    let result = "";
    let lastIndex = 0;
    for (const m of matches) {
      result += text.slice(lastIndex, m.index);
      const explanation = summarizer(m.code);
      if (explanation) {
        result += `\nHere is what that code does: ${explanation}\n`;
      }
      lastIndex = m.index + m.full.length;
    }
    result += text.slice(lastIndex);
    return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
  }

  let stripped = "";
  let cursor = 0;
  for (const m of matches) {
    stripped += text.slice(cursor, m.index);
    cursor = m.index + m.full.length;
  }
  stripped += text.slice(cursor);
  return stripped.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
}

// ============================================================================
// 3. FIXC0GJ V1 INITIAL IMPLEMENTATION (fleet/fixc0gj: tip 9f18cc1)
// ============================================================================
export function extractCodeBlocks_fixc0gj_9f18cc1(text: string): CodeBlockMatch[] {
  if (!text.includes("```") && !text.includes("~~~") && !/<pre\b/i.test(text)) {
    return [];
  }

  const matches: CodeBlockMatch[] = [];
  const openerRegex = /(?:`{3,}|~{3,})|<pre\b[^>]*>/gi;
  const codeOpenRegex = /<code\b[^>]*>/iy;
  const infoRegex = /[^\n\r]*\r?\n/y;
  const closePreRegex = /<\/pre>/gi;
  const closeBackticksRegex = /`{3,}/g;
  const closeTildesRegex = /~{3,}/g;

  let hasMorePre = true;
  let hasMoreBackticks = true;
  let hasMoreTildes = true;

  while (true) {
    if (!hasMorePre && !hasMoreBackticks && !hasMoreTildes) {
      break;
    }

    const match = openerRegex.exec(text);
    if (!match) break;

    const opener = match[0];
    const startIndex = match.index;

    if (opener.startsWith("<")) {
      if (!hasMorePre) {
        continue;
      }
      const afterPre = startIndex + opener.length;
      let contentStart = afterPre;
      codeOpenRegex.lastIndex = afterPre;
      const codeMatch = codeOpenRegex.exec(text);
      if (codeMatch) {
        contentStart = afterPre + codeMatch[0].length;
      }

      closePreRegex.lastIndex = contentStart;
      const closeMatch = closePreRegex.exec(text);
      if (!closeMatch) {
        hasMorePre = false;
        continue;
      }

      const closeIndex = closeMatch.index;
      let contentEnd = closeIndex;
      if (
        closeIndex >= contentStart + 7 &&
        text.slice(closeIndex - 7, closeIndex).toLowerCase() === "</code>"
      ) {
        contentEnd = closeIndex - 7;
      }

      const rawCode = decodeHtmlEntities(text.slice(contentStart, contentEnd));
      matches.push({
        full: text.slice(startIndex, closeIndex + closeMatch[0].length),
        code: rawCode.trim(),
        index: startIndex,
      });
      openerRegex.lastIndex = closeIndex + closeMatch[0].length;
    } else {
      const isBacktick = opener[0] === "`";
      if (isBacktick ? !hasMoreBackticks : !hasMoreTildes) {
        continue;
      }

      const afterOpener = startIndex + opener.length;
      let contentStart = afterOpener;
      infoRegex.lastIndex = afterOpener;
      const infoMatch = infoRegex.exec(text);
      if (infoMatch) {
        contentStart = afterOpener + infoMatch[0].length;
      }

      const closerRegex = isBacktick ? closeBackticksRegex : closeTildesRegex;
      closerRegex.lastIndex = contentStart;
      const closeMatch = closerRegex.exec(text);
      if (!closeMatch) {
        if (isBacktick) {
          hasMoreBackticks = false;
        } else {
          hasMoreTildes = false;
        }
        continue;
      }

      const closeIndex = closeMatch.index;
      const rawCode = text.slice(contentStart, closeIndex);
      matches.push({
        full: text.slice(startIndex, closeIndex + closeMatch[0].length),
        code: rawCode.trim(),
        index: startIndex,
      });
      openerRegex.lastIndex = closeIndex + closeMatch[0].length;
    }
  }

  return matches;
}

export function formatCodeForTts_fixc0gj_9f18cc1(
  text: string,
  codeHandling: "skip" | "explain" = "skip",
  summarizer: (code: string) => string = (c) => `summary(${c})`,
): string {
  const matches = extractCodeBlocks_fixc0gj_9f18cc1(text);
  if (matches.length === 0) {
    return text;
  }

  if (codeHandling === "explain") {
    let result = "";
    let lastIndex = 0;
    for (const m of matches) {
      result += text.slice(lastIndex, m.index);
      const explanation = summarizer(m.code);
      if (explanation) {
        result += `\nHere is what that code does: ${explanation}\n`;
      }
      lastIndex = m.index + m.full.length;
    }
    result += text.slice(lastIndex);
    return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
  }

  let result = "";
  let lastIndex = 0;
  for (const m of matches) {
    result += text.slice(lastIndex, m.index);
    lastIndex = m.index + m.full.length;
  }
  result += text.slice(lastIndex);
  return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
}

// ============================================================================
// 4. FIXC0GJ V2 REPAIRED TIP IMPLEMENTATION (fleet/fixc0gj: tip 3d32fc4)
// ============================================================================
export function extractCodeBlocks_fixc0gj_3d32fc4(text: string): CodeBlockMatch[] {
  if (!text.includes("```") && !text.includes("~~~") && !/<pre\b/i.test(text)) {
    return [];
  }

  const matches: CodeBlockMatch[] = [];
  const openerRegex = /(?:`{3,}|~{3,})|<pre\b[^>]*>/gi;
  const codeOpenRegex = /<code\b[^>]*>/iy;
  const infoRegex = /[^\n\r]*\r?\n/y;
  const closePreRegex = /<\/pre>/gi;
  const closeFenceRegex = /(?:`{3,}|~{3,})/g;

  let hasMorePre = true;
  let hasMoreFences = true;

  while (true) {
    if (!hasMorePre && !hasMoreFences) {
      break;
    }

    const match = openerRegex.exec(text);
    if (!match) break;

    const opener = match[0];
    const startIndex = match.index;

    if (opener.startsWith("<")) {
      if (!hasMorePre) {
        continue;
      }
      const afterPre = startIndex + opener.length;
      let contentStart = afterPre;
      codeOpenRegex.lastIndex = afterPre;
      const codeMatch = codeOpenRegex.exec(text);
      if (codeMatch) {
        contentStart = afterPre + codeMatch[0].length;
      }

      closePreRegex.lastIndex = contentStart;
      const closeMatch = closePreRegex.exec(text);
      if (!closeMatch) {
        hasMorePre = false;
        continue;
      }

      const closeIndex = closeMatch.index;
      let contentEnd = closeIndex;
      if (
        closeIndex >= contentStart + 7 &&
        text.slice(closeIndex - 7, closeIndex).toLowerCase() === "</code>"
      ) {
        contentEnd = closeIndex - 7;
      }

      const rawCode = decodeHtmlEntities(text.slice(contentStart, contentEnd));
      matches.push({
        full: text.slice(startIndex, closeIndex + closeMatch[0].length),
        code: rawCode.trim(),
        index: startIndex,
      });
      openerRegex.lastIndex = closeIndex + closeMatch[0].length;
    } else {
      if (!hasMoreFences) {
        continue;
      }

      const afterOpener = startIndex + opener.length;
      let contentStart = afterOpener;
      let closeMatch: RegExpExecArray | null = null;

      infoRegex.lastIndex = afterOpener;
      const infoMatch = infoRegex.exec(text);
      if (infoMatch) {
        const afterNl = afterOpener + infoMatch[0].length;
        closeFenceRegex.lastIndex = afterNl;
        closeMatch = closeFenceRegex.exec(text);
        if (closeMatch) {
          contentStart = afterNl;
        }
      }

      if (!closeMatch) {
        closeFenceRegex.lastIndex = afterOpener;
        closeMatch = closeFenceRegex.exec(text);
        if (closeMatch) {
          contentStart = afterOpener;
        }
      }

      if (!closeMatch) {
        if (opener.length >= 6) {
          matches.push({
            full: opener,
            code: "",
            index: startIndex,
          });
          hasMoreFences = false;
          continue;
        }
        hasMoreFences = false;
        continue;
      }

      const closeIndex = closeMatch.index;
      const rawCode = text.slice(contentStart, closeIndex);
      matches.push({
        full: text.slice(startIndex, closeIndex + closeMatch[0].length),
        code: rawCode.trim(),
        index: startIndex,
      });
      openerRegex.lastIndex = closeIndex + closeMatch[0].length;
    }
  }

  return matches;
}

export function formatCodeForTts_fixc0gj_3d32fc4(
  text: string,
  codeHandling: "skip" | "explain" = "skip",
  summarizer: (code: string) => string = (c) => `summary(${c})`,
): string {
  const matches = extractCodeBlocks_fixc0gj_3d32fc4(text);
  if (matches.length === 0) {
    return text;
  }

  if (codeHandling === "explain") {
    let result = "";
    let lastIndex = 0;
    for (const m of matches) {
      result += text.slice(lastIndex, m.index);
      const explanation = summarizer(m.code);
      if (explanation) {
        result += `\nHere is what that code does: ${explanation}\n`;
      }
      lastIndex = m.index + m.full.length;
    }
    result += text.slice(lastIndex);
    return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
  }

  let result = "";
  let lastIndex = 0;
  for (const m of matches) {
    result += text.slice(lastIndex, m.index);
    lastIndex = m.index + m.full.length;
  }
  result += text.slice(lastIndex);
  return result.split("\n").map((l) => l.trim()).filter(Boolean).join("\n\n");
}

// ============================================================================
// CORPUS GENERATION
// ============================================================================

export interface CorpusItem {
  id: string;
  category: string;
  text: string;
}

export function buildHandcraftedCorpus(): CorpusItem[] {
  const items: CorpusItem[] = [];
  const add = (category: string, name: string, text: string) => {
    items.push({ id: `${category}:${name}`, category, text });
  };

  // 1. Existing repo fixtures (tts_test.ts)
  add(
    "repo-fixture",
    "default-python",
    "Here is some context.\n\n```python\ndef compute(x):\n    return x * 2\n```\n\nThat was the computation.",
  );
  add(
    "repo-fixture",
    "rust-inline",
    'Look at this snippet:\n\n```rust\nfn main() { println!("hi"); }\n```\n\nDone.',
  );
  add(
    "repo-fixture",
    "variants-multiline",
    'Intro text.\n\n````js\nconst quad = 4;\n````\n\nMiddle text.\n\n~~~python\r\ndef tilde():\r\n    return True\r\n~~~\n\nBetween text.\n\n<pre class="hljs"><code class="language-javascript">const inPre = 1;</code></pre>\n\nAnother text.\n\n<pre>rawPreCode();</pre>\n\nOutro text.',
  );
  add(
    "repo-fixture",
    "html-entities",
    "<pre><code>x &amp;&amp; y &lt; 10 &gt; 2 &quot;quoted&quot; &#39;single&#39; &nbsp;end</code></pre>",
  );
  add(
    "repo-fixture",
    "nested-entities",
    "Demonstration: <pre><code>esc &amp;lt;b&amp;gt; here</code></pre>",
  );

  // 2. A fence inside a fence
  add("fence-inside-fence", "backtick-in-quad-backtick", "````\n```\ninner\n```\n````");
  add("fence-inside-fence", "tilde-in-quad-backtick", "````\n~~~\ninner\n~~~\n````");
  add("fence-inside-fence", "quad-backtick-in-quad-tilde", "~~~~\n````\n~~~~");
  add("fence-inside-fence", "triple-tilde-in-triple-backtick", "```\n~~~\n```");
  add("fence-inside-fence", "code-tag-in-fence", "```html\n<pre><code>val</code></pre>\n```");
  add("fence-inside-fence", "fences-in-pre", "<pre><code>```\ncode\n```</code></pre>");
  add("fence-inside-fence", "mixed-adjacent", "~~~~~~~<code>const x = 1;c++");
  add("fence-inside-fence", "mixed-interleaved", "~~~~<PRE></PRE>python</CODE>```Paragraph\n\n");
  add(
    "fence-inside-fence",
    "backtick-pre-tilde",
    "````</PRE>def foo(): pass```Paragraph in between.\n\n~~~~```",
  );

  // 3. SIX-backtick runs & variations
  add("six-backtick-runs", "solitary-six-backticks", "``````");
  add("six-backtick-runs", "six-backticks-with-abc", "``````abc");
  add("six-backtick-runs", "six-backticks-with-newline-tail", "``````\ntail");
  add("six-backtick-runs", "six-backticks-with-crlf-tail", "``````\r\ntail");
  add("six-backtick-runs", "six-backticks-enclosing-code", "``````\nconst x = 1;\n``````");
  add("six-backtick-runs", "seven-backticks", "```````");
  add("six-backtick-runs", "eight-backticks", "````````");
  add("six-backtick-runs", "solitary-six-tildes", "~~~~~~");
  add("six-backtick-runs", "seven-tildes", "~~~~~~~");
  add("six-backtick-runs", "eight-tildes", "~~~~~~~~");
  add("six-backtick-runs", "inline-six-backticks", "Text before `````` text after");
  add("six-backtick-runs", "six-backticks-then-triple", "``````\n```");
  add("six-backtick-runs", "triple-then-six-backticks", "```\n``````");

  // 4. CRLF line endings
  add("crlf", "crlf-fenced-js", "```js\r\nconst x = 1;\r\n```");
  add("crlf", "crlf-fenced-py", "~~~py\r\ndef f():\r\n  return 1\r\n~~~");
  add("crlf", "crlf-pre-block", "<pre>\r\ncode line 1\r\ncode line 2\r\n</pre>");
  add("crlf", "crlf-surrounding-text", "Prefix\r\n```\r\ncode\r\n```\r\nSuffix");
  add("crlf", "crlf-single-line-fence", "```code```\r\n");

  // 5. Unclosed fence at EOF
  add("unclosed-at-eof", "unclosed-triple-backtick-code", "Intro\n```\nconst x = 1;");
  add("unclosed-at-eof", "unclosed-triple-tilde-python", "Intro\n~~~python\ndef f():");
  add("unclosed-at-eof", "unclosed-triple-backtick-newline", "```\n");
  add("unclosed-at-eof", "unclosed-bare-triple-backtick", "```");
  add("unclosed-at-eof", "unclosed-bare-triple-tilde", "~~~");
  add("unclosed-at-eof", "unclosed-quad-backtick", "````");
  add("unclosed-at-eof", "unclosed-fence-middle-text", "Prefix\n```\nSuffix");
  add("unclosed-at-eof", "unclosed-pre-tag", "<pre>unclosed pre block at EOF");
  add("unclosed-at-eof", "unclosed-pre-and-code", "<pre><code>unclosed code inside pre at EOF");
  add("unclosed-at-eof", "unclosed-320kb-pre", "<p><pre>text</p>".repeat(200));

  // 6. Language tag with punctuation
  add("tag-punctuation", "cpp-tag", "```c++\nint x = 1;\n```");
  add("tag-punctuation", "csharp-tag", "```c#\nint x = 1;\n```");
  add("tag-punctuation", "dot-dash-colon-tag", "```foo.bar-baz_123:test\nspecial\n```");
  add("tag-punctuation", "url-styled-tag", "```lang-v1.2.3+build:extra?query=true\ncode\n```");
  add(
    "tag-punctuation",
    "punctuation-soup-tilde",
    "~~~semi;colon!mark@at#hash$dollar%percent^caret&star\ncode\n~~~",
  );
  add("tag-punctuation", "space-padded-tag", "```  js with spaces  \nconst a = 1;\n```");
  add("tag-punctuation", "tab-after-tag", "```ts\t// comment\ncode\n```");

  // 7. <pre> with attributes & casing
  add(
    "pre-attributes",
    "class-and-id",
    '<pre class="hljs" id="test"><code class="language-ts">const a = 1;</code></pre>',
  );
  add(
    "pre-attributes",
    "style-and-onclick",
    '<pre style="color: red;" onclick="alert(1)">raw code</pre>',
  );
  add("pre-attributes", "boolean-attributes", '<pre data-type="sample" hidden>hidden code</pre>');
  add("pre-attributes", "uppercase-tags", "<PRE><CODE>UPPERCASE</CODE></PRE>");
  add("pre-attributes", "mixed-case-tags", "<Pre><Code>MixedCase</Code></Pre>");
  add("pre-attributes", "nested-pre-openers", "<pre>a<pre>b</pre>c");
  add("pre-attributes", "malformed-code-tag-swallowing-pre", "<pre><code no-gt here</pre>");
  add("pre-attributes", "multiline-pre-tag-open", '<pre\n  class="foo"\n  id="bar"\n>code\n</pre>');
  add("pre-attributes", "attr-containing-gt", '<pre data-info=">">code</pre>');

  // 8. Line of exactly the delimiter length
  add("exact-delimiter-length", "line-triple-backtick", "```");
  add("exact-delimiter-length", "line-triple-tilde", "~~~");
  add("exact-delimiter-length", "line-quad-backtick", "````");
  add("exact-delimiter-length", "line-quad-tilde", "~~~~");
  add("exact-delimiter-length", "exact-in-middle", "Hello\n```\nWorld");
  add("exact-delimiter-length", "triple-newlines-only", "```\n\n```");

  // 9. Thousands of tiny blocks vs one huge block
  const tinyBlocks = Array.from(
    { length: 1000 },
    (_, i) => `p${i}\n\`\`\`\nx${i}\n\`\`\``,
  ).join("\n\n");
  add("scale-shapes", "thousand-tiny-blocks", tinyBlocks);
  const hugeBlock = "Intro\n```js\n" + "const x = 1;\n".repeat(2000) + "```\nOutro";
  add("scale-shapes", "huge-28kb-block", hugeBlock);

  // 10. Empty code blocks
  add("empty-block", "empty-backticks-nl", "```\n```");
  add("empty-block", "empty-backticks-crlf", "```\r\n```");
  add("empty-block", "empty-tildes-nl", "~~~\n~~~");
  add("empty-block", "empty-pre", "<pre></pre>");
  add("empty-block", "empty-pre-code", "<pre><code></code></pre>");
  add("empty-block", "whitespace-only-pre", "<pre>   \n\t  </pre>");
  add("empty-block", "whitespace-only-fenced", "```\n   \n```");

  // 11. Fence at position 0
  add("fence-at-boundary", "fence-at-pos-0", "```js\nconst x = 1;\n```\nParagraph after.");
  add("fence-at-boundary", "pre-at-pos-0", "<pre>const x = 1;</pre>\nParagraph after.");
  add("fence-at-boundary", "tilde-at-pos-0", "~~~py\nreturn 1\n~~~\nParagraph after.");

  // 12. Fence at EOF
  add("fence-at-boundary", "fence-at-eof", "Paragraph before.\n```js\nconst x = 1;\n```");
  add("fence-at-boundary", "pre-at-eof", "Paragraph before.\n<pre>const x = 1;</pre>");
  add("fence-at-boundary", "single-line-fence-at-eof", "Paragraph before.\n```code```");

  // 13. No-code input
  add("no-code", "empty-string", "");
  add("no-code", "plain-paragraphs", "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
  add("no-code", "single-inline-code", "Inline `single` backtick code.");
  add("no-code", "double-inline-code", "Double ``inline`` backticks.");
  add("no-code", "html-tags-non-pre", "HTML tags like <p>paragraph</p> and <br> and <b>bold</b>.");
  add(
    "no-code",
    "fake-pre-prefixes",
    "Fake pre tags like <previous> or <prelude> or <preparation>.",
  );
  add(
    "no-code",
    "japanese-cjk",
    "Japanese text: こんにちは、これはテストです。コードではありません。",
  );
  add("no-code", "emoji-text", "Emoji text: 🎙️ 🎧 🔊 🚀 ⭐");
  add("no-code", "math-comparisons", "Math with < and >: 5 < 10 and 10 > 5 and a < b < c.");
  add("no-code", "unmatched-backticks", "Use `to run `something `else without fences.");
  add("no-code", "quotes-and-apostrophes", "He said: 'It\\'s \"quoted\" here'.");

  return items;
}

// PRNG for deterministic, reproducible fuzz corpus
export function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildFuzzCorpus(count: number, seed = 12345): CorpusItem[] {
  const rng = mulberry32(seed);
  const items: CorpusItem[] = [];

  const tokens = [
    "```",
    "~~~",
    "````",
    "~~~~",
    "`````",
    "~~~~~",
    "``````",
    "~~~~~~",
    "```````",
    "~~~~~~~",
    "\n",
    "\r\n",
    " ",
    "   ",
    "<pre>",
    "<PRE>",
    "<Pre>",
    '<pre class="ts">',
    '<pre id="x">',
    "<code>",
    "<CODE>",
    "</pre>",
    "</PRE>",
    "</code>",
    "</CODE>",
    "const x = 1;",
    "return true;",
    "abc",
    "def\nghi",
    "&lt;div&gt;",
    "&amp;&quot;",
    "prefix ",
    " suffix",
    "js\n",
    "python\r\n",
    "`code`",
    "``two``",
  ];

  for (let i = 0; i < count; i++) {
    const tokenCount = 1 + Math.floor(rng() * 12);
    let str = "";
    for (let j = 0; j < tokenCount; j++) {
      const idx = Math.floor(rng() * tokens.length);
      str += tokens[idx];
    }
    items.push({
      id: `fuzz:s${seed}:${i}`,
      category: "fuzz-combinatorial",
      text: str,
    });
  }

  return items;
}

// ============================================================================
// VERIFICATION RUNNER & HARNESS
// ============================================================================

export interface DivergenceDiff {
  id: string;
  category: string;
  input: string;
  expected: string;
  actual: string;
  explanationExpected?: string;
  explanationActual?: string;
  blocksExpected: CodeBlockMatch[];
  blocksActual: CodeBlockMatch[];
}

export interface CandidateResult {
  name: string;
  ref: string;
  totalComparisons: number;
  skipDivergences: number;
  explainDivergences: number;
  blockDivergences: number;
  totalDistinctDifferingInputs: number;
  firstDiffs: DivergenceDiff[];
}

export function evaluateCandidate(
  name: string,
  ref: string,
  corpus: CorpusItem[],
  candidateFormat: (text: string, mode: "skip" | "explain") => string,
  candidateExtract: (text: string) => CodeBlockMatch[],
  maxDiffsToStore = 10,
): CandidateResult {
  let skipDivergences = 0;
  let explainDivergences = 0;
  let blockDivergences = 0;
  const differingInputIds = new Set<string>();
  const firstDiffs: DivergenceDiff[] = [];

  for (const item of corpus) {
    const text = item.text;

    // Baseline results
    const expectedSkip = formatCodeForTts_main(text, "skip");
    const expectedExplain = formatCodeForTts_main(text, "explain");
    const expectedBlocks = extractCodeBlocks_main(text);

    // Candidate results
    const actualSkip = candidateFormat(text, "skip");
    const actualExplain = candidateFormat(text, "explain");
    const actualBlocks = candidateExtract(text);

    const skipMatches = actualSkip === expectedSkip;
    const explainMatches = actualExplain === expectedExplain;
    const blocksMatch = actualBlocks.length === expectedBlocks.length &&
      actualBlocks.every(
        (b, i) => {
          const exp = expectedBlocks[i];
          return (
            exp !== undefined &&
            b.index === exp.index &&
            b.full === exp.full &&
            b.code === exp.code
          );
        },
      );

    let hasDiff = false;
    if (!skipMatches) {
      skipDivergences++;
      hasDiff = true;
    }
    if (!explainMatches) {
      explainDivergences++;
      hasDiff = true;
    }
    if (!blocksMatch) {
      blockDivergences++;
      hasDiff = true;
    }

    if (hasDiff) {
      differingInputIds.add(item.id);
      if (firstDiffs.length < maxDiffsToStore) {
        firstDiffs.push({
          id: item.id,
          category: item.category,
          input: text,
          expected: expectedSkip,
          actual: actualSkip,
          explanationExpected: expectedExplain,
          explanationActual: actualExplain,
          blocksExpected: expectedBlocks,
          blocksActual: actualBlocks,
        });
      }
    }
  }

  return {
    name,
    ref,
    totalComparisons: corpus.length,
    skipDivergences,
    explainDivergences,
    blockDivergences,
    totalDistinctDifferingInputs: differingInputIds.size,
    firstDiffs,
  };
}

// ============================================================================
// CLI AND REPORTING
// ============================================================================

export async function verifyAgainstGitRefs(): Promise<boolean> {
  console.log("Verifying inlined implementations against target git revisions...");
  const refs = [
    {
      name: "origin/main",
      ref: "origin/main:src/tts/gemini.ts",
      verify: (src: string) => {
        const needle =
          "/(?:```+|~~~+)(?:[^\\n\\r]*\\r?\\n)?([\\s\\S]*?)(?:```+|~~~+)|<pre\\b[^>]*>(?:<code\\b[^>]*>)?([\\s\\S]*?)(?:<\\/code>)?<\\/pre>/gi";
        if (!src.includes(needle)) {
          throw new Error(
            "origin/main:src/tts/gemini.ts does not contain reference codeBlockRegex",
          );
        }
      },
    },
    {
      name: "fleet/audit1 (tip f70e3fa)",
      ref: "origin/fleet/audit1:src/tts/gemini.ts",
      verify: (src: string) => {
        if (!src.includes("function findCodeBlocks(text: string): CodeBlock[]")) {
          throw new Error("origin/fleet/audit1:src/tts/gemini.ts missing findCodeBlocks");
        }
        if (
          !src.includes("function matchFence(text: string, run: { index: number; end: number })")
        ) {
          throw new Error("origin/fleet/audit1:src/tts/gemini.ts missing matchFence");
        }
        if (!src.includes("const shortest = Math.max(3, length - 3);")) {
          throw new Error(
            "origin/fleet/audit1:src/tts/gemini.ts missing 3-char opener shrink bound",
          );
        }
      },
    },
    {
      name: "fleet/fixc0gj v1 (9f18cc1)",
      ref: "9f18cc1:src/tts/gemini.ts",
      verify: (src: string) => {
        if (!src.includes("function extractCodeBlocks(text: string): CodeBlockMatch[]")) {
          throw new Error("9f18cc1:src/tts/gemini.ts missing extractCodeBlocks");
        }
        if (!src.includes("const closeBackticksRegex = /`{3,}/g;")) {
          throw new Error("9f18cc1:src/tts/gemini.ts missing separate closeBackticksRegex");
        }
        if (!src.includes("hasMoreBackticks = false;")) {
          throw new Error("9f18cc1:src/tts/gemini.ts missing hasMoreBackticks flag reset");
        }
      },
    },
    {
      name: "fleet/fixc0gj v2 (tip 3d32fc4)",
      ref: "origin/fleet/fixc0gj:src/tts/gemini.ts",
      verify: (src: string) => {
        if (!src.includes("function extractCodeBlocks(text: string): CodeBlockMatch[]")) {
          throw new Error("origin/fleet/fixc0gj:src/tts/gemini.ts missing extractCodeBlocks");
        }
        if (!src.includes("const closeFenceRegex = /(?:`{3,}|~{3,})/g;")) {
          throw new Error("origin/fleet/fixc0gj:src/tts/gemini.ts missing closeFenceRegex");
        }
        if (!src.includes("if (opener.length >= 6)")) {
          throw new Error(
            "origin/fleet/fixc0gj:src/tts/gemini.ts missing self-closing >= 6 fence check",
          );
        }
      },
    },
  ];

  for (const r of refs) {
    const proc = new Deno.Command("git", { args: ["show", r.ref] });
    const res = await proc.output();
    if (!res.success) {
      throw new Error(`Could not read ${r.ref} from git: command failed with exit ${res.code}`);
    }
    const content = new TextDecoder().decode(res.stdout);
    r.verify(content);
    console.log(
      `  [OK] Verified ${r.name} (${r.ref}, ${res.stdout.length} bytes) matches implementation.`,
    );
  }
  return true;
}

export function printCandidateReport(res: CandidateResult) {
  console.log(`\n====================================================================`);
  console.log(`CANDIDATE: ${res.name} (ref: ${res.ref})`);
  console.log(`Total corpus inputs tested: ${res.totalComparisons}`);
  console.log(
    `Differing inputs (distinct): ${res.totalDistinctDifferingInputs} / ${res.totalComparisons}`,
  );
  console.log(`  - Skip mode mismatches:    ${res.skipDivergences}`);
  console.log(`  - Explain mode mismatches: ${res.explainDivergences}`);
  console.log(`  - Block AST mismatches:    ${res.blockDivergences}`);

  if (res.firstDiffs.length > 0) {
    console.log(`\nFirst ${res.firstDiffs.length} differing inputs:`);
    res.firstDiffs.forEach((d, idx) => {
      console.log(`\n--- [Diff #${idx + 1}] ID: ${d.id} (${d.category}) ---`);
      console.log(`INPUT:\n${JSON.stringify(d.input)}`);
      console.log(`EXPECTED (origin/main regex):\n${JSON.stringify(d.expected)}`);
      console.log(`ACTUAL (${res.name}):\n${JSON.stringify(d.actual)}`);
      if (d.explanationExpected !== d.explanationActual) {
        console.log(
          `EXPECTED EXPLAIN:\n${JSON.stringify(d.explanationExpected)}`,
        );
        console.log(
          `ACTUAL EXPLAIN:\n${JSON.stringify(d.explanationActual)}`,
        );
      }
      console.log(`EXPECTED BLOCKS:`, JSON.stringify(d.blocksExpected));
      console.log(`ACTUAL BLOCKS:  `, JSON.stringify(d.blocksActual));
    });
  } else {
    console.log(`\n>>> 0 MISMATCHES: 100% BYTE-IDENTICAL TO origin/main REGEX GRAMMAR <<<`);
  }
}

export async function runVerification(fuzzCount = 10000) {
  console.log("====================================================================");
  console.log("c0gj SCANNER DIVERGENCE VERIFICATION HARNESS (audio-feed-diqd)");
  console.log("====================================================================");

  await verifyAgainstGitRefs();

  const handcrafted = buildHandcraftedCorpus();
  console.log(`\nBuilt handcrafted corpus: ${handcrafted.length} cases.`);

  // Build fuzz corpus across 3 deterministic seeds
  const fuzz1 = buildFuzzCorpus(Math.floor(fuzzCount / 3), 101);
  const fuzz2 = buildFuzzCorpus(Math.floor(fuzzCount / 3), 202);
  const fuzz3 = buildFuzzCorpus(Math.floor(fuzzCount / 3), 303);
  const fullCorpus = [...handcrafted, ...fuzz1, ...fuzz2, ...fuzz3];
  console.log(`Total corpus size (handcrafted + 3-seed fuzz): ${fullCorpus.length} cases.`);

  // Evaluate audit1 (tip f70e3fa)
  const audit1Result = evaluateCandidate(
    "audit1",
    "fleet/audit1 @ f70e3fa",
    fullCorpus,
    formatCodeForTts_audit1,
    extractCodeBlocks_audit1,
  );
  printCandidateReport(audit1Result);

  // Evaluate fixc0gj v1 (9f18cc1)
  const fixc0gjV1Result = evaluateCandidate(
    "fixc0gj v1",
    "fleet/fixc0gj @ 9f18cc1",
    fullCorpus,
    formatCodeForTts_fixc0gj_9f18cc1,
    extractCodeBlocks_fixc0gj_9f18cc1,
  );
  printCandidateReport(fixc0gjV1Result);

  // Evaluate fixc0gj v2 (tip 3d32fc4)
  const fixc0gjV2Result = evaluateCandidate(
    "fixc0gj v2",
    "fleet/fixc0gj @ 3d32fc4",
    fullCorpus,
    formatCodeForTts_fixc0gj_3d32fc4,
    extractCodeBlocks_fixc0gj_3d32fc4,
  );
  printCandidateReport(fixc0gjV2Result);

  // Audit1 reported reproducing 1927/6092 on fixc0gj v1:
  // Let's test a specific 6,092 case corpus to check audit1's exact claim!
  console.log(`\n====================================================================`);
  console.log(`SPECIAL INVESTIGATION: REPRODUCING AUDIT1'S 1,927 / 6,092 CLAIM`);
  console.log(`====================================================================`);
  // Audit1 claimed: 46 shapes + 3,000 fuzz * 2 (skip + explain) = 6,092 comparisons.
  const audit1CorpusFuzz = buildFuzzCorpus(3000, 42);
  const audit1ReproduceCorpus = [...handcrafted.slice(0, 46), ...audit1CorpusFuzz];
  const reproV1 = evaluateCandidate(
    "fixc0gj v1 on 3046 inputs",
    "9f18cc1",
    audit1ReproduceCorpus,
    formatCodeForTts_fixc0gj_9f18cc1,
    extractCodeBlocks_fixc0gj_9f18cc1,
  );
  const totalComparisonsSkipAndExplain = reproV1.totalComparisons * 2;
  const totalMismatchesSkipAndExplain = reproV1.skipDivergences + reproV1.explainDivergences;
  console.log(
    `Corpus size: ${reproV1.totalComparisons} inputs (x2 modes = ${totalComparisonsSkipAndExplain} comparisons)`,
  );
  console.log(
    `fixc0gj v1 mismatches across skip + explain: ${totalMismatchesSkipAndExplain} / ${totalComparisonsSkipAndExplain} (${
      (totalMismatchesSkipAndExplain / totalComparisonsSkipAndExplain * 100).toFixed(1)
    }%)`,
  );
  console.log(
    `Distinct differing inputs: ${reproV1.totalDistinctDifferingInputs} / ${reproV1.totalComparisons} (${
      (reproV1.totalDistinctDifferingInputs / reproV1.totalComparisons * 100).toFixed(1)
    }%)`,
  );

  return {
    audit1Result,
    fixc0gjV1Result,
    fixc0gjV2Result,
    reproV1,
  };
}

if (import.meta.main) {
  let count = 10000;
  const idx = Deno.args.indexOf("--fuzz-count");
  if (idx >= 0 && Deno.args[idx + 1] !== undefined) {
    count = parseInt(Deno.args[idx + 1]!, 10);
  }
  await runVerification(count);
}
