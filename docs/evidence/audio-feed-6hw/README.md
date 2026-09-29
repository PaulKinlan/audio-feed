# Bookmarklet & Quick Add Verification Report: audio-feed-ep1

## Verified Criteria
1. **Draggable Bookmarklet Button**: Available on `/account` and `/` with `draggable="true"` and accessible title, from ONE builder so both pages carry the same href.
2. **Dynamic In-Browser Detection**: Bookmarklet grabs `location.href`, `document.title`, and queries `rel~=alternate` feeds (rss/atom/feed/json/xml) plus plain feed links.
3. **ONE Unified Card (audio-feed-6hw)**: With `?add=<url>` the page renders exactly one card and NO second send form and no duplicate URL input; without a prefill the plain send form is the only card.
4. **Feed Autodiscovery (audio-feed-6hw)**: With no `?feed=`, the page asks `/api/account/discover-feed`, which reads the page through the SSRF guard and offers the declared feed inside the same card; a page that declares nothing stays silent, and a `javascript:` candidate is dropped rather than rendered.
5. **Intelligent Choice Architecture**: Queue this single page (with direct/deepdive radio choice) and Subscribe to the feed (one-click subscription to `/api/account/sources`) live in the same card.
6. **Preserved Redirection**: Signed-out clicks preserve the full bookmarklet destination through passkey login via `safeNext`.
7. **Convenience Route**: `/add?...` cleanly redirects to `/account?...`.
8. **Security & Sanitization**: URL schemes are strictly validated for `http:` / `https:`; titles are escaped against reflected XSS.
9. **Mobile Viewport**: Verified at 390x844 with zero horizontal overflow, still one card.

## Execution Log
```
PASS  account page renders bookmarklet button  bookmarklet present
PASS  bookmarklet inspects alternate RSS/Atom feeds  feed detection script included
PASS  bookmarklet also inspects plain feed links  anchor shapes included
PASS  without ?add= the plain send form is the only card  forms: 1, cards: 0
PASS  prefill renders exactly one unified card  cards: 1
PASS  prefill renders NO second send form  #sendForm count: 0
PASS  prefill renders no duplicate URL input  #sendUrl count: 0
PASS  the one card offers Queue this single page  single button present
PASS  the one card offers Subscribe to the feed  subscribe button present
PASS  queue single episode feedback succeeds  feedback: 'Queued for synthesis: Extracted Article Title. It will appear in your feed once ready.'
PASS  feed subscription feedback succeeds  feedback: 'Subscribed to A Great Post. 1 post(s) queued.'
PASS  no-feed prefill is still exactly one card  cards: 1
PASS  no-feed prefill has no second form  #sendForm count: 0
PASS  no-feed prefill has no duplicate input  #sendUrl count: 0
PASS  a page with no declared feed answers with zero feeds  feeds: 0
PASS  the subscribe half stays hidden when there is nothing to offer  hidden: true
PASS  the discovered feed appears without a second card  cards: 1, forms: 0
PASS  the server found the page's declared feed and resolved it  label: Discovered Feed — https://example.com/discovered.xml
PASS  the discovered feed keeps its title  label: Discovered Feed — https://example.com/discovered.xml
PASS  a hostile feed candidate never reaches the page  no javascript: candidate rendered
PASS  subscribing to the discovered feed succeeds  feedback: 'Subscribed to Article With A Declared Feed. 0 post(s) queued.'
PASS  mobile prefill stays one card with no second form  cards: 1, forms: 0
PASS  mobile quick add zero horizontal overflow at 390px  no horizontal scroll
PASS  front door pre-fills #url input from ?add= query param  url: 'https://example.com/blog/great-article'
PASS  front door pre-fills #feed-url input from ?feed= query param  feed: 'https://example.com/feed.xml'
```

## Screenshots
- `01-account-bookmarklet-desktop.png`: Account page with draggable bookmarklet widget (1280x900).
- `02-quick-add-single-queued.png`: Quick-add panel with both options, single episode queued (1280x900).
- `03-quick-add-subscribed.png`: RSS feed subscribed in one click from quick-add panel (1280x900).
- `04-quick-add-mobile-390.png`: Mobile responsive layout of the unified card (390x844).
- `05-front-door-prefilled.png`: Front door (`/`) with inputs prefilled from bookmarklet query params.

The audio-feed-6hw legs are captured beside this report in
`docs/evidence/audio-feed-6hw/`:
- `01-unified-card-no-feed.png`: one card, subscribe half still hidden (nothing declared).
- `02-unified-card-discovered-feed.png`: the discovered feed offered inside the same card.
- `03-unified-card-subscribed.png`: subscribed from the discovered feed.

Report version: audio-feed-ep1 + audio-feed-6hw.
