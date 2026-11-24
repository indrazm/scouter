# 0033: Copy selected text and paths

## Context

0001 excluded clipboard access to keep Scouter minimal and read-only. In practice, because mouse tracking is enabled for clicking rows and resizing the sidebar, dragging across code or a diff highlights text inside OpenTUI without the terminal ever copying it. A read-only viewer that prevents copying a snippet or path feels broken.

## Decision

Amends 0001 to allow read-only copying out of Scouter (never reading from the clipboard or modifying files):

- Dragging across text in the reader, diffs, rendered Markdown, or search previews copies the selection on mouse-up via OSC 52 and the local OS clipboard (`pbcopy`, `wl-copy`, `xclip`, `xsel`) when not over SSH.
- `y` copies the active selection (and clears it), or copies the current file or highlighted entry's path when nothing is selected.
- `Esc` clears an active selection before dismissing search or returning to the file list.
- Selection colours (`selectionFg`, `selectionBg`) are part of both dark and light palettes.

## Consequences

- Copying code snippets and file paths works out of the box locally and over SSH/tmux with zero new dependencies.
- Scouter remains strictly read-only: nothing reads from the clipboard or writes to disk.
