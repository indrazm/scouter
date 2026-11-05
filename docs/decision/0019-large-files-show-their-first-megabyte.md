# 0019: Large files show their first megabyte

## Context

A text file over 1 MiB was refused with an error. The common case is a log you want to look at, not a file you want to page through entirely, and the diff screen already notes instead of refusing past its budget.

## Decision

The reader loads the first 1 MiB of a larger file, cut before the character the limit would split, and says so: a `first 1 MiB` pill in the reader header and a `+` on the line count in the footer. Binary and non-UTF-8 files are still refused.

## Consequences

- The old "File is too large" error is gone for the reader; a new file that big shows the same note in the diff screen, where a partial diff would be wrong.
