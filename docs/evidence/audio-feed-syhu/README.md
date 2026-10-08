# audio-feed-syhu — drop 'unsafe-inline' from the HTML CSP

**Bead:** audio-feed-syhu (factory audit `tm-csp-unsafe-inline`).
**Branch:** `fleet/sec-keyhdr`.

## What changed

The HTML policy in `src/router.ts` used to allow `script-src 'self' 'unsafe-inline'` and
`style-src 'self' 'unsafe-inline'`. It now carries a **per-response nonce**:

```
default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; img-src 'self' data: https:;
media-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

- `src/routes/csp.ts` — `newCspNonce()`, `htmlContentSecurityPolicy(nonce)`, `htmlResponse(html, nonce, init)`.
- Every HTML route mints one nonce per response, stamps it on the shell's inline `<style>` and
  inline classic `<script>` (and the speculation-rules block and JSON data islands), and puts the
  same nonce in the response's `content-security-policy` header.
- Inline `style="…"` **attributes** are not covered by a nonce, so the ~30 that existed are now
  utility classes (`u-*` in `src/routes/shell.ts`), appended after page CSS in the nonced `<style>`.
- A CSP nonce cannot be guessed by injected markup, so CSP is once again a real last line of defence
  on the credentialed documents.

## Verification

### Unit / integration

- `tests/security_audit_test.ts` asserts the emitted policy contains no `'unsafe-inline'`, carries a
  `script-src`/`style-src` nonce, and a new test fetches every HTML surface (`/`, `/login`, `/admin`,
  `/listen`, `/listen/:token`, `/account`, and the `POST /api/request-access` HTML page) and asserts
  the header nonce **matches** the nonce on the body's inline `<script>`/`<style>` tags and that no
  inline `style="…"` attribute survives.
- `deno fmt --check`, `deno lint`, `deno check main.ts src tests scripts` clean.

### Browser (real enforcement, headless Chrome)

`deno run --allow-all --unstable-kv scripts/csp-nonce-browser-proof.ts` →

```
21/21 checks passed
```

For each of `/`, `/login`, `/admin`, `/listen`, `/listen/:token`, `/account`:

1. **zero `securitypolicyviolation` events** — nothing the page ships was blocked;
2. **zero console errors/warnings/exceptions**;
3. the nonced inline `<style>` was **applied** (a class from it computes a non-zero margin);
4. the inline classic script **executed** — dispatching `pointerover` on a probe `[data-tooltip]`
   element makes the shell's tooltip client show `#appTooltip` (only the inline script can do that).

On `/admin` with a short `ADMIN_TOKEN` it also pins the review finding that the `u-*` classes must
still beat same-specificity rules from the linked sheet: the advisory card's
`margin-block-end/start` is `16px/24px` (`.u-mb-4` wins over `admin.css`'s `.card`), which only
holds because the utility `<style>` is emitted after the `<link rel="stylesheet">`.

The service worker's offline fallback (`src/routes/pwa.ts`) no longer carries an inline
`style="..."` attribute either; it is a `<style>` block, checked by
`tests/security_audit_test.ts`.

Screenshots: `home-1280x900.png`, `login-1280x900.png`, `admin-1280x900.png`,
`listen-landing-1280x900.png`, `listen-player-1280x900.png`, `account-1280x900.png`.
(The small "nonce probe" tooltip at the top-left of the shell screenshots is the proof's probe
element being shown on purpose — evidence that check 4 passed.)
