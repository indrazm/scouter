# 0029: A count before G goes to that line, and N goes back

## Context

Reading a file means jumping: to the top, to the bottom, to a line someone named, and back through matches. `G` and `g` covered the ends, but `N` (the usual "previous" key) was missing next to `n`, `gg` is what most people type for the top, and there was no way to reach a line number without searching for it.

## Decision

- `N` steps to the previous match in the reader's search and to the previous hunk in the diff. `p` keeps doing the same.
- `gg` goes to the top, like `g`, which still works on its own.
- Digits typed in the reader before `G` make a count, so `120G` goes to line 120. The count shows in the footer's right-hand facts while it is pending, and any other key drops it. Digits do nothing in the file list, the diff, or a rendered Markdown page, where line numbers do not match the screen.

## Consequences

- Every existing key still does what it did; the new keys only add to them.
- Counts only apply to `G`. `120gg` is not a line jump: `g` is immediate, so a second `g` would be ambiguous without a wait.
- The count is never shown in the file list or the diff, so nothing new is drawn there.
