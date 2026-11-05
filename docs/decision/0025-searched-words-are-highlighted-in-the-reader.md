# 0025: Searched words are highlighted in the reader

## Context

Search jumped to a line and tinted nothing, so with the match somewhere in a long line, or several on screen, you still had to find the word yourself.

## Decision

Every occurrence of what was searched for, ignoring case, is drawn in an amber chip: in the open file while a `/` search is typed or kept, in the preview of a text search result, and in the file opened from a result. Esc, or closing the search, clears them.

They are added through `CodeRenderable`'s `onHighlight` hook as a syntax group (`search.match`) on top of what the grammar found, so they sit correctly over code, and a text file with no grammar is given a placeholder filetype that no grammar answers to, because the renderer skips highlighting, and so the hook, when there is no filetype. Writing marks into the text buffer directly did not render, so the hook is the way.

Rendered Markdown is not marked: search asks for the source first (0016). At most 2,000 marks are drawn per file, and nothing is marked if lower-casing would shift positions (a few characters change length).

## Consequences

- One mechanism covers the open file and the preview, in code and plain text.
- Changing the marked words restarts the file's highlight, which loses the reader's place if it happens while the first highlight is still running. Opening a result therefore sets the words before the file loads.
- Each key typed in a `/` search re-highlights the open file; a superseded highlight is dropped, but a 1 MiB file may lag a little.
