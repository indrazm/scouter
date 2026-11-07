# 0031: Paragraph keys and centred matches in the reader

## Context

The reader moved by line, page and file end only. Search jumps (Enter, `n`, `p`, and a text result opened from `/`) put the match a third of the way down the view, so it sat near the top edge and the lines above it were hidden. Vim-style users expect `{` and `}` for paragraphs and `zz` to centre a line.

## Decision

In the reader, `{` and `}` scroll to the previous or next blank line and put it at the top of the view, so a press after that continues from there. `z` then `z` centres the kept search's current match, or the middle line when there is no match. Search jumps now centre the match instead of placing it a third of the way down. `[` and `]` stay hunk jumps in the diff.

Paragraph motion works on the file's source lines, so it is unavailable on rendered Markdown (press `m` first), as search is.

## Consequences

- `zz` with no kept match changes nothing: the middle line is already in the middle. It is kept so the key does what its name says.
- A match near the start or end of a file cannot be centred; the view stops at the file's edge.
- Like search, the line-to-row mapping assumes unwrapped lines, so with `w` on the target can be a few rows off.
