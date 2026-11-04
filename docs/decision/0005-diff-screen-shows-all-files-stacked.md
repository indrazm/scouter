# 0005: The diff screen shows all files, stacked

## Context

The diff screen first showed one file at a time. For reviewing before a commit, you want the whole change at once.

## Decision

Press `d` for the diff screen. By default the reader stacks every changed file's diff, each under a band naming the file. `a` switches to the highlighted file only. The list follows the reader's scroll, and the reader follows the list. `n` / `p` step through hunks across all files.

It compares the working tree with `HEAD`: staged and unstaged edits together, plus untracked files as additions.

`DiffRenderable` draws only the first file of a multi-file patch, so each file gets its own block rather than rendering one combined patch.

## Consequences

- Reading everything costs more than one file, so the stacked view has a 4 MiB budget and each file's diff a 1 MiB cap. Files past the budget show a note pointing at `a`. At most 1,000 changed files are listed.
- Binary files show a note instead of a diff.
