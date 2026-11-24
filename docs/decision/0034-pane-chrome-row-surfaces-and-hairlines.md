# 0034: Hairline inactive borders, pane headers, and active row surfaces

## Context

With transparent inactive borders (0021), the two panes looked asymmetric and the sidebar lacked a top header aligned with the reader. In the file tree and change list, highlighting only the selected row's foreground text made the cursor harder to scan in dense directories, and the `?` help screen filled the entire terminal as a flat wall of text.

## Decision

Refine the interface chrome while keeping zero configuration and no dimming:

- Inactive panes use a hairline border (`theme.border`); the focused pane keeps its indigo accent border (`theme.accent`). With both panes framed, the sidebar no longer paints a separate background tint and inherits the terminal's own background like the reader.
- Both panes have a 2-row header with a bottom hairline divider. The reader header shows the dimmed parent folder breadcrumb before the bold filename; the sidebar header swaps with the `/` find bar so the list never jumps vertically.
- Highlighted rows in the file tree and change list get a subtle row surface (`theme.rowActiveBg`) and a `▎` accent bar; nested tree rows draw faint `│` indent guides and softly tinted file/folder icons.
- The active search match line in the reader is tinted (`targetBg` / `targetGutter`), matching the search preview.
- The `?` help overlay is framed in a centred rounded card, and right-hand footer facts are separated by muted `·` dots.

## Consequences

- Both panes align visually and the active selection, focus, and search match read at a glance in both dark and light modes.
- Every new colour token is checked for WCAG contrast in `tests/theme.test.ts`.
