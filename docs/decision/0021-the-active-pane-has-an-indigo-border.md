# 0021: The active pane has an indigo border

## Context

The inactive pane was dimmed to 50% opacity (0003). Dimming made whole panes harder to read, pulsed visibly on focus changes, and interacted with whichever file was highlighted, so its rules kept needing exceptions ("dim only when there is something to read").

## Decision

Each pane is framed with a rounded border. The pane holding focus draws it in the indigo accent; the other pane's is transparent. Nothing is dimmed, and the border colors are rewritten only when focus actually moves to the other pane. This amends 0003's "no frames": the frame is back, but as the focus signal, not decoration.

## Consequences

- Focus is readable at a glance without any pane losing contrast.
- The borders are always there, so switching focus never reflows the content.
- The footer pill and the reader header's bold title stay; they were never the problem.
