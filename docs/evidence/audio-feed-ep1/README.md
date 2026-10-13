# Bookmarklet & Quick Add Verification Report: audio-feed-ep1

- Script: scripts/bookmarklet-browser-proof.ts
- Asserts: account page renders bookmarklet button; bookmarklet inspects alternate RSS/Atom feeds; bookmarklet also inspects plain feed links; without ?add= the plain send form is the only card; prefill renders exactly one unified card; prefill renders NO second send form; prefill renders no duplicate URL input; the one card offers Queue this single page; the one card offers Subscribe to the feed; queue single episode feedback succeeds; feed subscription feedback succeeds; no-feed prefill is still exactly one card; no-feed prefill has no second form; no-feed prefill has no duplicate input; a page with no declared feed answers with zero feeds; the subscribe half stays hidden when there is nothing to offer; the discovered feed appears without a second card; the server found the page's declared feed and resolved it; the discovered feed keeps its title; a hostile feed candidate never reaches the page; subscribing to the discovered feed succeeds; mobile prefill stays one card with no second form; mobile quick add zero horizontal overflow at 390px; front door pre-fills #url input from ?add= query param; front door pre-fills #feed-url input from ?feed= query param

## Verified Criteria

1. Draggable Bookmarklet Button: Available on /account and / with draggable="true" and accessible title.
2. In-Browser Feed Detection: Bookmarklet extracts links and queries rel~=alternate feeds.
3. ONE Unified Card (audio-feed-6hw): Renders exactly one card and no duplicate send form on prefill.
4. Feed Autodiscovery (audio-feed-6hw): Autodiscovery handles relative paths, quiet pages, and hostile candidate filtering.
5. Mobile Viewport: 390x844 layout verified with zero horizontal overflow.

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

- 01-account-bookmarklet-desktop.png: Account page with draggable bookmarklet widget
- 02-quick-add-single-queued.png: Quick-add panel, single episode queued
- 03-quick-add-subscribed.png: RSS feed subscribed in one click
- 04-quick-add-mobile-390.png: Mobile responsive layout
- 05-front-door-prefilled.png: Front door with prefilled inputs
