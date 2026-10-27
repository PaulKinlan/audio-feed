# Browser Acceptance Proof: audio-feed-tyu77

- Script: scripts/tooltip-top-layer-browser-proof.ts
- Asserts: clicking an episode's share button opens #shareDialog modally; tooltip is in the top layer (:popover-open) while the modal dialog is open; tooltip carries the Copy button's text, the visible class, and aria-describedby wiring; tooltip is displayed and anchor-positioned to the button inside the dialog

## Problem & Solution

#shareCopyBtn lives INSIDE the modal <dialog id="shareDialog">, and #appTooltip was a body-level position:fixed div at z-index 1000. A modal dialog is in the top layer and no z-index crosses that boundary, so the Copy button's tooltip was painted under the dialog and invisible. The fix: #appTooltip is now popover="manual"; showPopover() puts it in the top layer after the dialog, so it paints above. The popover UA defaults (inset:0, margin:auto) are neutralised in .tooltip so the anchor rules keep sole control of placement, and @starting-style keeps the opacity fade across the display:none boundary.

## What this does NOT prove

Paint order cannot be asserted by elementFromPoint: a modal dialog confines hit-testing to its own subtree by platform rule (measured: elementsFromPoint over an open body-level popover above a modal returns [dialog, HTML]). The screenshot below is the paint-order evidence; the gate-level regression coverage is the headless modal-dialog test in tests/anchor_positioning_test.ts.

## Execution Log

```
PASS  clicking an episode's share button opens #shareDialog modally  
PASS  tooltip is in the top layer (:popover-open) while the modal dialog is open  {"popoverOpen":true,"visible":true,"text":"Copy link to clipboard","describedby":"appTooltip","displayed":true,"anchoredX":true,"anchoredY":true,"tipTop":499,"expectedTop":499}
PASS  tooltip carries the Copy button's text, the visible class, and aria-describedby wiring  text=Copy link to clipboard describedby=appTooltip
PASS  tooltip is displayed and anchor-positioned to the button inside the dialog  top=499 expected=499
```

## Evidence Artifacts

- share-dialog-tooltip-top-layer-1280x900.png: the open share dialog on the real player page with the Copy button's tooltip visible ABOVE the dialog surface.
