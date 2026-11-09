/**
 * audio-feed-yi6na: ask the ENGINE, not the stylesheet text.
 *
 * A string match on a stylesheet answers "is this declaration written down?". It cannot answer the
 * two questions a green CSS row is read as answering:
 *
 *   - does the engine ACCEPT this value? An unknown property, a misspelled value, or the wrong
 *     arity is dropped at parse time, so `assertStringIncludes(css, "text-wrap: balanc")` passes on
 *     a rule that does nothing.
 *   - does the rule APPLY to the element at the computed style? A later cascade rule, a rule in a
 *     module the page never links, or an `@supports` guard the engine fails all leave the text
 *     present and the effect absent. content_visibility_test.ts was the concrete case: only driving
 *     headless Chrome showed `contain-intrinsic-size: auto none auto 92px` parses as ONE PAIR PER
 *     AXIS (computed contain-intrinsic-width "auto none", height "auto 92px").
 *
 * So this helper installs a stylesheet plus caller-supplied markup in headless Chrome and reads
 * back, in ONE page evaluation:
 *
 *   - `CSS.supports(property, value)` for each declaration the caller names;
 *   - `getComputedStyle(element).getPropertyValue(property)` for each selector/property the caller
 *     names, AFTER the stylesheet has been applied by the engine.
 *
 * Both are needed and neither replaces the other: `supports` reds on a typo even where the property
 * would fall back to a default the computed read cannot distinguish from intent, and the computed
 * read reds on a declaration the engine accepts but the cascade drops.
 *
 * What this does NOT do: parse the whole sheet. Only the declarations a caller names get a verdict,
 * which is why the text matches stay in the suites beside these rows — they still catch a
 * declaration REMOVED from the sheet, which no probe of a named declaration can see.
 *
 * Every wait here is the repo's own hang bound (HANG_BOUND_MS, 15 x the measured starved-poll
 * floor from scripts/proof-cdp.ts), passed explicitly to `until()`: a bare two-argument `until()`
 * inherits a default that a starved host can outlive.
 */
import { HANG_BOUND_MS } from "../scripts/proof-cdp.ts";
import { connectCdp } from "../scripts/proof-cdp.ts";
import { withChrome } from "../scripts/proof-helper.ts";

/** A declaration to ask `CSS.supports()` about. */
export interface DeclaredDeclaration {
  /** Property name exactly as written, e.g. "text-wrap". */
  property: string;
  /** Value exactly as written, e.g. "pretty". */
  value: string;
}

/** An element/property pair to read back from `getComputedStyle()`. */
export interface ComputedProbe {
  /** Selector matching an element the caller's markup renders. */
  selector: string;
  /** Property name as `getPropertyValue` takes it (custom properties included). */
  property: string;
  /** Which match to read, when the markup renders more than one. Default 0. */
  index?: number;
}

/** The engine's answers, keyed so a failure message can name the exact pair. */
export interface CssEngineReading {
  /** `CSS.supports(property, value)`, keyed `"<property>: <value>"`. */
  supports: Record<string, boolean>;
  /** Computed value, keyed `"<selector>[<index>] <property>"`. */
  computed: Record<string, string>;
}

/** The key a caller looks a `CSS.supports` answer up by - the same string in a failure message. */
export function supportsKey(property: string, value: string): string {
  return `${property}: ${value}`;
}

/** The key a caller looks a computed value up by. */
export function computedKey(selector: string, property: string, index = 0): string {
  return `${selector}[${index}] ${property}`;
}

export interface CssEngineOptions {
  /** Stylesheet installed in a single <style> element, exactly as it ships. */
  css: string;
  /** Body markup the probes' selectors match. */
  body: string;
  /** Declarations to ask `CSS.supports()` about. */
  declarations: DeclaredDeclaration[];
  /** Element/property pairs to read from the computed style. */
  probes: ComputedProbe[];
}

/**
 * Load `css` + `body` in headless Chrome and return what the ENGINE said.
 *
 * Throws, rather than returning a value that reads as a default, when a probe's selector matches
 * nothing: "no element" and "the declaration did not apply" are different bugs and a shared empty
 * string would let a broken selector look like a broken rule.
 */
export async function readCssInChrome(opts: CssEngineOptions): Promise<CssEngineReading> {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${opts.css}</style></head>
<body>${opts.body}<div id="css-engine-reading"></div>
<script>
(() => {
  const declarations = ${JSON.stringify(opts.declarations)};
  const probes = ${JSON.stringify(opts.probes)};
  const supports = {};
  for (const d of declarations) {
    supports[d.property + ": " + d.value] = CSS.supports(d.property, d.value);
  }
  const computed = {};
  const missing = [];
  for (const p of probes) {
    const index = p.index ?? 0;
    const el = document.querySelectorAll(p.selector)[index] ?? null;
    const key = p.selector + "[" + index + "] " + p.property;
    if (!el) { missing.push(key); continue; }
    computed[key] = getComputedStyle(el).getPropertyValue(p.property);
  }
  document.getElementById("css-engine-reading").textContent =
    JSON.stringify({ supports, computed, missing });
})();
</script></body></html>`;

  const file = await Deno.makeTempFile({ suffix: ".html" });
  try {
    await Deno.writeTextFile(file, html);
    const raw = await withChrome(async (chrome) => {
      const { cdp, js, until, close } = await connectCdp(chrome.port);
      try {
        await cdp("Page.enable");
        await cdp("Page.navigate", { url: `file://${file}` });
        await until(
          `document.getElementById("css-engine-reading")?.textContent.length > 0`,
          "the stylesheet probe's #css-engine-reading JSON (CSS.supports + computed values)",
          HANG_BOUND_MS,
        );
        return await js(`document.getElementById("css-engine-reading").textContent`);
      } finally {
        close();
      }
    }, { prefix: "audiofeed-css-engine-" });
    const reading = JSON.parse(raw) as CssEngineReading & { missing?: string[] };
    if (reading.missing?.length) {
      throw new Error(
        `css-engine: the probe's markup renders no element for ${reading.missing.join(", ")} - ` +
          `the selector is wrong, so this row would have measured nothing rather than the rule ` +
          `(audio-feed-yi6na)`,
      );
    }
    return { supports: reading.supports, computed: reading.computed };
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

/**
 * Whether the `run` permission is available, i.e. whether this module may launch Chrome at all.
 *
 * A row that needs a browser and is run without `--allow-run` must SKIP, not fail: the permission
 * list is the harness's business, not the row's, and the repo's other headless rows gate the same
 * way (`anchor_positioning_test.ts`, `dialog_closedby_test.ts`).
 */
export const browserRowIgnored = (await Deno.permissions.query({ name: "run" })).state !==
  "granted";
