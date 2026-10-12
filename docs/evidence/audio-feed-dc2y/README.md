# audio-feed-dc2y — polish bundle: agent-annotated forms, a render expectation, dev-tooling perf triage

- Capture: no assertions
- Reason: Architectural record and triage decisions for WebMCP form annotations, view-transition render expectation, and dev-tooling perf findings. Contains no generating script or test assertions; behavioral coverage lives in tests/admin_ui_test.ts, tests/account_pages_test.ts, and tests/listen_landing_asset_test.ts.

P4. Three unrelated small things, recorded here so the diff is reviewable as one pass rather than as
three half-explained changes.

## 1. Four forms are now WebMCP agent tools

`send_article` (the signed-in send-article form), `create_subscriber` (admin), `request_access`
(public) and `open_audio_feed_player` (the player's restore form) carry `toolname`,
`tooldescription` and `toolparamdescription` on their inputs. The attributes are declarative: the
submit paths, validation and JS are untouched, and browsers without WebMCP ignore them entirely, so
there is no fallback code and no Baseline TODO is owed.

WebMCP is an early-preview feature behind `chrome://flags/#enable-webmcp-testing` (Chromium 146+),
not an origin trial, so no trial token is required.

One structural change, which the guidance required rather than the finding: the send form's
narration style is a group of radio buttons, and a parameter description for a group attaches
through the nearest parent `<fieldset>`. It was a `<div role="radiogroup">`, so the description
could not attach at all. It is now a `<fieldset class="choices">` — a radio group is a group of
related controls, and the element for that is a fieldset — with a one-line CSS reset so the class's
flex layout is unchanged.

## 2. A render expectation for cross-document view transitions

Every page here opts into cross-document transitions via `@view-transition { navigation: auto }` in
the shared tokens. Without a render expectation the browser can capture the incoming document before
its above-the-fold content is parsed, and the transition animates to a half-rendered page.

`<link rel="expect" href="#main" blocking="render">` is now in the shared shell head and in both
standalone listen pages (the player and the landing page), each naming the `<main id="main">` that
ends the visible shell. Deliberately only that one element: blocking on more than the initial
viewport delays the transition instead of steadying it, and the attribute is ignored where
unsupported.

## 3. The 14 dev-tooling perf findings: one family fixed, the rest left

The report classifies these INFO because none is on a shipped path. Decisions:

| finding                                          | location                                                                                                                                                                                                                               | decision                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| uncompiled `RegExp` per CDP event                | `scripts/home-module-browser-proof.ts:153`, `scripts/landing-tooltip-browser-proof.ts:174`                                                                                                                                             | **fixed** — cached per suffix, so it is compiled once per distinct suffix instead of once per captured event. The report named the first site; the same helper exists in the second, so both are fixed.                                                                                                                                                   |
| forced synchronous layout in a probe             | `scripts/csp-nonce-browser-proof.ts:230`                                                                                                                                                                                               | left — the report's own remediation says no production fix is warranted; it is a one-off probe asserting a computed spacing.                                                                                                                                                                                                                              |
| sequential seeding loops (10 of them)            | `docs/evidence/att-paging/measure.ts`, `scripts/{account,admin,listen}-harness.ts`, `scripts/admin-module-browser-proof.ts`, `scripts/{auth-demo,gen-fixtures,listen-bench,outbox-proof,regenerate-harness,repro_tts_failure_bp6r}.ts` | left — each is fixture seeding in a harness, an evidence script or a benchmark. The report gates them on "verify the backend is reentrant before parallelising", and for the paging measurement the serial order and materialisation are what the numbers measure. Changing them would alter evidence for no production gain, which is a bad trade at P4. |
| render-blocking asset in a vendored HTML fixture | `docs/evidence/audio-feed-sa4g/article.html:41`                                                                                                                                                                                        | left — it is a third-party fixture kept verbatim; editing it would falsify the evidence it exists to be.                                                                                                                                                                                                                                                  |
