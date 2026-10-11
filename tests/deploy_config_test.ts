/**
 * The Deno Deploy entrypoint pin, checked where a typo can still be fixed cheaply (audio-feed-w55i).
 *
 * WHY THIS EXISTS. The live project failed a build with
 *
 *   Entrypoint at '/tmp/build/src/src/server.ts' not found
 *
 * because the entrypoint existed only in the Deno Deploy dashboard, where it drifted out of sight
 * of the repo. `deno.json` now carries the runtime configuration (`deploy.runtime`), and Deno Deploy
 * reads it from source — the docs are explicit that source configuration takes precedence over the
 * dashboard, and that after a build succeeds from source config those fields stop being editable in
 * the dashboard.
 *
 * The failure mode this test kills is the one that just cost a build: an entrypoint PATH that names
 * nothing. Deploy's builder reports it as a failed build, minutes later, on a platform we cannot
 * inspect from here. A stat() in the repo's own gate reports it in milliseconds, in the change that
 * introduced it.
 *
 * WHAT IT DOES NOT CLAIM. It cannot prove Deno Deploy honours the block for THIS project: the
 * dashboard's "app directory" (which determines the source root the entrypoint is resolved
 * against) is not settable from source and is not visible from here. If that directory is
 * configured as `src/` rather than the repository root, the entrypoint resolves inside `src/` and
 * this block — read from the ROOT deno.json, which is also looked up relative to that directory —
 * would not be applied at all. So the test pins the repo-side truth: the block exists, the type is
 * dynamic, and the file it names really is there. The build is the only proof of the rest.
 */

import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("../", import.meta.url);

/**
 * `deno.json` is JSONC — this file's sibling config carries comments explaining why each block
 * exists — and the project deliberately takes no dependency just to read its own config.
 *
 * A string-aware scan, not a regex: a `//` inside a string value (a URL in a task command, say)
 * must survive, and a comment must not be able to swallow the next line's `"key":`. The escaper
 * state is what makes `"\\""` terminate the string rather than open a quoted region.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

async function deployConfig(): Promise<Record<string, unknown>> {
  const raw = await Deno.readTextFile(new URL("deno.json", ROOT));
  const parsed = JSON.parse(stripJsonComments(raw)) as {
    deploy?: { runtime?: { type?: unknown; entrypoint?: unknown } };
  };
  return (parsed.deploy?.runtime ?? {}) as Record<string, unknown>;
}

Deno.test("audio-feed-w55i: deno.json pins a dynamic Deno Deploy runtime", async () => {
  const runtime = await deployConfig();
  // Removing the block is a regression, not a tidy-up: it is the only repo-side record of the
  // entrypoint, and its absence is what let the dashboard's value drift into "src/src/server.ts".
  assertEquals(runtime.type, "dynamic", "the deploy runtime must be dynamic, not a static site");
  assert(
    typeof runtime.entrypoint === "string" && runtime.entrypoint.trim().length > 0,
    `deploy.runtime.entrypoint must name a file; got ${JSON.stringify(runtime.entrypoint)}`,
  );
});

Deno.test("audio-feed-w55i: the pinned entrypoint file exists in the repo", async () => {
  const runtime = await deployConfig();
  const entrypoint = String(runtime.entrypoint);
  // A path escaping the repo, or an absolute one, is a build failure waiting to happen. Reject it
  // here as configuration rather than resolving it and testing whatever path it happens to name.
  assert(!entrypoint.startsWith("/"), `entrypoint must be repo-relative; got ${entrypoint}`);
  assert(!entrypoint.split(/[\\/]/).includes(".."), `entrypoint must not escape the repo`);

  const file = new URL(entrypoint, ROOT);
  const stat = await Deno.stat(file).catch(() => null);
  assert(
    stat?.isFile,
    `deploy.runtime.entrypoint names ${entrypoint}, which does not exist — Deno Deploy would fail ` +
      `the build with "Entrypoint at /tmp/build/... not found" (the failure this pin exists to stop)`,
  );
  // Non-empty, so an empty placeholder file is not mistaken for a working entrypoint.
  const body = await Deno.readTextFile(file);
  assert(body.trim().length > 0, `${entrypoint} is empty`);
});

Deno.test("audio-feed-w55i: the pinned entrypoint is the server module, not a second app", async () => {
  // main.ts is a deno-serve style entrypoint: it re-exports src/server.ts's default fetch handler.
  // If a future edit changes the entrypoint to some other file that does NOT export the server, the
  // build can succeed and the deployment still cannot serve a request. Assert the relationship
  // rather than the exact text, so either `export ... from` form keeps working.
  const runtime = await deployConfig();
  const body = await Deno.readTextFile(new URL(String(runtime.entrypoint), ROOT));
  assert(
    /export\s*\{[^}]*default[^}]*\}\s*from\s*["']\.\/src\/server\.ts["']/.test(body) ||
      /import\s*["']\.\/src\/server\.ts["']/.test(body),
    "the entrypoint must import or re-export ./src/server.ts",
  );
});
