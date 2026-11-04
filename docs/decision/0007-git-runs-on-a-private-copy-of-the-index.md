# 0007: Git runs on a private copy of the index

## Context

Scouter promises never to modify the repository. But even `git diff` refreshes and rewrites `.git/index`. `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks` did not stop it.

## Decision

Git commands run against a private copy of the index (`GIT_INDEX_FILE`), deleted on exit. The copy keeps the original's modification time. Otherwise git cannot tell which files are unchanged and can report "No changes" wrongly (the racy-git problem).

Git is also run with `--no-ext-diff --no-textconv`, `core.fsmonitor=false` and literal pathspecs, so nothing configured by the repository runs and file names are never treated as patterns.

## Consequences

- The repository is byte-for-byte untouched.
- Each refresh pays for copying the index.
- A regression test covers the racy-index case.
