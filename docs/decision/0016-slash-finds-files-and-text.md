# 0016: `/` finds files and text

## Context

In a large repository, reaching a file meant pressing `j` dozens of times, and reading a long file meant scrolling to find the one line you wanted.

## Decision

`/` on the file list opens a find prompt: the folder is indexed once (breadth first, capped at 20,000 entries, git-ignored paths skipped), and every typed character narrows the matches, with file-name hits first. Enter opens the highlighted match; Esc puts the tree back as it was. The same key over an open file searches its lines instead, and `n` / `p` step between matches. Rendered Markdown has no lines to find, so it points at `m`.

The prompt lives in the footer's status row, which shows a FIND or SEARCH pill. While a prompt is open, typed keys feed it, so letters like `q` and `d` search rather than quit or leave.

## Consequences

- The index is walked on demand and discarded when the prompt closes; nothing is watched or cached.
- Folders ignored by git are skipped, which keeps `node_modules` out of both the cost and the results.
- The search matches line numbers of the source text, so with word wrap on a jump can land a few rows off.
