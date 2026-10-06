# audio-feed-0r0s — the confirm-dialog client has ONE source

Design A (coord decision 2026-10-06): the canonical confirm client — the
`closedby` light-dismiss shim + `askConfirm` — is the region between the
`// #confirm-shared-begin` / `// #confirm-shared-end` marker lines at the top of
`src/assets/admin.js`. `src/routes/shell.ts` imports that file as text (the same
`with { type: "text" }` idiom `src/routes/assets.ts` uses to serve it) and
slices the region into `CONFIRM_DIALOG_CLIENT`, which the account page still
embeds in its classic inline script. The backtick literal in shell.ts is deleted;
there is no second copy to drift, and a broken marker fails at module load
(instead of silently shipping a page without its confirm client). When
audio-feed-3xq part 4c extracts the account script to a module, the region can
be lifted into a composed shared asset and the shell-side slice deleted — the
markers and the constraints (plain script, no import/export, self-contained) are
documented in both files for exactly that hand-off.

Option B (a true shared ESM import via a new stable-URL route) was considered
and rejected by coord: it would invent a second, non-content-addressed
asset-serving mechanism — an architecture call, not an implementer-lane change.

## Before/after served-shell evidence

Command: `deno run -A docs/evidence/audio-feed-0r0s/capture.ts <out>` (renders
the real account page and slices the confirm fragment out of the page's own
`<script>`).

| | before | after |
|---|---|---|
| admin.js asset URL | `/assets/b65e9fd1.admin.js` | `/assets/50d2660c.admin.js` (file gained markers + header note) |
| fragment present on account page | yes | yes |
| fragment (raw bytes) | sha256 `5025fbd…` | sha256 `ff0d147…` (JSDoc, wrapping, indentation differ — see below) |

The raw bytes were never expected to be equal: the two pre-existing copies had
already drifted cosmetically (the typed admin.js copy carries JSDoc and
different line wrapping; the old shell string did not). Measured equivalence of
what executes — both fragments normalized by stripping comments, collapsing all
whitespace and tokenizing punctuation:

- identical after normalization, except for two wrapping parentheses that remain
  from the JSDoc `/** @type {HTMLDialogElement | null} */ (…)` cast; removing
  exactly those two parens makes the normalized forms byte-equal (`true`,
  reproducible with the comparison in this repo's bead comment trail).
- the behavioural contract is additionally pinned by
  `tests/dialog_test.ts` ("confirm client has ONE source…"), which asserts the
  shell export IS the marked region, keeps the full behavioural marker list the
  old sync test used (closedby shim condition, light-dismiss close, blocking
  fallback, danger styling, returnValue contract), and checks the account page
  ships `askConfirm`. The old two-copy sync test is deleted — its reason to
  exist is gone.
