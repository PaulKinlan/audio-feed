# audio-feed-syhu: drop 'unsafe-inline' from the HTML CSP

- Script: scripts/csp-nonce-browser-proof.ts
- Asserts: home: zero CSP violations; home: no console errors/warnings; home: inline <style> applied (nonce accepted); home: inline classic script executed (tooltip client ran); login: zero CSP violations; login: no console errors/warnings; login: inline <style> applied (nonce accepted); login: inline classic script executed (tooltip client ran); admin: zero CSP violations; admin: no console errors/warnings; admin: inline <style> applied (nonce accepted); admin: inline classic script executed (tooltip client ran); admin: utility CSS wins the tie against the linked .card rule; listen-landing: zero CSP violations; listen-landing: no console errors/warnings; listen-player: zero CSP violations; listen-player: no console errors/warnings; account: zero CSP violations; account: no console errors/warnings; account: inline <style> applied (nonce accepted); account: inline classic script executed (tooltip client ran)

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

## Observed Behavior
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

## Screenshots
- `home-1280x900.png`, `login-1280x900.png`, `admin-1280x900.png`,
  `listen-landing-1280x900.png`, `listen-player-1280x900.png`, `account-1280x900.png`.
  (The small "nonce probe" tooltip at the top-left of the shell screenshots is the proof's probe
  element being shown on purpose — evidence that check 4 passed.)
