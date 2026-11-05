# 0024: The reader previews the highlighted text result

## Context

Text search results (0023) sit in the narrow file list, so a row shows little of its line, and judging a result meant opening the file, reading, pressing Esc and trying the next one. Meanwhile the reader beside the list showed nothing useful.

## Decision

While a text search result is highlighted, the reader shows that file, scrolled so the line sits a third of the way down and tinted, with a `preview` badge and the file's name in its header. It follows `↑` / `↓`. The preview is its own read-only pane (`HitPreview`), sharing the reader's syntax highlighting, and is not the open file: it is hidden, not closed, so Esc leaves the reader, its scroll position and its footer exactly as they were, and the open-file polling never sees it. Enter opens the file for real, as before. A click on a result now chooses it, as Enter does.

The preview reads the file with `readDocument`, so the same limits apply; it is shown only for text results, not file-name matches. While newer results are on their way the last preview stays, and it goes when the query is too short, nothing matches, or the prompt closes.

## Consequences

- Results can be judged in place, with the surrounding lines, instead of by opening files.
- One file read per highlighted result; moving between hits in the same file reuses it.
- The header and reader visibility have one more state to restore, kept apart from the open file's.
