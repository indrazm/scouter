# 0038: Review comments are kept in memory and copied out for an agent

## Context

Reviewing an agent's changes is now a main reason to open the diff screen, and the feedback has to travel back to the agent across multiple rounds of edits. Scouter is read-only (0001, 0007), so it cannot save comments in the repository or beside it, and it has no config or plugin surface to talk to a particular agent. Earlier iterations tried a keyboard cursor line (changed what `j` / `k` do on the diff screen), a 1-row floating input over `row + 1` (hid the next line of code and clipped long comments), and blind `e` export with no way to inspect or discard comments between agent rounds.

## Decision

- Clicking a line number or dragging across line numbers in the diff gutter opens an inline composer directly under the last selected line (sized to the visible viewport, with a yellow bottom hairline) showing a multi-line word-wrapped input (`Shift+Enter`, `Alt+Enter`, or `Ctrl+J` inserts a newline) with cursor movement (`←`/`→`/`↑`/`↓`, `Home`/`End`, `Ctrl+A`/`Ctrl+E`), quick clear (`Ctrl+U`, `Ctrl+W`, `Ctrl+K`), paste support, and a compact `path:line` (or `path:start-end`) and key-hint row underneath. `Enter` saves, saving empty text removes the comment, and `Esc` cancels. Clicking any highlighted line of an active range comment reopens that range comment for editing. `DiffRenderable` cannot take extra rows, so the composer floats directly under the last selected line while open (adding bottom padding so the last line never clips, and falling back to the top of the viewport when editing an outdated comment from the board). Clicking or dragging the code itself still selects and copies (0033), and nothing about focus or scrolling keys changes.
- `e` (or clicking the comment count in the footer) opens a centered **Review Comments** overlay card styled like the `?` help overlay. Every comment is listed by `path:line` or `path:start-end` with its quoted diff lines and wrapped text; comments whose lines no longer match the current diff are marked `outdated`. Inside the board: `j` / `k` move, `Enter` jumps to the start of the range, `e` edits, `x` / `d` deletes one, `X` discards all, `y` copies the review context to the clipboard (0033), `c` copies and clears the slate for the next agent round, and `Esc` closes.
- Commented lines stay tinted yellow (`commentBg`, `commentGutter`, `commentInk`; yellow, because rose read as the red of removed lines), and files with comments show their count in both the `Changes` sidebar and the diff file header.
- Comments live in memory for the session. They are never written to disk, the repository or a file Scouter reads, so nothing about read-only changes.
- Lines and contiguous line ranges within a file diff are the unit: no file comments, threads or replies. Removed and added lines stay distinct targets, since their numbers come from different sides.
- Comments work in unified view without wrap only. Split view and wrapped lines have no one-to-one row for a file line, so the click says so instead of guessing.
- Rows are parsed from the patch text in the order `DiffRenderable` draws unified rows, and hunk header counts decide where a hunk ends, because a removed line such as `-- x` is indistinguishable from a file header.
- While the composer or comments board is open the footer shows a `COMMENT` or `COMMENTS` pill and its keys; typing is captured the way the file and document searches capture it, not a new mode of navigation.

## Consequences

- The loop is: review, click line numbers, `e` to sanity-check on the board, `c` (copy & clear) or `y` (copy), paste into any agent, and review the next pass cleanly. No integration is needed or possible to break.
- Outdated comments after an agent edits a file are surfaced clearly on the board and can be deleted individually or discarded all at once.
- Commenting needs a mouse. A keyboard route could come later if it is missed.
- Quitting Scouter loses the comments. If that proves painful, writing to a path chosen on the command line is the next step; it would be an explicit user choice and still not a write to the viewed tree.
- The help list is one row longer, so the `?` card needs a 43-row terminal to show in full (`--help` always lists everything).
