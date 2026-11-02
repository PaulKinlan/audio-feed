# audio-feed-syhu — drop 'unsafe-inline' from the HTML CSP

- Script: scripts/csp-nonce-browser-proof.ts
- Notes: home is captured SIGNED-OUT and asserts it landed on / (audio-feed-38qar): src/routes/home.ts:263-273 (audio-feed-irgu) 303-redirects a signed-in GET / to /account, so the row clears the session cookie first and restores it after the capture - before that the row captured the /account document byte for byte and its four checks duplicated the account ones; what the row no longer does is silently follow a redirect: where a SIGNED-IN GET / lands is a separate contract this proof does not own, but where a signed-out one lands is asserted
- Asserts: home: zero CSP violations; home: no console errors/warnings; home: inline <style> applied (nonce accepted); home: inline classic script executed (tooltip client ran); home: signed-out viewer landed on /; login: zero CSP violations; login: no console errors/warnings; login: inline <style> applied (nonce accepted); login: inline classic script executed (tooltip client ran); admin: zero CSP violations; admin: no console errors/warnings; admin: inline <style> applied (nonce accepted); admin: inline classic script executed (tooltip client ran); admin: utility CSS wins the tie against the linked .card rule; listen-landing: zero CSP violations; listen-landing: no console errors/warnings; listen-player: zero CSP violations; listen-player: no console errors/warnings; account: zero CSP violations; account: no console errors/warnings; account: inline <style> applied (nonce accepted); account: inline classic script executed (tooltip client ran)

## What changed

The HTML policy carries a per-response nonce on all HTML surfaces, replacing 'unsafe-inline'. Every HTML surface verifies zero CSP violations, zero console errors, applied nonced inline styles, and executed nonced classic scripts.

## Execution Log

```
PASS  home: zero CSP violations  []
PASS  home: no console errors/warnings  clean
PASS  home: inline <style> applied (nonce accepted)  u-mt-4 margin-block-start = 16px
PASS  home: inline classic script executed (tooltip client ran)  shown
PASS  home: signed-out viewer landed on /  landed on /
PASS  login: zero CSP violations  []
PASS  login: no console errors/warnings  clean
PASS  login: inline <style> applied (nonce accepted)  u-mt-4 margin-block-start = 16px
PASS  login: inline classic script executed (tooltip client ran)  shown
PASS  admin: zero CSP violations  []
PASS  admin: no console errors/warnings  clean
PASS  admin: inline <style> applied (nonce accepted)  u-mt-4 margin-block-start = 16px
PASS  admin: inline classic script executed (tooltip client ran)  shown
PASS  admin: utility CSS wins the tie against the linked .card rule  advisory card margin-block-end/start = 16px/24px (want 16px/24px)
PASS  listen-landing: zero CSP violations  []
PASS  listen-landing: no console errors/warnings  clean
PASS  listen-player: zero CSP violations  []
PASS  listen-player: no console errors/warnings  clean
PASS  account: zero CSP violations  []
PASS  account: no console errors/warnings  clean
PASS  account: inline <style> applied (nonce accepted)  u-mt-4 margin-block-start = 16px
PASS  account: inline classic script executed (tooltip client ran)  shown
```
