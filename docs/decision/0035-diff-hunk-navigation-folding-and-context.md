# 0035: Diff hunk position, file folding, aligned gutters, and context toggle

## Context

In the stacked diff screen, each file's `DiffRenderable` sized its own gutter width so code columns shifted sideways between short and long files. Stepping with `n` / `N` gave no position readout or end-of-diff feedback, `o` always jumped to the first hunk even when scrolled further down, large files could not be folded out of the way, and 3 lines of context was sometimes too narrow to see surrounding code.

## Decision

- Pass a shared `gutter.minDigits` across all displayed blocks so gutters and code columns align vertically.
- Track the active hunk from scroll position: show `i/N hunks` in the footer, open the file at the active hunk's line on `o`, and report `First hunk.` / `Last hunk.` at the ends.
- Show staged/unstaged marks (`●`, `○`, `◐`), a 5-cell proportional diffstat bar (`▪`), a hairline top border between files, and a fold chevron (`▾` / `▸`) on each file header band; toggle folding with `c` or by clicking the header.
- Toggle between standard (`-U3`) and expanded (`-U12`) diff context with `x`, marked by a `wide context` header pill.

## Consequences

- Multi-file diffs scan cleanly on one vertical rail, and large files can be folded without switching away from the stacked view.
- Jumping to source (`o`) lands where the user is actually looking.
