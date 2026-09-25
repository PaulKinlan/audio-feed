# audio-feed-c5n item 1 — the dock reserve, measured

Method: `scripts/listen-harness.ts` served on `http://localhost:8155`, driven over the
Chrome DevTools Protocol at 1280x900, 360x740 and 320x600. `window.ResizeObserver` was
deleted before any page script ran, so the CSS fallback is what applies, and the episode
list was cloned in the page until it overflows the viewport — the condition the reserve
exists for (the harness's five episodes fit on a desktop viewport, where the reserve is
never load-bearing).

The download controls are outlined in red in the screenshots by a style injected through
the protocol. That annotation is not part of the app; it exists so the row whose position
is being measured is visible in a still image.

## The numbers

| `--dock-h` | body reserve (`var + 1rem` gap) | measured dock | reserve vs dock | last row clearance (1280x900) | control clearance |
| --- | --- | --- | --- | --- | --- |
| `11.75rem` = 188px (before) | 204px | 210.4px | **6.4px short** | 25.5px | 45.2px |
| `13.5rem` = 216px (after) | 232px | 210.4px | 21.6px clear | 53.5px | 73.2px |
| measured at runtime (210.4375px) | 226.4px | 210.4px | 16.0px clear — the intended gap | 47.5px | 67.2px |

Dock height was 210.4px at all three widths, so the constant was 22.4px smaller than the
dock it is a fallback for.

## The bead's "roughly 22px behind the dock" does not reproduce

The 22px figure is the difference between the constant and the dock's height. It is not
what the last row sits behind, because the reserve is not the only space below the list:
`main` carries `padding-block-end: 32px` on top of the body's `calc(var(--dock-h) + 1rem)`.
Effective trailing space is therefore 204 + 32 = 236px against a 210.4px dock, and the last
row's control cleared the dock top by 45.2px with the old constant at every size measured.
**No control was hidden**, and the screenshots show both constants clearing the dock.

What was real, and is what this change fixes:

1. The fallback constant is smaller than the thing it stands in for, so the JS-disabled
   path was saved by the `main` padding rather than by the reserve. `13.5rem` covers the
   tallest dock measured (212px in the bead, 210.4px here).
2. A browser WITHOUT `ResizeObserver` but WITH JavaScript had no measurement at all: the
   guarded block only ever ran where the observer existed, so that browser lived with a
   constant forever and never corrected it. That path now measures once at load and keeps
   measuring where the observer exists.

Evidence of (2): with `ResizeObserver` deleted and the page allowed to run its own script,
the page sets `--dock-h: 210.4375px` itself and the control clears the dock by 67.2px.

## Files

- `dock-reserve-11.75rem-OLD.jpg` — reserve 204px, last row 25.5px above the dock top.
- `dock-reserve-13.5rem-NEW.jpg` — reserve 232px, last row 53.5px above the dock top.
