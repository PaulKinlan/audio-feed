# audio-feed-8fc: browser proof

Real headless Chrome for Testing, driven over CDP from a Deno script, with a CDP
virtual authenticator (`ctap2`, `internal`, resident keys, user verification,
verified user). The app is the real one, served by `scripts/account-harness.ts`
on memory stores seeded with an admin (Paul), an approved reader (Rita), a
pending invitee (Sam), two sources, four episodes and some run history. Feed and
article fetches are stubbed, so nothing touches the network.

Reproduce:

    deno run --allow-all --unstable-kv scripts/account-browser-proof.ts

## What was driven, in order

| # | Step | Result |
|---|------|--------|
| 1 | Signed-out `/admin` offers passkey sign-in, token behind "Use admin token instead" | 200 |
| 2 | Bootstrap: ADMIN_TOKEN issues Paul a setup link; `/login#setup=…` scrubs the secret from the address bar | location `/login` |
| 3 | Register a passkey from the setup link | 1 resident credential in the authenticator; landed on `/account` |
| 4 | Sign out (header form POST) | `/account` then redirects to `/login` |
| 5 | Sign in with the passkey | back on `/account` |
| 6 | Account edits persist: display name "Paul K.", voice Kore, reload | `["Paul K.","Kore","Paul K."]` |
| 7 | Send to Audio from the account page, no token pasted | queued |
| 8 | The admin reaches `/admin` on the session | 200, 3 subscribers listed |
| 9 | The admin console issues Rita a setup link on the session | link shown in the console only |
| 10 | Rita registers, then a non-admin gets 403 at `/admin` | 403, "This page is for admins" |

`evidence.json` records each step with its detail and the screenshot list.

## Screenshots

Every page at 390px and 1280px, in light and dark (the shell supports both):
`<page>-<width>-<scheme>.png`.

- `01-home-signed-out`: home on the shared shell
- `02-login`: sign in with a passkey
- `03-admin-signed-out`: admin sign-in prompt, token toggle
- `04-login-setup`: the setup-link state ("Create your passkey")
- `05-account`: the account page after edits
- `06-home-signed-in`: the header names the viewer; the "send from your account" note
- `07-admin`: the console on an admin session, with Setup link and Make/Remove admin
- `08-admin-403`: a signed-in non-admin at `/admin`

## Found by this run

The first run failed at sign-out. The account, admin and login pages send
`Referrer-Policy: no-referrer`, and a form POST from such a page carries
`Origin: null`, so the Origin check refused the header's sign-out form.
`sameOrigin` now also accepts `Origin: null` when the browser-set
`Sec-Fetch-Site: same-origin` says the request is same-origin; pages cannot write
that header. It has a route test, which was red before the fix and green after.

No setup secret is written here: every link the run issued was consumed by the
run, on a memory store that ends with the harness.
