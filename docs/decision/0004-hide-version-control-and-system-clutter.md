# 0004: Hide version-control and system clutter

## Context

Dotfiles are often meaningful (`.gitignore`, `.oxlintrc.json`), so hiding all of them would be wrong. But `.git` and `.DS_Store` are noise in every folder.

## Decision

Show dotfiles, except a fixed list: `.git`, `.hg`, `.svn`, `.DS_Store`, `.AppleDouble`, `Thumbs.db`, `desktop.ini`. The list is not configurable (see 0001).

## Consequences

- The tree stays clean without a setting.
- A user who wants to browse `.git` cannot do it from Scouter.
