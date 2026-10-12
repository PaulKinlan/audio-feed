# Browser Proof: /account bookmarklet CSP disclosure (audio-feed-kvnw)

- Script: scripts/verify_kvnw_account_bookmarklet_browser.ts
- Asserts: the browser is ON /account with the seeded session (not redirected to /login); bookmarklet anchor keeps its class and is still draggable; anchor still carries the javascript: bookmarklet payload; the disclosure exists on /account; the summary offers the code as the fallback; the open disclosure's snippet is the SAME payload as the anchor href (one builder); the wording names the Content Security Policy and tells the user to drag or paste; the disclosure's code is fully visible inside its box (no horizontal clipping); clicking the anchor is REFUSED by the CSP, and the refusal is asserted rather than collected; the refusal leaves the page and the open disclosure intact; the SAME shared rule also un-clips the front door's disclosure (audio-feed-3asd surface)

## Test Environment
- **Browser:** Headless Chrome (CDP), 1280x900
- **Page:** `GET /account` on an in-process server with an ephemeral port
- **Session:** a real seeded session cookie (`__Host-af_session`), the same way the unit tests sign in

## Key Verifications
1. **Draggable anchor unchanged:** the /account bookmarklet button keeps `class="btn quiet small bookmarklet-btn"`, `draggable="true"` and its `javascript:(function()...` payload.
2. **Disclosure added:** a native `<details class="bookmarklet-code">` under the button, whose `<pre class="bookmarklet-snippet"><code>` carries the SAME payload as the anchor's href.
3. **Honest wording:** the paragraph names the app's Content Security Policy and tells the user to drag the button or paste the code as a bookmark's URL - it does not imply the click works.
4. **The click is OBSERVED, not assumed:** Chrome logs the CSP refusal for the javascript: URL and the check ASSERTS it (audio-feed-1d0n: a collected-and-dropped console array cannot fail, and this check fails if the click ever starts silently working or silently doing nothing).
5. **No inline script:** no click interceptor, no nonced or un-nonced script was added for the fallback.
6. **The code is legible, not merely present:** the snippet box is measured (scrollWidth vs clientWidth) and wraps with `white-space: pre-wrap`. Before this branch's shared rule it rendered as ONE 4754px line inside a 1231px box - so the front door's disclosure, landed in audio-feed-3asd, was clipped too; the same shared rule is re-measured on `/` here so the fix is not applied to one surface at the other's expense.

## Execution Log
```
PASS  the browser is ON /account with the seeded session (not redirected to /login)  pathname: /account
PASS  bookmarklet anchor keeps its class and is still draggable  class: 'btn quiet small bookmarklet-btn', draggable: 'true'
PASS  anchor still carries the javascript: bookmarklet payload  href starts: 'javascript:(function(){var u=l...'
PASS  the disclosure exists on /account  
PASS  the summary offers the code as the fallback  summary: 'Can’t drag it? Get the bookmarklet code'
PASS  the open disclosure's snippet is the SAME payload as the anchor href (one builder)  snippet matches href (617 chars)
PASS  the wording names the Content Security Policy and tells the user to drag or paste  wording: 'Browsers refuse javascript: links when clicked directly on a...'
PASS  the disclosure's code is fully visible inside its box (no horizontal clipping)  scrollWidth 1231 vs clientWidth 1231, white-space: pre-wrap, rendered height 82px
PASS  clicking the anchor is REFUSED by the CSP, and the refusal is asserted rather than collected  console: '[error] Running the JavaScript URL violates the following Content Security Policy directive 'sc...'
PASS  the refusal leaves the page and the open disclosure intact  pathname: /account, disclosure open: true
PASS  the SAME shared rule also un-clips the front door's disclosure (audio-feed-3asd surface)  scrollWidth 623 vs clientWidth 623, rendered height 190px
```

## Screenshot
- `01-account-bookmarklet-disclosure-open.png`: the bookmarklet box with the disclosure expanded, clipped to the box so the evidence is legible and the PNG stays inside the evidence size budget.
