# Developing Scouter

Requires Bun 1.4.4 or newer and an interactive terminal.

## Run from source

```sh
bun install --frozen-lockfile --ignore-scripts
bun run start               # open the current directory
bun run start ./src
bun run start ./README.md
bun run dev                 # restart on source changes
```

Running `./install.sh` from a checkout links the `scouter` command to that checkout instead of downloading a copy; update that one with `git pull`.

## Checks

```sh
bun run check               # everything below, in order
bun run typecheck           # tsrs --noEmit (Rust port of the TypeScript 7 compiler)
bun run lint                # oxlint: correctness, suspicious and perf rules as errors (.oxlintrc.json)
bun run format:check        # oxfmt --check; `bun run format` rewrites files
bun test
bun audit
```

Dependency versions and Bun's package-manager version are pinned. Dependency install scripts are not trusted and should stay disabled.

## Layout

- `src/index.ts`: CLI startup and terminal cleanup.
- `src/app.ts`: the two-pane interface and its keys.
- `src/file-tree.ts`, `src/explorer.ts`: lazy folder expansion, and the icons and clickable rows that render it.
- `src/code-view.ts`: syntax highlighting, the line-number gutter, and parser-worker cleanup.
- `src/files.ts`: bounded, read-only filesystem access.
- `src/git.ts`: asks git what changed and reads patches.
- `src/changes.ts`: the changed-file list. `src/diff-screen.ts`: the diff view that ties it to the patches.
- `src/header.ts`, `src/footer.ts`: pane headers and the two-row footer.
- `src/welcome.ts`: the empty reader screen. `src/theme.ts`: the shared palette. `src/styled.ts`: multi-colour text.
- `install.sh`: the installer, also run by `scouter --upgrade`.
- `tests/`: `bun test`, using real temporary git repositories and OpenTUI's test renderer.

## Behaviors worth knowing

- **Panes and dimming.** The pane without focus is dimmed to 50% (`INACTIVE_OPACITY` in `src/app.ts`); the welcome screen is never dimmed. The sidebar is a faint tint of the terminal background (lighter on dark themes, darker on light ones). It starts at roughly 25% of the width (28 to 40 columns), leaves at least 24 columns for the sidebar and 28 for the reader, and keeps your chosen width for the session.
- **Footer.** The status row shows the active pane, the path, and on the right line count, language, encoding and scroll position. Narrow terminals drop the right-hand facts first, then shorten the path from the left. Key hints change with the active pane and drop from the end when they do not fit.
- **Diff comparison.** The working tree against `HEAD`, including untracked files. In a repository with no commits, everything staged counts as added.
- **Diff refresh.** About every two seconds (less often in a slow repository) while the screen is open; nothing is redrawn when nothing changed, and polling stops when you leave the screen.
- **Git safety.** A private copy of the index (`GIT_INDEX_FILE`) preserving the original's mtime, `--no-ext-diff --no-textconv`, `core.fsmonitor=false`, and literal pathspecs.
- **Limits.** 1,000 changed files listed, 1 MiB per file's diff and 4 MiB across the stacked view (files past that are replaced by a note pointing at `a`); text files up to 1 MiB; binary files show a note instead of a diff.
- **Highlighting.** Tree-sitter grammars for JavaScript/JSX, TypeScript/TSX, Markdown and Zig are bundled, so no network access is needed. Tree-sitter may create cache directories under `${XDG_CACHE_HOME:-~/.cache}/scouter`.
- **Rendering.** Tabs display as four spaces; control and bidirectional override characters display as `�`.
