# 0003: No frames, a tinted sidebar, a dimmed inactive pane

## Context

Borders around each panel and a divider line made the screen busy. Users still need to see which pane is active and to resize the sidebar.

## Decision

- No frames and no divider line. The sidebar is a faint tint of the terminal background instead.
- The sidebar is still resizable, by dragging the one-column gap between panes or with Ctrl+Left / Ctrl+Right.
- The pane without focus is dimmed to 50% opacity (`INACTIVE_OPACITY`). The welcome screen is never dimmed.
- One indigo accent. Green was tried and rejected.
- Clicking a row does not move focus. Focus changes only when the click leads to the other pane, otherwise both panes flash.

## Consequences

- The footer pill (`FILES` / `READER`) and the dimming carry the active-pane signal, since there is no border to do it.
- Dimming depends on whether there is something to read, not on which file is highlighted, so brightness does not flicker while moving through the list.
