# Typography & Font-Size Policies

Two font-size floors matter to audio-feed: a **form-control focus floor** that comes from iOS
behaviour (§1) and a **readability floor** that is this project's own choice (§2). This document
**records** them and says what, if anything, enforces each. It is not their source: §1's authority
is the platform behaviour quoted below, and §2's is a project decision whose basis is stated where
the decision is described.

**Nothing in this repository reads this file automatically.** It is a policy record, not a gate. The
only automated reader of font sizes anywhere in the toolchain is the Software Factory's
`ui-ux-audit` station, which lives in a **different repository** (`PaulKinlan/agents`) and is
described exactly — including its blind spots — in §2.

## 1. Form-control focus floor on iOS: computed size ≥ 16px

- **Rule.** On iOS, a form control the user types into — `<input>` of a text-entry type (`text`,
  `search`, `url`, `tel`, `email`, `password`, `number`) and `<textarea>` — should compute to at
  least `16px`, because focusing one below that zooms the viewport. See the `<select>` note below:
  it is treated the same way here, but on suspicion rather than on a measurement.
- **Warrant.** Modern Web Guidance, `forms` guide §5 ("Responsive Design and Typography"), verbatim:
  _"DO set `font-size` to at least `1rem` (16px) to prevent iOS zoom."_ The behaviour behind it: iOS
  Safari (WebKit) zooms the viewport when a focused form control computes below `16px`, which moves
  the user's scroll position and has to be pinched back out. `font-size: max(1rem, 1em)` is ≥ 16px
  at a 16px root and still follows the user's font scaling, which a hardcoded `16px` would not. The
  warrant is that sentence, not this document — it can be checked against the guide.

  It matters most on this app's primary surface: the listen page is a standalone PWA
  (`src/routes/pwa.ts:37`, `display: standalone`) with `viewport-fit=cover`
  (`src/routes/listen.ts:236`), so the zoom happens with no browser chrome above it and nothing to
  pinch back out of.
- **`<select>` is a suspicion, not a rule.** The mechanism is commonly reported for `<select>` and
  `<select id="rate">` was treated with the text inputs, but **it was not verified on a device
  here** — no iOS device was available to this work. The warrant sentence is about `input`. The
  text-entry controls in the table below are the cases the repository measured; the two selects are
  the cases it inferred, and a reader should treat them as likely rather than as demonstrated.
- **What the code does today: one rule per document root, written by control TYPE.** There is no
  stylesheet all three surfaces share — the player is a standalone document with its own CSS asset,
  and the shell's kit CSS is emitted only for pages that ask for it (`kit: true`: account, admin,
  login), which the home page does not — so the same rule appears in the two document roots that
  need it, and nowhere else:

  | rule                                          | documents it covers                                                 |
  | --------------------------------------------- | ------------------------------------------------------------------- |
  | `SHELL_CSS` in `src/routes/shell.ts`          | every page rendered through the shell (home, admin, account, login) |
  | `src/assets/listen.css` (last rule, file end) | the standalone player document                                      |

  Both declare only `font-size: max(1rem, 1em)`, on the same selector with `body` in place of
  `.shell`:

  ```css
  .shell input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"]):not([type="color"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="hidden"]),
  .shell select,
  .shell textarea {
    font-size: max(1rem, 1em);
  }
  ```

  The exclusions are the controls the platform does not zoom. They are two `:not()` groups rather
  than one list for a reason worth keeping: it puts the floor above page-level selectors such as
  `.filter-field input[type="search"]`, and a page rule that sets a smaller control font is exactly
  what produced the four defects this section records.

  **What that replaced, and why it matters here:** four per-site declarations — a list of eight
  input types in `home.css`, and `0.9rem`/`0.8rem`/`0.85rem` on the player — which is the
  enumeration shape that produced the defects. On the player the controls were small _on top of_
  `font: inherit` from a 1rem base (`src/assets/listen.css:66` gives `button, select`
  `font: inherit`), so removing the small sizes was half the fix; the home page's three inputs had
  no rule at all and took the UA default. Measured per control, at the merge-base and at the tip:

  | control                                                 | before                 | after                                    |
  | ------------------------------------------------------- | ---------------------- | ---------------------------------------- |
  | `#request-email`, `#request-name`, `#feed-title` (home) | `13.33px` (UA default) | `16.14px` at 390×844, `17px` at 1280×900 |
  | `#filterText` (`.filter-field input[type="search"]`)    | `0.9rem` = 14.4px      | `16px`                                   |
  | `#filterSource` (`.filter-field select`)                | `0.9rem` = 14.4px      | `16px`                                   |
  | `#rate` (playback speed)                                | `0.8rem` = 12.8px      | `16px`                                   |
  | `#shareUrlInput` (share dialog)                         | `0.85rem` = 13.6px     | `16px`                                   |

  `src/assets/home.css:169` (`input[type="url"], input[type="password"]`) is the repository's
  EARLIEST instance of the expression, and its own comment names the mechanism:
  `/* >=16px: smaller text makes iOS zoom on focus. */`. It arrived in `232e4a2` ("feat(f2a): a
  homepage", 2026-09-24), where it was scoped to those two fields on that page — **that was the
  repository's original scope for this behaviour, and this document does not widen it into a
  decision.** Those two fields measure 16.14px.

  **There is no repo-wide decision here, and no check.** The repository has never adopted a
  repo-wide 16px form-control floor; this document does not adopt one on its behalf, and a reader
  should not go looking for a decision that does not exist. What follows is a list of what the code
  does.
- **The control the kit's own enumeration does not list is covered by the family rule, and that was
  measured rather than assumed.** `SHELL_KIT_CSS` — emitted only for `kit: true` pages — enumerates
  `text`, `url`, `email`, `password` and `select` for its control _styling_, so a control outside
  that list gets no kit styling; the floor above does not depend on that list, which is the point of
  writing it by type. The only text-entry control the kit does not enumerate in the app today is
  `src/routes/admin.ts:251`'s `<input id="newDailyBudget" type="number">`, **measured at 16.14px at
  390×844 and 17px at 1280×900** — before this change through the admin page's own
  `input, select { font: inherit }` landing on the shell body's
  `clamp(1rem, 0.96rem + 0.2vw, 1.0625rem)`, and after it through the family rule as well. No known
  text-entry control is below the floor. (An earlier revision of this document claimed `13.33px`
  here and filed **audio-feed-oh1r** on the strength of an absent `font-size` declaration. Absence
  of a declaration is not the UA default: `font: inherit` plus an inherited body size is what
  decides, and the measurement closed that bead as refuted.)
- **Out of scope by the platform mechanism.** `input[type="radio"]`, `input[type="checkbox"]` and
  `input[type="range"]` keep the UA default (13.33px, measured): they take no text focus and raise
  no keyboard, so they do not trigger the zoom. They are excluded by the rules above, not forgotten
  by them.
- **How the coverage was checked, including the part of it that could have been wrong.** A browser
  instrument walks the page's own stylesheets, tests every rule's selector against each control with
  `Element.matches()`, and reports the computed size plus which rules declare it and how:
  - the five controls in the table report `font-size: max(1rem, 1em)` at both viewports;
  - control TYPES the app does not ship yet — an injected `input[type="tel"]`, `input[type="date"]`
    and `<textarea>` — report it too. That is what "by type" means, and a list of present controls
    could not have shown it;
  - its NEGATIVE CONTROL: the deliberately excluded controls (`range`, `color`, `checkbox`) report
    `ABSENT (no rule declares a size)` and compute to the UA default 13.33px, an answer the
    instrument must still be able to give; and run against the pre-change tree it reports `ABSENT`
    for the home page's three inputs, so it finds the real defect as well as the fix.
- **What enforces it: nothing.** No test, no CSS lint and no station rule asserts this floor. The
  station's rules are colour-token drift, missing `:focus-visible`, dark-mode adaptation, **integer
  px below 12px**, fetch-without-loading-state and the responsive viewport meta, and **none of them
  reads a form control's font size**. The two rules above are held by review: a new or changed
  control is checked by hand, by reading `getComputedStyle(el).fontSize` in a browser at a mobile
  width. The duplication between the two document roots is real and deliberate — a shared stylesheet
  neither surface links would be wrong — and if the floor ever needs one source, the change is a
  shared asset linked from both, not a third copy.
- **How the numbers above were measured.** Over CDP in headless Chrome at a 390×844 /
  deviceScaleFactor 2 viewport and again at 1280×900, on `/` and `/listen/:token`, reading
  `[...document.querySelectorAll("input,select,textarea")].map((el) => [el.id || el.className, getComputedStyle(el).fontSize])`
  **at the merge-base of this change (`8f09bbc`, i.e. before it) and again at its tip (after it)**.
  Both columns of the table above are measured values from those two runs, not declarations
  converted. The same instrument reports the geometry, which is how the second half of that claim is
  checked: the only box changes are size-derived (the player's filter controls 39.6px → 42px tall,
  its share field 192px → 221px wide, the speed pill 57.6px → 61.1px wide, the home inputs 21px →
  25px tall), with padding and border unchanged everywhere and the excluded controls untouched. The
  admin control above is measured the same way without a session: `/admin` needs one this work did
  not have, so the rendered page's shipped CSS is inlined into the returned HTML and loaded from
  `file://` in headless Chrome, at 390×844 and 1280×900.

## 2. UI/label readability floor: ≥ 0.75rem / 12px (project heuristic)

- **Rule.** Secondary UI copy, metadata and status labels are not authored below `0.75rem`. No
  `font-size` in `src/assets/*.css` is a px literal and no root font-size override exists, so `1rem`
  is `16px` and `0.75rem` is `12px`.
- **Warrant: there is none that is still live, and the floor is justified on the project's own
  terms.** The number came from Lighthouse's `font-size` audit ("Document uses legible font sizes"),
  which flagged text rendering below `12px` and failed a page when 40% or more of its text was that
  small. **That audit no longer exists: it was removed in Lighthouse 13** (PR #16701), and its
  documentation page now carries the banner "Warning: This audit has been removed as of Lighthouse
  13." It is recorded here as the origin of the figure, **not** as an authority for it. The other
  candidate, Material Design 3, sets small label text at 11–12sp and therefore tolerates 11px: it
  does not support a 12px floor and is not cited as one (an earlier revision cited it as support,
  which was wrong).

  What is left is a project decision, and it is justified as one: the sites at this floor are short,
  glanceable labels — a download percentage, a "Now Playing" badge, the scrubber's elapsed/duration
  readouts — that a listener reads at arm's length on a phone without zooming, and audio-feed chose
  `0.75rem` for them rather than the 11px the platforms permit. It is classified below as a
  **heuristic** precisely because that is all it is: a legibility preference of this project, with
  no measured user-visible harm behind it.
- **Classification.** Project heuristic — readability / mobile comfort. It is not a functional
  defect and no user-visible harm has been measured; the case is legibility polish plus consistency
  with the station that reports it (audio-feed-znpf).
- **Units.** Expressed in relative `rem` so the user's browser font-size preference is respected.
- **Where it is expressed.** The three sites audio-feed-znpf standardised to `0.75rem` are
  canonical, and the floor holds repo-wide today:
  - `src/assets/listen.css:704` — `.ep-download .pct`
  - `src/assets/listen.css:813` — `.now-badge`
  - `src/assets/listen.css:829` — `.scrub .t`
  - other `0.75rem` sites: `src/assets/listen.css:627` (`.ep-restart`), `:649` (`.ep-read`), `:666`
    (`.now-read`), `src/assets/admin.css:371` (`.error-detail`).

  Not a source of sizes: `src/routes/tokens.ts` declares family/mono/spacing tokens (`--font`,
  `--mono`, `--space-*`, `--radius-*`) and **no** font size at all. An earlier revision cited it as
  a location for this floor, which sent a reader to a file with nothing to evaluate
  (audio-feed-uw1m).
- **What enforces it: nothing — and this is the sentence that matters, in full.** The floor is
  stated in `rem`, and **the only automated reader matches integer px literals 0–11 and cannot see a
  rem value**. The `ui-ux-audit` station's rule is
  `re.search(r"font-size\s*:\s*([0-9]|1[01])px\b", content, re.IGNORECASE)`
  (`agents/ui-ux-audit/scripts/scan_ui_ux.py:224`, rule id `illegible-micro-typography`). So
  `font-size: 0.5rem` (8px) — a third below this policy — **scans green**, and so do `em`,
  fractional px, `calc()` and the `font` shorthand. Nothing in this repository checks the floor
  either: there is no CSS lint and no test that reads font sizes. So a documented floor with no
  enforcement is what §2 is today, and it does not read as enforced: **a reviewer has to read rem/em
  values by hand**, and a floor enforced by a checker that cannot see it is a preference rather than
  a gate.
- **The station's matcher was NOT changed by this work, and the fix for it is a change to another
  repository.** `scan_ui_ux.py` lives in `PaulKinlan/agents` (github.com/PaulKinlan/agents), which
  the fleet installs from, so this project neither owns it nor can land it (audio-feed-mj2u,
  audio-feed-w1lt). Widening the rule to `rem`, `em` and fractional px is a change to **that**
  repository, tracked as audio-feed-w1lt and routed there — not done here. When it lands, the
  sentence above has to be updated with it: the bead is the record of that, not this file.

## Provenance

Written for audio-feed-rxa2 (the station enforced a 12px floor that no document in this repository
stated). Corrected for the review findings audio-feed-uw1m, audio-feed-w1lt, audio-feed-mj2u and
audio-feed-f12o (the scope of §1, the shape of the fix), the stale Lighthouse warrant, the location
that named no sizes, the enforcement gap, the measurement that refuted an earlier claim, and the
blind spot, the unlanded cross-repo edit, and the §1 violations. §1's scope was settled by coord's
ruling on 2026-10-13: the sites this change styles are raised and named here, and the one text-entry
control the shell kit does not list is shown by measurement to be covered anyway (audio-feed-oh1r,
filed on the strength of an absent declaration and closed as refuted by that measurement).
