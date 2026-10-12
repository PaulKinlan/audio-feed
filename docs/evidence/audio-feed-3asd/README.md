# Browser Proof: Bookmarklet CSP Disclosure & Class Fix (audio-feed-3asd)

- Script: scripts/verify_3asd_bookmarklet_browser.ts
- Asserts: bookmarklet anchor has unified class list without duplicate attributes; bookmarklet anchor is draggable for bookmark bar installation; bookmarklet anchor carries javascript: bookmarklet payload; details disclosure exists under bookmarklet box; summary explains code option when dragging is not possible; details disclosure opens upon user interaction; code snippet in disclosure contains matching bookmarklet source; disclosure code wraps and is fully visible (not horizontally clipped); disclosure text plainly explains browser CSP refusal of javascript: links; browser console explicitly records JavaScript URL CSP refusal on bookmarklet click; zero unhandled page exceptions or unexpected console errors; page and disclosure remain open and stable after link click

## Key Verifications
1. **Unified Class Attribute:** The bookmarklet anchor carries `class="bookmarklet-link u-strong-link"` without duplicate HTML class attributes.
2. **Draggable Installation:** The anchor retains `draggable="true"` and the full `javascript:(function()...` payload for dragging to the bookmarks bar.
3. **No-Script Disclosure Fallback:** A native HTML5 `<details class="bookmarklet-code">` disclosure provides the bookmarklet source inside a `<pre class="bookmarklet-snippet"><code>` element.
4. **Honest CSP Explanation:** The disclosure explains that browsers refuse `javascript:` links when clicked directly on a CSP-protected page and directs the user to drag the link or copy the snippet.
5. **Zero Inline Script:** Operates without any un-nonced inline scripts or click interception scripts, conforming strictly to the page's Content Security Policy.

## Execution Log
```
PASS  bookmarklet anchor has unified class list without duplicate attributes  class: 'bookmarklet-link u-strong-link'
PASS  bookmarklet anchor is draggable for bookmark bar installation  draggable: 'true'
PASS  bookmarklet anchor carries javascript: bookmarklet payload  href starts with: 'javascript:(function(){var u=l...'
PASS  details disclosure exists under bookmarklet box
PASS  summary explains code option when dragging is not possible  summary: 'Can’t drag it? Get the bookmarklet code'
PASS  details disclosure opens upon user interaction
PASS  code snippet in disclosure contains matching bookmarklet source  snippet matches href (617 chars)
PASS  disclosure code wraps and is fully visible (not horizontally clipped)  scrollWidth 623 vs clientWidth 623
PASS  disclosure text plainly explains browser CSP refusal of javascript: links  explanation: 'Browsers refuse javascript: links when clicked directly on a...'
PASS  browser console explicitly records JavaScript URL CSP refusal on bookmarklet click  refusal logged: 'Running the JavaScript URL violates the following Content Security Policy direct...'
PASS  zero unhandled page exceptions or unexpected console errors  exceptions: 0, unexpected errors: 0
PASS  page and disclosure remain open and stable after link click
```

## Screenshots
- `01-bookmarklet-disclosure-open.png`: Homepage with bookmarklet box and expanded fallback disclosure showing snippet code.
