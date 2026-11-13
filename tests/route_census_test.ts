/**
 * audio-feed-q2cf5: the route census in THREAT_MODEL.md is a claim about the WHOLE population of
 * entry points, so it is checked against the tree instead of restated by whichever lane adds the
 * next route.
 *
 * WHY THIS EXISTS. `THREAT_MODEL.md` ("Entry-point coverage") states that every entry point is one
 * `router.<method>(...)` registration in `src/app.ts`, that `createRouter` registers all 72 of them
 * itself, and that "the census is the whole population, not a sample of it". The section had just
 * been repaired (it said 32 POST where the tree has 33, so the parts no longer summed to the route
 * count) when the merger measured what the repair left behind: adding one registration,
 * `router.get("/mutant-census-route", ...)`, took the real total from 72 to 73 and the entire fast
 * suite stayed green. The one signal that a route had appeared — a total that no longer adds up —
 * was arithmetic nobody computed. A figure that is only restated at write time tells a reader when
 * it was last true; it does not tell anyone when it stops being true. So the section's own command
 * is run here.
 *
 * THE ENUMERATION IS THE DOCUMENTED COMMAND, not a cleverer approximation of it. `CENSUS_COMMAND`
 * is the line the section publishes, and `ROUTE_REGISTRATION` is that line's pattern character for
 * character, so this suite counts exactly what a reader who runs the doc's grep counts — including
 * a `router.get(` spelled inside a comment, because that is what grep prints — and cannot part
 * company with the published method. The doc row below refuses a section that stops publishing the
 * command this suite uses, so the two cannot silently diverge.
 *
 * THE EXPECTATION IS A LITERAL, AND THAT IS THE POINT. A total computed from the very enumeration
 * it checks is a tautology dressed as an assertion: an enum that partitions the set it iterates can
 * never disagree with it, so a row shaped that way proves only `rows.length === rows.length`.
 * Parsing the figure back out of `THREAT_MODEL.md` moves the same hole one level up — the doc then
 * becomes the only authority, and a number that is wrong in both places is checked against itself.
 * The numbers below are therefore hand-written from the doc (72 = 35 GET + 33 POST + 3 DELETE +
 * 1 `add`) and independent of both the tree and the prose, which is what lets each row fail:
 *
 *   - the two real-tree rows red when `src/app.ts` gains or loses a registration;
 *   - the doc row reds when the published figure stops matching the pin;
 *   - the mutant row proves the comparison is load-bearing rather than vacuous.
 *
 * Growing the population is a deliberate two-place edit — move the route, move the doc figure,
 * move this literal — and every failure message names the `THREAT_MODEL.md` line to move.
 *
 * Mutant: adding a registration to `src/app.ts` reddens "the route census total matches src/app.ts"
 * and "the route census per-method split matches src/app.ts" by name; the synthetic form of the
 * same mutant is the last row, so the property is pinned even when nobody is watching.
 *
 * WHY THE SOURCE PATH IS A CONSTANT AND NOT AN INLINE LITERAL — the bed this suite has to be AWAKE in.
 * A passing suite that the gate does not run is a comment with a test runner attached, and this suite
 * spent its first revision that way. The fast tier selects suites from a DERIVED read relation
 * (`scripts/test-selection.ts`, consulted by `planTests`), and that relation admits a `.ts` path only
 * when the path is RESOLVER-PROVEN: it arrived through a module-scope constant the resolver can
 * resolve (the `add(..., isProvenRead)` branch, audio-feed-tziw). A literal read of the path is an
 * AUTHORED hint instead — `Deno.readTextFile("src/app.ts")` earns this suite a relation for
 * `THREAT_MODEL.md` (data) and NONE for the source file, because a `.ts` read is presumed to be the
 * import graph's job, and a text read never appears in that graph. MEASURED before `APP_SOURCE` existed: a `THREAT_MODEL.md` change
 * SELECTED this suite, and a `src/app.ts` change selected the graph's suites WITHOUT it (79 suites in
 * the bare planner, 107 with the real reverse graph) while every row below still passed. That is
 * backwards from the risk: the route registration these rows exist to catch is added in `src/app.ts`,
 * so the test was dormant in precisely the change it guards. So the path is DECLARED where the
 * resolver can see it: keep `APP_SOURCE` a module-scope `const` and keep the reads going through it.
 * Inlining the literal back into a call silently drops the relation and re-dormants this suite — the
 * rows cannot see that happen, which is why it is written down here.
 *
 * THE BOUNDARY TABLE IS THE SAME CENSUS, PARTITIONED, AND IT IS PARSED HERE (audio-feed-2l2dk).
 * The "Entry-point coverage" table splits that population into eight boundaries so a reviewer can ask
 * which boundary terminates a given route. Its per-row numbers are a READING — which boundary owns a
 * route is a judgement, as the section says — but its total must be the population above. Nothing
 * parsed the table, so `GET /share` sat in boundary 3's prose and out of its row for a week while
 * every suite stayed green: the app-side pins cannot see the document, and the document had no pin of
 * its own. The rows below parse the table and compare it with the tree:
 *
 *   - the counted rows' Registrations column must SUM to the census derived from `src/app.ts` (the
 *     published command, minus its `grep -v '__test/throw'` registration), so both sides of the
 *     comparison are derived numbers rather than one literal restated in two places;
 *   - every route the table names must appear EXACTLY ONCE across the counted rows, and every route
 *     the tree registers must be named by a counted row — or covered by that row's
 *     `the N `/prefix/*` routes` claim, whose N is itself checked against the tree — so a route can
 *     be dropped from a row without the sum moving, which is the /share shape of the bug, and it
 *     reds by name.
 *
 * THE FORMAT THE PARSER NEEDS IS THE FORMAT THE TABLE ALREADY USED, MINUS ONE SHORTHAND. A route is
 * a backticked span whose text, after an optional verb prefix, starts with `/`; the path is the
 * identity and the verb is decoration, because two registrations can share a path (`POST
 * /api/reports/csp` and its `OPTIONS` alias) and the table says so in words. The `(+:id)` and
 * `(+/issues, /telemetry)` shorthands are gone: those cells now spell out `/admin/subscribers/:id`
 * and the two `/admin/observability/...` routes, which is four routes the coverage row could not
 * otherwise see, and no other cell needed changing. Rows 6 and 8 count `—` and are halves of counted
 * rows rather than partitions of their own, so they are excluded from the route scan (the section
 * says a route is counted once, never twice) and their prose may cite routes freely.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/**
 * The file the census counts, held in a module-scope constant ON PURPOSE — this constant IS the
 * declared read relation that puts this suite in the fast tier when `src/app.ts` changes (see the
 * file header). `Deno.readTextFile(APP_SOURCE)` is resolver-proven; a literal argument is not, and a
 * literal argument selects this suite for no change to the file the census is about.
 */
const APP_SOURCE = "src/app.ts";

/**
 * The command `THREAT_MODEL.md` publishes beside the census figure ("Entry-point coverage").
 * `ROUTE_REGISTRATION` below is this command's pattern, character for character.
 */
const CENSUS_COMMAND = "grep -nE 'router\\.(get|post|delete|put|patch|add)\\(' src/app.ts";

/** The grep pattern of `CENSUS_COMMAND`, as a global RegExp. */
const ROUTE_REGISTRATION = /router\.(get|post|delete|put|patch|add)\(/g;

/** Every method name the census pattern counts. */
const METHODS = ["get", "post", "delete", "put", "patch", "add"] as const;

type Method = (typeof METHODS)[number];

/** One `router.<method>(` occurrence in `src/app.ts`. */
interface RouteRegistration {
  method: Method;
}

/**
 * The census `THREAT_MODEL.md` publishes, hand-written from the "Entry-point coverage" sentence
 * "**72 registrations** (35 GET, 33 POST, 3 DELETE, 1 `add`)". See the file header for why this is
 * a literal rather than something derived from `enumerateRouteRegistrations`.
 */
const EXPECTED_ROUTE_CENSUS = {
  total: 72,
  byMethod: { get: 35, post: 33, delete: 3, put: 0, patch: 0, add: 1 },
} as const;

/**
 * The doc text the third row requires: the published figure, spelled exactly as the section spells
 * it. It is written out rather than composed from the pin so the row states what the document must
 * say; moving the pin means moving this sentence too, and the row's message names the line.
 */
const CENSUS_SENTENCE = "**72 registrations** (35 GET, 33 POST, 3 DELETE, 1 `add`)";

/** The section's second statement of the total, in the sentence about `createRouter`. */
const CREATE_ROUTER_SENTENCE = "`createRouter` registers all 72";

function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

/** 1-based line number of the byte/char position `index` within `text`. */
function lineNumberOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * 1-based line number of the first occurrence of `needle`, or `"unknown"` when the text no longer
 * contains it. Failure messages call this, so it must not be able to throw the message away.
 */
function lineOf(text: string, needle: string): string {
  const index = text.indexOf(needle);
  return index === -1 ? "unknown" : String(lineNumberOf(text, index));
}

/** Enumerates every `router.<method>(` registration in an `src/app.ts` text. */
export function enumerateRouteRegistrations(source: string): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  for (const match of source.matchAll(ROUTE_REGISTRATION)) {
    const method = match[1] ?? "";
    if (!isMethod(method)) continue;
    registrations.push({ method });
  }
  return registrations;
}

/** Counts the enumerated registrations per method, with a zero for a method the tree never uses. */
function countByMethod(registrations: RouteRegistration[]): Record<Method, number> {
  const counts: Record<Method, number> = { get: 0, post: 0, delete: 0, put: 0, patch: 0, add: 0 };
  for (const { method } of registrations) counts[method] += 1;
  return counts;
}

/** The boundary table's header row, verbatim: the anchor `parseBoundaryTable` starts from. */
const BOUNDARY_TABLE_HEADER = "| # | Boundary | Registrations | Routes |";

/** The Registrations cell of a row that is not part of the sum (boundaries 6 and 8). */
const NOT_COUNTED = "\u2014";

/** A backticked span: the only place the table may name a route path (see the file header). */
const BACKTICKED_SPAN = /`([^`]+)`/g;

/** `the 19 `/api/admin/*` routes`: one row's claim over a whole path prefix. */
const WILDCARD_CLAIM = /the (\d+) `([^`*]+)\*` routes/g;

/** A verb the table may prefix a path with, to say which method is registered. */
const METHOD_PREFIX = /^(?:GET|POST|DELETE|PUT|PATCH)(?:\/(?:GET|POST|DELETE|PUT|PATCH))?\s+/;

/**
 * The arithmetic sentence under the table, e.g. `**6 + 5 + 7 + 16 + 28 + 9 = 71**`. The reader
 * trusts that sentence, so it is compared with the rows rather than left to drift beside them.
 */
const STATED_SUM = /\*\*((?:\d+\s*\+\s*)+\d+) = (\d+)\*\*/;

/** `router.<method>("<path>"…`: every registration in `src/app.ts` bar the two forms below. */
const ROUTE_PATH_LITERAL = /router\.(get|post|delete|put|patch)\(\s*"([^"]*)"/g;

/** `router.add("<VERB>", "<path>"…`: the CSP preflight alias, whose FIRST string is the verb. */
const ROUTE_ADD_PATH_LITERAL = /router\.add\(\s*"([A-Z]+)"\s*,\s*"([^"]*)"/g;

/** `router.<method>(<CONSTANT>…`: a path held in a module constant (`ADMIN_OBSERVABILITY_ROUTE`). */
const ROUTE_PATH_CONSTANT = /router\.(get|post|delete|put|patch)\(\s*([A-Z][A-Z_0-9]*)/g;

/** `const <CONSTANT> = "/path";`: how the constant form above is resolved, or the row fails. */
const PATH_CONSTANT = /const\s+([A-Z][A-Z_0-9]*)\s*=\s*"([^"]*)"/g;

/** One route as a boundary row names it: the path is the identity, the verb is decoration. */
interface NamedRoute {
  /** `GET`, `POST`, `GET/POST`… when the cell says, `null` when it names only the path. */
  method: string | null;
  path: string;
}

/** `the N `/prefix/*` routes` — a row's count over a path prefix, checked against the tree. */
interface BoundaryWildcard {
  prefix: string;
  claimed: number;
}

/** One row of the "Entry-point coverage" boundary partition table. */
interface BoundaryRow {
  /** The row's `#` cell — the number the boundary headings use. */
  id: number;
  /** The row's Boundary cell, so a failure names the row a reader can find. */
  boundary: string;
  /** `null` for the rows that count `\u2014` and are halves of counted rows, not partitions. */
  registrations: number | null;
  namedRoutes: NamedRoute[];
  wildcards: BoundaryWildcard[];
}

/** One `router.<method>(…)` registration in `src/app.ts`, with the path it mounts. */
interface RegisteredRoute {
  method: string;
  path: string;
}

/**
 * The tree as the doc's SECOND published command sees it: `grep -nE 'router\.(get|…)\(' src/app.ts |
 * grep -v '__test/throw'`. The trap door is a registration the census counts and production does not,
 * and filtering the text the same way the published pipeline does keeps both sides of every
 * comparison counting the same thing.
 */
function withoutTestThrow(source: string): string {
  return source.split("\n").filter((line) => !line.includes("__test/throw")).join("\n");
}

/** Enumerates the path each `router.<method>(…)` registration in an `src/app.ts` text mounts. */
function enumerateRoutePaths(source: string): RegisteredRoute[] {
  const constants = new Map<string, string>();
  for (const match of source.matchAll(PATH_CONSTANT)) {
    constants.set(match[1] ?? "", match[2] ?? "");
  }
  const routes: RegisteredRoute[] = [];
  for (const match of source.matchAll(ROUTE_PATH_LITERAL)) {
    routes.push({ method: (match[1] ?? "").toUpperCase(), path: match[2] ?? "" });
  }
  for (const match of source.matchAll(ROUTE_ADD_PATH_LITERAL)) {
    routes.push({ method: match[1] ?? "", path: match[2] ?? "" });
  }
  for (const match of source.matchAll(ROUTE_PATH_CONSTANT)) {
    const name = match[2] ?? "";
    const path = constants.get(name);
    if (path === undefined) {
      throw new Error(
        `src/app.ts registers a route at the constant ${name} and no module-scope ` +
          `\`const ${name} = "/…"\` resolves it, so nothing here can say which path the boundary ` +
          `table must name. Keep the path a resolvable string constant beside it, or teach ` +
          `enumerateRoutePaths the new form — do not skip it.`,
      );
    }
    routes.push({ method: (match[1] ?? "").toUpperCase(), path });
  }
  return routes;
}

/** A route as a failure message names it: `GET /share`, or the bare path when no verb is known. */
function describeRoute(route: NamedRoute | RegisteredRoute): string {
  return route.method === null ? route.path : `${route.method} ${route.path}`;
}

/** A row as failure messages cite it: by number and name, never by line number. */
function rowLabel(row: BoundaryRow): string {
  return `boundary table row ${row.id} (${row.boundary})`;
}

/** The route paths a row's Routes cell names as literals (verbs stripped, wildcards excluded). */
function parseNamedRoutes(cell: string): NamedRoute[] {
  const named: NamedRoute[] = [];
  for (const match of cell.matchAll(BACKTICKED_SPAN)) {
    const span = match[1] ?? "";
    const verb = span.match(METHOD_PREFIX)?.[0] ?? null;
    const path = span.replace(METHOD_PREFIX, "");
    // A backticked identifier (`Deno.cron`, `poll-now`) is a citation, not a route; a wildcard
    // prefix (`/api/account/*`) is a count over many paths and is parsed as one below.
    if (!path.startsWith("/") || path.endsWith("*")) continue;
    named.push({ method: verb?.trim().toUpperCase() ?? null, path });
  }
  return named;
}

/** The `the N `/prefix/*` routes` claims in a row's Routes cell. */
function parseWildcards(cell: string): BoundaryWildcard[] {
  const wildcards: BoundaryWildcard[] = [];
  for (const match of cell.matchAll(WILDCARD_CLAIM)) {
    wildcards.push({ prefix: match[2] ?? "", claimed: Number(match[1]) });
  }
  return wildcards;
}

/**
 * Parses the eight-boundary table. It fails LOUDLY rather than returning nothing: a parser that
 * silently matches no rows would let every check below pass over an empty set, which is the failure
 * mode this whole suite exists to refuse.
 */
function parseBoundaryTable(doc: string): BoundaryRow[] {
  const lines = doc.split("\n");
  const header = lines.findIndex((line) => line.trim() === BOUNDARY_TABLE_HEADER);
  if (header === -1) {
    throw new Error(
      `THREAT_MODEL.md no longer has the boundary table header ${BOUNDARY_TABLE_HEADER}. The ` +
        `boundary-table rows in tests/route_census_test.ts parse the table through that line, so ` +
        `move the header and the parser together — a table nothing parses is what audio-feed-2l2dk ` +
        `fixed.`,
    );
  }
  const rows: BoundaryRow[] = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^[-: ]*$/.test(cell))) continue; // the |---|---| rule
    if (cells.length !== 6) {
      throw new Error(`THREAT_MODEL.md boundary table row is not four cells: ${line}`);
    }
    const [, idCell = "", boundary = "", registrationsCell = "", routesCell = ""] = cells;
    const id = Number(idCell);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error(`THREAT_MODEL.md boundary table row has a non-numeric # cell: ${line}`);
    }
    let registrations: number | null;
    if (registrationsCell === NOT_COUNTED) {
      registrations = null;
    } else if (/^\d+$/.test(registrationsCell)) {
      registrations = Number(registrationsCell);
    } else {
      throw new Error(
        `THREAT_MODEL.md boundary table row ${id} (${boundary}) has a Registrations cell that is ` +
          `neither a count nor "${NOT_COUNTED}": "${registrationsCell}". The sum below cannot be ` +
          `taken over a cell it cannot read.`,
      );
    }
    rows.push({
      id,
      boundary,
      registrations,
      namedRoutes: parseNamedRoutes(routesCell),
      wildcards: parseWildcards(routesCell),
    });
  }
  if (rows.length === 0) {
    throw new Error(
      `THREAT_MODEL.md has the boundary table header but no rows parsed under it; the checks in ` +
        `tests/route_census_test.ts would then pass over nothing.`,
    );
  }
  return rows;
}

/** The rows that are part of the sum; rows 6 and 8 count `\u2014` and are excluded. */
function countedRows(rows: BoundaryRow[]): BoundaryRow[] {
  return rows.filter((row) => row.registrations !== null);
}

/**
 * The sum the table claims, compared with the registrations the tree actually mounts. Empty means
 * they agree. The row split is a reading; the total is arithmetic, so it must match the census.
 */
function boundarySumProblems(rows: BoundaryRow[], productionRegistrations: number): string[] {
  const counted = countedRows(rows);
  const sum = counted.reduce((total, row) => total + (row.registrations ?? 0), 0);
  if (sum === productionRegistrations) return [];
  const arithmetic = counted.map((row) => `${row.registrations}`).join(" + ");
  return [
    `the counted boundary rows add to ${sum} (${arithmetic}), but src/app.ts registers ` +
    `${productionRegistrations} production registrations. The published census command finds 72 ` +
    `and the section's second published command drops the one that is not production: ` +
    `${CENSUS_COMMAND} | grep -v '__test/throw'`,
    `the counted rows are ${counted.map(rowLabel).join("; ")}.`,
    `Fix: run that second command, decide which boundary terminates the route that moved (which ` +
    `boundary owns a route is a reading — that is why this suite checks the total and the route ` +
    `names, not the split), then move that row's number AND add or remove the route in its cell. ` +
    `If the registration was not intended, remove it from src/app.ts instead. Update the ` +
    `arithmetic sentence under the table too — it is checked by the same row.`,
  ];
}

/**
 * The arithmetic sentence under the table against the rows above it: a stale sentence is the figure a
 * reader checks, so it cannot be left behind by a row that moved.
 */
function statedSumProblems(doc: string, rows: BoundaryRow[]): string[] {
  const counted = countedRows(rows);
  const columns = counted.map((row) => row.registrations ?? 0);
  const sum = columns.reduce((total, count) => total + count, 0);
  const match = doc.match(STATED_SUM);
  if (match === null) {
    return [
      `THREAT_MODEL.md must state the table's arithmetic under it, as ` +
      `"**${columns.join(" + ")} = ${sum}**", because that sentence is the figure a reader ` +
      `adds up by hand and this suite parses it.`,
    ];
  }
  const stated = (match[1] ?? "").split("+").map((part) => Number(part.trim()));
  const statedTotal = Number(match[2]);
  const problems: string[] = [];
  if (stated.join(" + ") !== columns.join(" + ")) {
    problems.push(
      `the arithmetic sentence under the table reads ${stated.join(" + ")} but the rows read ` +
        `${columns.join(" + ")}. Fix: make the sentence the rows (${
          columns.join(" + ")
        } = ${sum}).`,
    );
  }
  if (statedTotal !== sum) {
    problems.push(
      `the arithmetic sentence under the table adds up to ${statedTotal} but the rows add up to ` +
        `${sum}. A sentence that states a total its own rows do not reach is the drift this row ` +
        `exists to catch.`,
    );
  }
  return problems;
}

/**
 * Every way the table's ROUTE NAMES can disagree with the tree — one message per disagreeing route,
 * so a reader is told which route and which row rather than that two sets differ. Keyed by PATH,
 * not by verb, because two registrations legitimately share a path (`POST /api/reports/csp` and its
 * `OPTIONS` alias, `GET`+`POST /api/sources`) and the table names each path once.
 */
function boundaryRouteProblems(rows: BoundaryRow[], production: RegisteredRoute[]): string[] {
  const counted = countedRows(rows);
  const problems: string[] = [];
  const named = new Map<string, { route: NamedRoute; rows: BoundaryRow[] }>();
  for (const row of counted) {
    for (const route of row.namedRoutes) {
      const entry = named.get(route.path) ?? { route, rows: [] };
      entry.rows.push(row);
      named.set(route.path, entry);
    }
  }

  // A route named twice is counted twice by a reader, whatever the sum says.
  for (const entry of named.values()) {
    if (entry.rows.length < 2) continue;
    problems.push(
      `${describeRoute(entry.route)} is named ${entry.rows.length} times across the boundary ` +
        `table — in ${
          entry.rows.map(rowLabel).join(" and ")
        }. The section says a route is counted ` +
        `once, under the boundary that terminates it, never twice, so a route listed in two rows ` +
        `is a double count waiting to balance a route that went missing. Fix: keep it in the row ` +
        `whose boundary terminates it and remove the other mention.`,
    );
  }

  // A wildcard claim is a count over a prefix, so a route cannot hide behind it.
  for (const row of counted) {
    for (const wildcard of row.wildcards) {
      const covered = production.filter((route) => route.path.startsWith(wildcard.prefix));
      if (covered.length === wildcard.claimed) continue;
      problems.push(
        `${rowLabel(row)} claims "the ${wildcard.claimed} \`${wildcard.prefix}*\` routes", but ` +
          `src/app.ts registers ${covered.length} paths under ${wildcard.prefix}: ` +
          `${covered.map(describeRoute).join(", ")}. Fix: correct that row's count (and the sum ` +
          `sentence), or move the route that changed boundary out of the wildcard.`,
      );
    }
  }

  // Every registered route belongs to a counted row, named or covered by that row's wildcard.
  const productionPaths = new Set(production.map((route) => route.path));
  const uniqueProduction = [...new Map(production.map((route) => [route.path, route])).values()];
  for (const route of uniqueProduction) {
    if (named.has(route.path)) continue;
    const owner = counted.find((row) =>
      row.wildcards.some((wildcard) => route.path.startsWith(wildcard.prefix))
    );
    if (owner !== undefined) continue;
    problems.push(
      `${describeRoute(route)} is registered in src/app.ts but no counted boundary row names it. ` +
        `The rows still add up, because nothing counts the routes a cell lists — that is how ` +
        `GET /share went missing from boundary 3's row for a week while the table summed to the ` +
        `population. Fix: add it to the Routes cell of the row whose boundary terminates it, and ` +
        `move that row's number if the registration is new.`,
    );
  }

  // And a route a row still names must still be registered.
  for (const [path, entry] of named) {
    if (productionPaths.has(path)) continue;
    problems.push(
      `${path} is named in ${entry.rows.map(rowLabel).join(" and ")} but src/app.ts no longer ` +
        `registers it: a row left behind by a removal keeps the table disagreeing with the tree in ` +
        `the direction the sum cannot see. Fix: remove the route from the cell and move the row's ` +
        `number — or restore the registration if it was removed by mistake.`,
    );
  }

  return problems;
}

/**
 * The failure message for both real-tree rows, because the fix is the same either way: it names the
 * `THREAT_MODEL.md` lines that carry the figure, what the enumeration actually found, and which
 * methods moved. It names methods rather than `src/app.ts` lines on purpose — on an increase, every
 * line of that method is equally a candidate, and a guessed line would send the reader to the wrong
 * registration. The command in the message prints the real line numbers.
 */
function censusMismatchMessage(doc: string, registrations: RouteRegistration[]): string {
  const counts = countByMethod(registrations);
  const actual = METHODS.map((method) => `${counts[method]} ${method.toUpperCase()}`).join(", ");
  const expected = METHODS.map((method) =>
    `${EXPECTED_ROUTE_CENSUS.byMethod[method]} ${method.toUpperCase()}`
  ).join(", ");
  const moved = METHODS.filter((method) =>
    counts[method] !== EXPECTED_ROUTE_CENSUS.byMethod[method]
  )
    .map((method) => `  ${method}: ${EXPECTED_ROUTE_CENSUS.byMethod[method]} -> ${counts[method]}`);
  const figureLine = lineOf(doc, "that command yields");
  const createRouterLine = lineOf(doc, CREATE_ROUTER_SENTENCE);
  return [
    `the route census drifted: the doc's own command (${CENSUS_COMMAND}) finds ` +
    `${registrations.length} registrations in src/app.ts (${actual}), but this suite pins ` +
    `${EXPECTED_ROUTE_CENSUS.total} (${expected}).`,
    ...(moved.length > 0 ? ["what moved:", ...moved] : []),
    `Fix: run that command, then update the figure at THREAT_MODEL.md:${figureLine} ` +
    `("**${EXPECTED_ROUTE_CENSUS.total} registrations** (35 GET, 33 POST, 3 DELETE, 1 \`add\`)") and ` +
    `THREAT_MODEL.md:${createRouterLine} ("\`createRouter\` registers all ${EXPECTED_ROUTE_CENSUS.total}"), ` +
    `plus EXPECTED_ROUTE_CENSUS and CENSUS_SENTENCE in tests/route_census_test.ts. If the registration ` +
    `was not intended, remove it from src/app.ts instead — do not move the figure.`,
  ].join("\n");
}

Deno.test("audio-feed-q2cf5: the route census total matches src/app.ts", async () => {
  const source = await Deno.readTextFile(APP_SOURCE);
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  const registrations = enumerateRouteRegistrations(source);
  assertEquals(
    registrations.length,
    EXPECTED_ROUTE_CENSUS.total,
    censusMismatchMessage(doc, registrations),
  );
});

Deno.test("audio-feed-q2cf5: the route census per-method split matches src/app.ts", async () => {
  const source = await Deno.readTextFile(APP_SOURCE);
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  const registrations = enumerateRouteRegistrations(source);
  const counts = countByMethod(registrations);
  for (const method of METHODS) {
    assertEquals(
      counts[method],
      EXPECTED_ROUTE_CENSUS.byMethod[method],
      censusMismatchMessage(doc, registrations),
    );
  }
});

Deno.test("audio-feed-q2cf5: THREAT_MODEL.md publishes the pinned census and the command this suite runs", async () => {
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  assertStringIncludes(
    doc,
    CENSUS_COMMAND,
    `THREAT_MODEL.md:${
      lineOf(doc, "The count is mechanical")
    } must publish the command this suite ` +
      `enumerates with, so the doc's figure and the pinned one are derived the same way: ` +
      `${CENSUS_COMMAND}`,
  );
  assertStringIncludes(
    doc,
    CENSUS_SENTENCE,
    `THREAT_MODEL.md:${
      lineOf(doc, "that command yields")
    } must state the pinned census, verbatim: ` +
      `"${CENSUS_SENTENCE}" (src/app.ts enumerates ${EXPECTED_ROUTE_CENSUS.total} registrations).`,
  );
  assertStringIncludes(
    doc,
    CREATE_ROUTER_SENTENCE,
    `THREAT_MODEL.md:${
      lineOf(doc, "are mounted from that single registration path")
    } must state the ` +
      `pinned total in its createRouter sentence: "${CREATE_ROUTER_SENTENCE}" — the section states ` +
      `the figure twice and both statements can go stale.`,
  );
});

Deno.test("audio-feed-q2cf5: mutant adding a registration moves the enumerated count off the pin", async () => {
  const source = await Deno.readTextFile(APP_SOURCE);
  const mutant = `${source}\nrouter.get("/mutant-census-route", () => new Response("mutant"));\n`;
  const mutantRegistrations = enumerateRouteRegistrations(mutant);
  // The comparison in the rows above is what has to red. Proven here rather than asserted: the same
  // enumerator, one extra registration, and the total and the GET split both leave the pin.
  assertEquals(
    mutantRegistrations.length,
    EXPECTED_ROUTE_CENSUS.total + 1,
    "the enumerator must count a route added at the end of src/app.ts",
  );
  assertEquals(
    countByMethod(mutantRegistrations).get,
    EXPECTED_ROUTE_CENSUS.byMethod.get + 1,
    "the per-method split must count a GET added at the end of src/app.ts",
  );
  assert(
    mutantRegistrations.length !== EXPECTED_ROUTE_CENSUS.total,
    "one extra registration must not equal the pinned total, or the real-tree rows are vacuous",
  );
});

Deno.test("audio-feed-2l2dk: the boundary table's counted rows sum to the production census", async () => {
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  const source = await Deno.readTextFile(APP_SOURCE);
  const rows = parseBoundaryTable(doc);
  // Both sides derived: the table's own column, and the registrations the published command finds
  // once its `grep -v '__test/throw'` is applied. Neither is a figure copied out of the other.
  const production = enumerateRouteRegistrations(withoutTestThrow(source)).length;
  const problems = [
    ...boundarySumProblems(rows, production),
    ...statedSumProblems(doc, rows),
  ];
  assert(
    problems.length === 0,
    [
      "the boundary table in THREAT_MODEL.md does not add up to the route census in src/app.ts:",
      ...problems.map((problem) => `  - ${problem}`),
    ].join("\n"),
  );
});

Deno.test("audio-feed-2l2dk: every production route is named exactly once across the boundary rows", async () => {
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  const source = await Deno.readTextFile(APP_SOURCE);
  const rows = parseBoundaryTable(doc);
  const production = enumerateRoutePaths(withoutTestThrow(source));
  // Neither side may be empty: an enumerator that matched nothing would otherwise let the checks
  // below pass over no routes, which is the one failure mode a parsed document invites.
  assert(
    production.length > 0,
    "enumerateRoutePaths matched no registration in src/app.ts — the parser, not the table, is wrong",
  );
  assert(
    countedRows(rows).some((row) => row.namedRoutes.length + row.wildcards.length > 0),
    "no counted boundary row parsed any route — the Routes-cell parser, not the table, is wrong",
  );
  const problems = boundaryRouteProblems(rows, production);
  assert(
    problems.length === 0,
    [
      "the boundary table in THREAT_MODEL.md and the routes registered in src/app.ts disagree:",
      ...problems.map((problem) => `  - ${problem}`),
    ].join("\n"),
  );
});

Deno.test("audio-feed-2l2dk: mutant dropping, doubling or miscounting a boundary row reds these rows", async () => {
  const doc = await Deno.readTextFile("THREAT_MODEL.md");
  const source = await Deno.readTextFile(APP_SOURCE);
  const rows = parseBoundaryTable(doc);
  const production = enumerateRoutePaths(withoutTestThrow(source));
  const productionRegistrations = enumerateRouteRegistrations(withoutTestThrow(source)).length;
  const counted = countedRows(rows);
  assert(counted.length > 0, "the table parsed no counted rows to mutate");

  // (a) A route dropped from its row: the sum does not move, which is exactly why the sum alone was
  // not enough — and the coverage row names the route.
  const droppedShare = counted.map((row) => ({
    ...row,
    namedRoutes: row.namedRoutes.filter((route) => route.path !== "/share"),
  }));
  assert(
    boundarySumProblems(droppedShare, productionRegistrations).length === 0,
    "dropping a route from a row must NOT move the sum, or this mutant proves nothing about the " +
      "route row — the /share bug was a row that lost a route and a table that still summed.",
  );
  assert(
    boundaryRouteProblems(droppedShare, production).some((problem) => problem.includes("/share")),
    "the coverage row must red naming /share when GET /share leaves the boundary table",
  );

  // (b) The same route named in two rows: a double count waiting to balance a missing one.
  const doubledShare = counted.map((row, index) =>
    index === 0
      ? { ...row, namedRoutes: [...row.namedRoutes, { method: "GET", path: "/share" }] }
      : row
  );
  assert(
    boundaryRouteProblems(doubledShare, production).some((problem) =>
      problem.includes("/share") && problem.includes("named 2 times")
    ),
    "a route named in two rows must red naming the route and both rows",
  );

  // (c) One row's count moved by one: the sum has to notice, and the route rows must not.
  const movedCount = counted.map((row, index) =>
    index === 0 ? { ...row, registrations: (row.registrations ?? 0) + 1 } : row
  );
  assert(
    boundarySumProblems(movedCount, productionRegistrations).length > 0,
    "a row count moved by one must red the sum row",
  );
  assert(
    boundaryRouteProblems(movedCount, production).length === 0,
    "a count moved by one must not disturb the route rows — they check different things, and a " +
      "row that reds for both reasons cannot tell a reader which one happened",
  );
});
