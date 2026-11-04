# 0009: Install with a bash script, from release tags

## Context

Users should be able to run `scouter .` in any folder after one command, without a package registry or a build.

## Decision

`install.sh` fetches the newest `v*` release tag with git (falling back to `main` before the first release) into `~/.scouter`, runs `bun install --frozen-lockfile --ignore-scripts`, and writes a launcher to `~/.local/bin/scouter`. `scouter --upgrade` runs the same script again.

- It never edits shell configuration. If the bin folder is not on `PATH` it prints the line to add.
- It only replaces or deletes what it created, recognized by a `.scouter-installer` marker folder and a `# scouter-launcher` marker in the command.
- Run from a checkout, it links to the checkout instead, and `--upgrade` tells the user to `git pull`.
- A first install and an update both use `git init`, `fetch --depth 1` and `reset --hard`, not `git clone --branch`, which prints a spurious warning for annotated tags.

## Consequences

- Requires git and Bun on the user's machine.
- A release is a pushed `v*` tag. Users get fixes on `main` only after the next tag.
