/**
 * audio-feed-lyt1 — NOTHING RAN THE PROOFS.
 *
 * The repo's founding evidence rule is "no evidence without a check that can fail, and no README
 * claiming more than the check covers". Every evidence README already names the script that produces
 * it, in a `- Script: <path>` line, and the debt list tracks which directories declare nothing. What
 * was missing was that NOTHING EVER EXECUTED THE THING DECLARED: a proof could be unable to pass for
 * days while its README and screenshots sat committed, and an app change could invalidate several
 * proofs without any gate going red. Three examples in one night (audio-feed-8fc, 0cmu, and the
 * migration that ran them by accident) — each found only because something happened to run the proof.
 *
 * This adds a NEW, EXPLICITLY-INVOKED TIER rather than widening an existing one:
 *
 *     deno task evidence                 run every declared proof, sequentially
 *     deno task evidence --list          the inventory only: no browsers, no servers
 *     deno task evidence --only <dir>    one evidence directory (its directory NAME)
 *     deno task evidence --timeout <s>   per-proof bound (default 300)
 *     deno task evidence --root <dir>    resolve declarations under another root (used to prove the
 *                                        tier can go red, against a scratch evidence tree)
 *
 * EXIT CODES, because a silent non-zero is as useless as a silent skip:
 *     0  every declared proof passed, and every evidence directory declares something;
 *     1  at least one declared proof FAILED, or a declared script is not a file (UNRESOLVED);
 *     2  every declared proof passed, but the tree carries DECLARATION DEBT - a directory that
 *        declares nothing or has no README. Debt is not a proof failure and is not a pass either:
 *        a skip that is not printed is a test that stopped testing, so it is named and it is non-zero.
 *
 * WHY A NEW TIER AND NOT A MAPPING INTO fast-check: a mapping buys speed with a new suppression
 * surface — a mapping that names the wrong suite suppresses a slice's gate while looking green
 * (audio-feed-nxnf states exactly this risk) — and a browser proof cannot run inside the fast gate
 * anyway without breaking its budget, which requires that a docs-only change still select no suites.
 * scripts/fast-check.ts and scripts/test-selection.ts are not touched by this change.
 *
 * WHERE TO RUN IT, which is not obvious and has already bitten this repo once: the proofs REWRITE
 * their own committed artefacts under docs/evidence, so the tier is a WRITER and must not share a
 * worktree with anything else that writes - a gate run in the same tree while a proof rewrites its
 * PNGs fails for reasons that have nothing to do with the diff. Run it in its own worktree (or one no
 * gate is using) and restore the artefacts afterwards. It is also bounded twice over, per proof and in
 * total, which is what lets it run in the fleet's single heavy slot: `--timeout <s>` bounds each proof
 * and the invocation itself is wrapped in a total bound.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, so nobody reads more into a green run than it says:
 * - it does not check that a proof asserts what its README CLAIMS (that is the declaration and
 *   evidence-size work);
 * - it does not run directories that declare nothing. It COUNTS them, because "there is no proof
 *   here" is a different fact from "the proof here passes", and printing the count keeps the debt
 *   visible instead of letting it read as coverage;
 * - a declared script that is not a file is an UNRESOLVED FAILURE, never a skip: a tier that skips
 *   quietly is satisfied by construction, which is the defect class this fleet has been closing all
 *   evening.
 */
import { fromFileUrl, join, resolve } from "@std/path";

interface Declaration {
  /** `docs/evidence/<dir>` relative to the root. */
  dir: string;
  /** The path as written in the README. */
  declared: string;
  /** Whether that path is a file under the root. */
  exists: boolean;
}

interface Options {
  list: boolean;
  only?: string;
  timeoutMs: number;
  root: string;
}

const USAGE =
  `usage: deno task evidence [--list] [--only <evidence-dir>] [--timeout <seconds>] [--root <dir>]`;

function parseOptions(args: string[]): Options {
  const root = resolve(fromFileUrl(new URL("../", import.meta.url)));
  const options: Options = { list: false, timeoutMs: 300_000, root };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === "--list") options.list = true;
    else if (arg === "--only" && value) {
      options.only = value;
      i++;
    } else if (arg === "--timeout" && value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
          `--timeout needs a positive number of seconds, got ${JSON.stringify(value)}`,
        );
      }
      options.timeoutMs = Math.round(seconds * 1000);
      i++;
    } else if (arg === "--root" && value) {
      options.root = resolve(value);
      i++;
    } else {
      throw new Error(`unrecognised argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  return options;
}

/**
 * The declaration the READMEs already carry, rather than a new one: a `- Script:` line naming the
 * proof that produces the directory's evidence. Backticks and quotes are stripped because the line
 * is prose as often as it is a path.
 */
function readDeclaration(readme: string): string | null {
  for (const line of readme.split("\n")) {
    const match = /^\s*-\s*Script:\s*(.+?)\s*$/.exec(line);
    if (match) return match[1]!.replace(/[`"']/g, "").trim();
  }
  return null;
}

async function collect(options: Options): Promise<{
  declarations: Declaration[];
  undeclared: string[];
  withoutReadme: string[];
}> {
  const evidenceRoot = join(options.root, "docs", "evidence");
  const declarations: Declaration[] = [];
  const undeclared: string[] = [];
  const withoutReadme: string[] = [];
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(evidenceRoot)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (err) {
    // A missing tree is an unreadable run, not an empty one: reporting "nothing to run" as a pass is
    // the same defect class as a check satisfied by construction. State it, and stay red.
    console.error(
      `[evidence] no readable docs/evidence under ${options.root} (${(err as Error).name}): ` +
        `nothing was verified`,
    );
    Deno.exit(1);
  }
  // Stable order so two runs of the inventory are comparable line by line.
  names.sort();
  for (const name of names) {
    if (options.only && options.only !== name) continue;
    const dir = `docs/evidence/${name}`;
    let readme: string;
    try {
      readme = await Deno.readTextFile(join(options.root, dir, "README.md"));
    } catch {
      withoutReadme.push(dir);
      continue;
    }
    const declared = readDeclaration(readme);
    if (!declared) {
      undeclared.push(dir);
      continue;
    }
    let exists = false;
    try {
      exists = (await Deno.stat(join(options.root, declared))).isFile;
    } catch {
      exists = false;
    }
    declarations.push({ dir, declared, exists });
  }
  return { declarations, undeclared, withoutReadme };
}

interface RunResult {
  code: number;
  seconds: number;
  timedOut: boolean;
  tail: string;
}

/**
 * One proof, SEQUENTIALLY and under a hard bound.
 *
 * Never in parallel: these proofs drive a browser, and the fleet runs one headless browser at a time.
 *
 * The bound is GNU `timeout`, not a JavaScript timer, because `timeout` without `--foreground` puts
 * the command in its own process group and signals the GROUP: that reaches the dev server and the
 * browser the proof started, which a single-process kill leaves behind. (Measured while building
 * this: Deno.kill(-pid) on a group is NotCapable under a least-privilege runner, setsid's fork
 * behaviour depends on whether the child is already a group leader, and a failed group kill that is
 * swallowed by a `catch {}` turns the bound into no bound at all - the first version of this file
 * did exactly that and wedged, which row 3b caught. `timeout` is the mechanism the fleet already
 * prescribes, and it has the exit code convention this tier reports: 124 means the bound was hit.)
 *
 * The JavaScript backstop at bound + 15s is for the one case `timeout` cannot cover: a proof that
 * escapes its process group and keeps the output pipes open, which would otherwise leave the tier
 * blocked in `output()` forever. It kills the direct child, which is always permitted to this
 * process.
 */
async function runProof(
  options: Options,
  declaration: Declaration,
  onChild: (pid: number | null) => void,
): Promise<RunResult> {
  const started = performance.now();
  const seconds = Math.max(1, Math.round(options.timeoutMs / 1000));
  const command = new Deno.Command("timeout", {
    args: [
      "-k",
      "5",
      `${seconds}`,
      Deno.execPath(),
      "run",
      "--allow-all",
      "--unstable-kv",
      declaration.declared,
    ],
    cwd: options.root,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  onChild(child.pid);
  const backstop = setTimeout(() => {
    console.log(
      `[evidence] ${declaration.dir} exceeded its bound by 15s and ignored it: killing pid ${child.pid}`,
    );
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, options.timeoutMs + 15_000);
  // `output()` drains both pipes while it waits; not draining them is how a chatty proof deadlocks.
  const output = await child.output();
  clearTimeout(backstop);
  onChild(null);
  const text = `${new TextDecoder().decode(output.stdout)}\n${
    new TextDecoder().decode(output.stderr)
  }`;
  const tail = text.split("\n").filter((line) => line.trim() !== "").slice(-6).join("\n  ");
  return {
    code: output.code,
    seconds: (performance.now() - started) / 1000,
    // GNU timeout reports 124 when the bound was hit, and 137 when the KILL grace expired.
    timedOut: output.code === 124 || output.code === 137,
    tail,
  };
}

const options = parseOptions(Deno.args);
const { declarations, undeclared, withoutReadme } = await collect(options);
const unresolved = declarations.filter((declaration) => !declaration.exists);

/**
 * A DECLARATION OUTCOME IS PRINTED, NEVER IMPLIED. Three facts are debt rather than failure - a
 * directory that declares nothing, a directory with no README, and one script declared by two
 * directories - and every one of them is a skip in disguise if it is silent: a skip that is not
 * printed is a test that stopped testing. They are named here, counted in the summary, and they make
 * the tier exit 2 (no proof failed, but the evidence tree is not fully declared).
 *
 * Measured before deciding how to treat the duplicate: scripts/bookmarklet-browser-proof.ts is
 * declared by audio-feed-6hw and audio-feed-ep1, and that is legitimate - one proof produces two
 * evidence sets with different artefacts and different assertion lists. So a duplicate is reported
 * rather than failed, because failing it would be a red that is not a defect.
 */
const byScript = new Map<string, string[]>();
for (const declaration of declarations) {
  const dirs = byScript.get(declaration.declared) ?? [];
  dirs.push(declaration.dir);
  byScript.set(declaration.declared, dirs);
}
const duplicates = [...byScript.entries()].filter(([, dirs]) => dirs.length > 1).sort((a, b) =>
  a[0] < b[0] ? -1 : 1
);

function printDebt(): number {
  for (const dir of undeclared) {
    console.log(`[evidence] debt: ${dir} declares no proof (no '- Script:' line in its README)`);
  }
  for (const dir of withoutReadme) {
    console.log(`[evidence] debt: ${dir} has no README, so nothing is declared or asserted there`);
  }
  for (const [script, dirs] of duplicates) {
    console.log(
      `[evidence] note: ${script} is declared by ${dirs.length} directories (${
        dirs.join(", ")
      }) - ` +
        `one proof producing more than one evidence set; it will be run once per declaring directory`,
    );
  }
  return undeclared.length + withoutReadme.length;
}

if (options.list) {
  for (const declaration of declarations) {
    console.log(
      `${
        declaration.exists ? "declared  " : "UNRESOLVED"
      } ${declaration.dir} -> ${declaration.declared}`,
    );
  }
  console.log(
    `[evidence] inventory: ${declarations.length} declared proof(s), ${unresolved.length} unresolved, ` +
      `${undeclared.length} directory(ies) declare nothing, ${withoutReadme.length} have no README` +
      (options.only ? ` (filtered to --only ${options.only})` : ""),
  );
  printDebt();
  console.log("[evidence] --list is an inventory, not a verdict: it exits 0 and runs nothing");
  Deno.exit(0);
}

console.log(
  `[evidence] running ${declarations.length} declared proof(s) sequentially, ${
    options.timeoutMs / 1000
  }s ` +
    `bound each, from ${options.root}`,
);
// A run that exercised nothing is RED. Measured before a reviewer saw it: `--only` with a name that
// matched nothing printed "every declared proof passed on this tree" and exited 0, so a typo in a
// filter read as a clean bill of health.
if (declarations.length === 0) {
  console.error(
    options.only
      ? `[evidence] --only ${options.only} matched no evidence directory that declares a proof ` +
        `(${undeclared.length} declare nothing, ${withoutReadme.length} have no README): ` +
        `nothing was verified`
      : `[evidence] no evidence directory declares a proof under ${options.root}: nothing was verified`,
  );
  Deno.exit(1);
}
const debt = printDebt();
const results: Array<{ declaration: Declaration; result?: RunResult }> = [];
let running: number | null = null;
try {
  for (const declaration of declarations) {
    if (!declaration.exists) {
      console.log(
        `[evidence] FAIL ${declaration.dir} -> ${declaration.declared} (UNRESOLVED: not a file)`,
      );
      results.push({ declaration });
      continue;
    }
    const result = await runProof(options, declaration, (pid) => running = pid);
    results.push({ declaration, result });
    const verdict = result.code === 0 ? "ok  " : "FAIL";
    const note = result.timedOut ? ` TIMED OUT after ${options.timeoutMs / 1000}s` : "";
    console.log(
      `[evidence] ${verdict} ${declaration.dir} -> ${declaration.declared} ` +
        `(exit ${result.code}, ${result.seconds.toFixed(1)}s)${note}`,
    );
    if (result.code !== 0 && result.tail) console.log(`  ${result.tail}`);
  }
} finally {
  // Never leave a proof's server or browser running after the tier returns.
  if (running) {
    try {
      Deno.kill(-running, "SIGKILL");
    } catch { /* already gone */ }
  }
}

const passed = results.filter((entry) => entry.result?.code === 0).length;
const failed = results.length - passed;
const seconds = results.reduce((total, entry) => total + (entry.result?.seconds ?? 0), 0);
console.log(
  `[evidence] ${passed} passed, ${failed} failed of ${declarations.length} declared ` +
    `(${unresolved.length} unresolved, ${undeclared.length} declare nothing, ` +
    `${withoutReadme.length} without a README) in ${seconds.toFixed(1)}s of proof time`,
);
if (failed > 0) {
  console.log("[evidence] RED: at least one declared proof did not pass on this tree");
  Deno.exit(1);
}
if (debt > 0) {
  console.log(
    `[evidence] RED (declaration debt): every declared proof passed, but ${debt} directory(ies) ` +
      `declare nothing and were therefore not run - the list is above, by name`,
  );
  Deno.exit(2);
}
console.log(`[evidence] every declared proof passed on this tree (${passed} proof(s))`);
