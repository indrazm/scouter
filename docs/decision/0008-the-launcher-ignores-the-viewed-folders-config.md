# 0008: The launcher ignores the viewed folder's Bun config

## Context

Bun reads `bunfig.toml` (which can run a `preload` script) and `.env` from the current directory. Scouter is run from the folder being viewed, which may be untrusted.

## Decision

The installed `scouter` command starts Bun as `bun --config=/dev/null --no-env-file …`. Terminal control and bidirectional override characters in files and patches are replaced with `�` before they are drawn.

## Consequences

- Viewing a folder cannot run code through Bun's configuration.
- `bun run start` during development does not have this protection. Only the installed launcher does.
