# 0006: Poll git to refresh the diff

## Context

The diff screen has to notice commits, `git add` and edits made in another program. Watching `.git` and the working tree for changes is platform-specific and easy to get wrong.

## Decision

While the diff screen is open, re-read git about every two seconds (`DIFF_POLL_MS`), backing off when git is slow. Nothing is redrawn if nothing changed, the scroll position is held during a background refresh, and polling stops when the screen is left. `r` reloads immediately.

## Consequences

- A change can take up to about two seconds to appear.
- No file-watching code, and the same behavior on every platform.
- Refreshes run through a per-repository queue so two git runs never overlap.
