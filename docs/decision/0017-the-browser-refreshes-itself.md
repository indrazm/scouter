# 0017: The browser refreshes itself

## Context

Only the diff screen polled (0006). While browsing, a file saved in an editor stayed stale in the reader, and files created or deleted never appeared in the tree until Scouter was restarted. The tree also gave no sign of what had changed; only the diff screen knew.

## Decision

While browsing, about every two seconds (less often if a refresh is slow): expanded folders are re-read and reconciled against disk, keeping entries' expanded state; if the browsed folder is inside a git repository, its changes are re-read and the tree marks changed files with their status letter, folders holding changes with a dot, and ignored entries fade; and the open text file is re-read when its size or modification time changed, keeping the scroll position.

No filesystem watchers: the same poll that proved reliable for the diff screen covers everything. The poll pauses while the diff screen is open, because that screen polls itself. Marks are keyed by path relative to the browsed folder, worked out from the folder's real path, because git reports the repository by its real path and the tree may have been opened through a symlink (macOS `/var`).

## Consequences

- Git runs about as often as the diff screen's poll does, from the same private-index discipline (0007); a second repository object is kept for the browsed root and closed with it.
- A deleted open file keeps its last content on screen, with a notice.
- Rows rebuilt by a refresh keep the selection; nothing is redrawn when nothing changed.
