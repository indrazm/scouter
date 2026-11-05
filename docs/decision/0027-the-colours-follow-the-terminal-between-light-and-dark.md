# 0027: The colours follow the terminal between light and dark

## Context

Every colour was chosen for a dark terminal, and the sidebar tint was worked out once, at startup. When the system went light the terminal's background changed but the sidebar stayed dark, and light-grey text on a light background was close to unreadable.

## Decision

There are two complete palettes, dark and light, in `theme.ts`. `theme` is a view of the one in use, read whenever something is drawn, so nothing keeps a colour of its own. The mode is the terminal's: it is read from the background colour the terminal reports (light when the background is bright), at start, when the terminal announces a change (OpenTUI's `theme_mode`), and by asking again every 3 seconds. The asking is only done if the terminal answered the first time, so one that does not answer is never asked again, and it stops once the terminal has announced a change, since it will announce the next one. The latest question wins: a slow answer that arrives after a newer one is dropped. A terminal that says nothing stays dark, as before.

On a change every pane is drawn again in the new palette: lists, headers, footer, the open file's syntax colours, the diff, the preview and the welcome and key-list screens. What is open, scroll positions, the search and focus are untouched. The sidebar and footer tint is made from the terminal's actual background, so a background that changes without the mode changing is followed too.

A test checks that every colour in one palette exists in the other, and that text, syntax colours, diff lines and the match chip meet WCAG contrast on their backgrounds, so a palette cannot quietly become unreadable.

## Consequences

- Light terminals are readable, and switching needs no restart.
- Polling asks the terminal for its colours every 3 seconds, on terminals that answer but have not yet announced a change; it stops after the first announcement.
- Any new colour must be added to both palettes, and read through `theme` when drawing, not kept in a constant.
- A colour set once at construction (a scrollbar, a border) must be set again in `applyTheme`.
