# 0023: Tab in the find prompt searches the text inside files

## Context

`/` found files by name (0016). It could not answer the commonest question after "which file?": "where is this word used?". Searching the open file helps only once you already know the file.

## Decision

Tab inside the file find prompt switches between file names and text. In text mode, once typing pauses for 150 ms and at least two characters are typed, the files already indexed for the prompt are read and every line containing the query (ignoring case) is listed as `name:line  text  folder/`, the match picked out. The file index is reused, so git-ignored paths are skipped and symbolic links, folders and binary or non-UTF-8 files are not read. Each file is read with `readDocument`, so the 1 MiB limit and `displayText` apply as in the reader.

The search is bounded: 16 files at a time, 10 lines per file, 200 lines in all, and it stops after 64 MiB of text. Each of these is reported ("first 200 matches", "12+ matches") rather than hidden. Typing again drops a search under way. Enter opens the file at the line (Markdown as source, since rendered Markdown has no lines) and starts a kept search for the same text, so `n` / `p` walk the remaining matches.

A separate key was rejected: Tab inside the prompt needs no new command, keeps what was typed when you change your mind, and shares the index, the list and the Enter flow.

## Consequences

- Text search needs no dependency and never writes; it reads only what the reader could open.
- The list is narrow, so a row puts the name, line and match first and the folder last, where it is cut off first.
- Files past 1 MiB are searched only in their first megabyte, and a very large tree is searched only partly (the status says so).
- Nothing is cached; the next query reads the files again.
