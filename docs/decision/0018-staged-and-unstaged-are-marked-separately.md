# 0018: Staged and unstaged changes are marked separately

## Context

The change list merges working tree and index into one diff against `HEAD` (0005), which is right for reviewing. But the rows could not tell a staged file from an unstaged one, and that is exactly the distinction you care about before committing.

## Decision

Two extra name-only git calls per refresh — index against the base, working tree against the index — mark each change: `●` staged, `○` unstaged, `◐` both. Untracked files have no mark. The mark sits in the change list next to the status letter.

There is no "staged only" view; the marker keeps the one merged list readable instead.

## Consequences

- Two more read-only git calls per refresh, both name-only and small.
- `git status`'s porcelain format was considered and rejected: name-only diffs reuse the parsing the list already had.
