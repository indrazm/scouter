# 0028: Ignored paths have their own, fainter colour

## Context

Files and folders git ignores were drawn in `theme.dim`, the colour of hints and paths. That is only a little fainter than normal text, and it has to stay readable (contrast 3 or more), so ignored entries did not recede enough.

## Decision

Each palette has an `ignored` colour, fainter than `dim`, used for ignored rows in the file list. The theme test keeps it visible (contrast 1.8 or more) and fainter than `dim`. The selected row still uses the accent colour, so the cursor is never lost on an ignored entry.

## Consequences

- Build output and dependencies fade behind tracked files in both light and dark.
- Ignored names are harder to read by design; selecting one makes it clear.
