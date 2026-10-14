# Browser Proof: /account panel layout on mobile (audio-feed-lma7)

- Script: scripts/account-mobile-layout-proof.ts
- Asserts: exactly one closer for the send form's radio group was found in the served markup, and the control flips it; the browser is on the served /account page, not redirected to /login; ONE CLOSER IS THE WHOLE BUG: the control markup puts panels outside the page column and the served markup puts none; and the escaped panel in the control sits hard against the viewport edge, which is Paul's report; at 390x844 the page column exists, so a panel has somewhere to be contained BY; at 390x844 EVERY section.panel is a descendant of div.wrap; at 390x844 every panel is inset by the page column's 16px gutter; at 390x844 the page does not scroll horizontally; at 390x844 the two-column pair is ONE column (Profile stacked over Passkeys); at 320x720 the page column exists, so a panel has somewhere to be contained BY; at 320x720 EVERY section.panel is a descendant of div.wrap; at 320x720 every panel is inset by the page column's 16px gutter; at 320x720 the page does not scroll horizontally; at 320x720 the two-column pair is ONE column (Profile stacked over Passkeys); the 'Your feeds' panel was found on the served page to frame the screenshot; at 1280x900 the panels sit inside the 58rem column, not the full window; at 1280x900 Profile and Passkeys pair into two columns

## Test Environment

- **Browser:** Headless Chrome over CDP, mobile emulation at 390x844 and 320x720, desktop at 1280x900
- **Page:** `GET /account` from the real app on memory stores, signed in with a seeded session cookie, on the canonical proof port
- **Data:** one approved user, two sources, one ready episode - enough for every panel to render; the user's feed token is PINNED, because it is rendered on the page and a random one would make the committed screenshots irreproducible

## What the bug was

The send form's narration-style radio group became `<fieldset class="choices">` (audio-feed-dc2y) and kept its old `</div>` closer. An end tag for a `div` closes every element the parser has open above the matching `div`, and the matching one was `div.wrap` - so the page column ended *inside the send form*. Every `section.panel` after it (Your feeds, Profile, Passkeys, Recent episodes, the danger zone) was a sibling of the column: it kept the panel's own padding, but had none of the wrap's `max-inline-size` or its 1rem gutter, and so ran edge to edge at 390px. That is Paul's report, and it is why no width or breakpoint was at fault: the shared `.panel` and `.wrap` rules were correct, and `/login` and every admin page rendered through the same kit were already fine (checked with the same walk).

## Why the control is the first check

The control document is the served response with the one closer flipped, so it is always the OPPOSITE of what is served: one of the two carries the bug and the other does not, and the check asserts the escape counts invert between them. Without it these checks would be a capture - a containment assertion that has never been seen to be false cannot tell a fixed page from a page that never had the bug. It also makes the `01-before` screenshot's label a proved claim rather than an assumption.

## Execution Log

```
PASS  exactly one closer for the send form's radio group was found in the served markup, and the control flips it  served 80964 bytes closing the group with `</fieldset>`; control 80959 bytes
PASS  the browser is on the served /account page, not redirected to /login  pathname: /account
PASS  ONE CLOSER IS THE WHOLE BUG: the control markup puts panels outside the page column and the served markup puts none  control: 5 of 6 outside div.wrap (feeds-h x=0 w=390, profile-h x=0 w=390, passkeys-h x=0 w=390, episodes-h x=0 w=390, rotate-h x=0 w=390); served: 0 outside
PASS  and the escaped panel in the control sits hard against the viewport edge, which is Paul's report  feeds-h: left 0, right 0; profile-h: left 0, right 0; passkeys-h: left 0, right 0; episodes-h: left 0, right 0; rotate-h: left 0, right 0
PASS  at 390x844 the page column exists, so a panel has somewhere to be contained BY  wrap present: true, 6 section.panel
PASS  at 390x844 EVERY section.panel is a descendant of div.wrap  send-h: inside, feeds-h: inside, profile-h: inside, passkeys-h: inside, episodes-h: inside, rotate-h: inside
PASS  at 390x844 every panel is inset by the page column's 16px gutter  send-h: left 16, right 16; feeds-h: left 16, right 16; profile-h: left 16, right 16; passkeys-h: left 16, right 16; episodes-h: left 16, right 16; rotate-h: left 16, right 16
PASS  at 390x844 the page does not scroll horizontally  document scrollWidth 390 vs viewport 390
PASS  at 390x844 the two-column pair is ONE column (Profile stacked over Passkeys)  profile and passkeys share a left edge and stack vertically
PASS  at 320x720 the page column exists, so a panel has somewhere to be contained BY  wrap present: true, 6 section.panel
PASS  at 320x720 EVERY section.panel is a descendant of div.wrap  send-h: inside, feeds-h: inside, profile-h: inside, passkeys-h: inside, episodes-h: inside, rotate-h: inside
PASS  at 320x720 every panel is inset by the page column's 16px gutter  send-h: left 16, right 16; feeds-h: left 16, right 16; profile-h: left 16, right 16; passkeys-h: left 16, right 16; episodes-h: left 16, right 16; rotate-h: left 16, right 16
PASS  at 320x720 the page does not scroll horizontally  document scrollWidth 320 vs viewport 320
PASS  at 320x720 the two-column pair is ONE column (Profile stacked over Passkeys)  profile and passkeys share a left edge and stack vertically
PASS  the 'Your feeds' panel was found on the served page to frame the screenshot  {"x":0,"y":932,"width":390,"height":722}
PASS  at 1280x900 the panels sit inside the 58rem column, not the full window  send-h: left 185, width 896; feeds-h: left 185, width 896; profile-h: left 185, width 440; passkeys-h: left 641, width 440; episodes-h: left 185, width 896; rotate-h: left 185, width 896
PASS  at 1280x900 Profile and Passkeys pair into two columns  passkeys sits to the right of profile on the same row
```

## Screenshots

- `01-before-390x844.png`: the control - the served markup with the one closer reverted, framed on "Your feeds". The panel runs to both viewport edges.
- `02-after-390x844.png`: the same frame on the served page. The panel is inset by the page column's gutter.
- `03-after-1280x900.png`: the desktop column, where Profile and Passkeys still pair.
- SHA-256 (`01-before-390x844.png`): `1c9a01b279e07e68719b40439c36ecbaceb3e324429904f3a3d88b0e8befdd0c`
- SHA-256 (`02-after-390x844.png`): `39572a1931b32c020c631d212220477f5838b9b38b4646ab214d88848dfffb14`
- SHA-256 (`03-after-1280x900.png`): `cfdec1db5e5edafb3d7bf28743ef9cc7b96b863e72009a0c14baa209d50074f7`
