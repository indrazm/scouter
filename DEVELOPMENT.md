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

## Decisions

Each decision is written down in [docs/decision](docs/decision) as `NNNN-short-name.md`, with Context, Decision and Consequences. Add the next number when you make one, and keep it short. The app is meant to stay minimal (see 0001).

## Layout

- `src/index.ts`: CLI startup and terminal cleanup.
- `src/app.ts`: the two-pane interface: layout, browse and diff modes, and key routing. The pieces below each own one behavior (0022).
- `src/keys.ts`: shared key checks and the keys that scroll or move a pane. `src/keymap.ts`: the one list of keys behind `?` and `--help`; the README's table must only use keys listed there.
- `src/theme.ts`: the dark and light palettes, and `theme`, which gives out the colours of the mode in use. `src/system-theme.ts`: follows the terminal between them (0027).
- `src/match-style.ts`: the highlight for searched words, shared by the reader and the preview (0025).
- `src/file-finder.ts`: `/` over the file list. `src/preview.ts`: the reader's look at the highlighted text search result (0024). `src/document-search.ts`: `/`, `n`, `N` and `p` over the open file. `src/sidebar-resizer.ts`: the draggable sidebar edge. `src/browse-watcher.ts`: the refresh queue and timer for browsing.
- `src/file-tree.ts`, `src/explorer.ts`: lazy folder expansion, and the icons and clickable rows that render it. The tree refreshes expanded folders and reconciles them against disk.
- `src/code-view.ts`: syntax highlighting, the line-number gutter, and parser-worker cleanup.
- `src/files.ts`: bounded, read-only filesystem access. `src/image-view.ts`: pictures in the reader.
- `src/grammars.ts`: registers the vendored tree-sitter grammars (0014).
- `src/git.ts`: asks git what changed and reads patches.
- `src/marks.ts`: asks git about the browsed folder and turns the answers (changes, staged state, ignored paths) into tree marks, keyed by path relative to it.
- `src/search.ts`: the folder index and query matching behind `/`.
- `src/changes.ts`: the changed-file list. `src/diff-screen.ts`: the diff view that ties it to the patches.
- `src/header.ts`, `src/footer.ts`: pane headers and the two-row footer.
- `src/welcome.ts`: the empty reader screen. `src/help.ts`: the `?` key list. `src/theme.ts`: the shared palette. `src/styled.ts`: multi-colour text.
- `install.sh`: the installer, also run by `scouter --upgrade`.
- `tests/`: `bun test`, using real temporary git repositories and OpenTUI's test renderer.

## Behaviors worth knowing

- **Panes and focus.** The pane holding focus has an indigo border (`theme.accent`, rounded); nothing is dimmed, and border colors are rewritten only when focus actually moves. The sidebar is a faint tint of the terminal background (lighter on dark themes, darker on light ones). It starts at roughly 25% of the width (28 to 40 columns), leaves at least 24 columns for the sidebar and 28 for the reader, and keeps your chosen width for the session.
- **Footer.** The status row shows the active pane, the path, and on the right line count, language, encoding and scroll position. Narrow terminals drop the right-hand facts first, then shorten the path from the left. Key hints change with the active pane and drop from the end when they do not fit.
- **Diff comparison.** The working tree against `HEAD`, including untracked files. In a repository with no commits, everything staged counts as added. Each change is also marked staged (`●`), unstaged (`○`) or both (`◐`) from two name-only diffs.
- **Diff refresh.** About every two seconds (less often in a slow repository) while the screen is open; nothing is redrawn when nothing changed, and polling stops when you leave the screen.
- **Browse refresh.** The file list polls at the same pace: expanded folders are re-listed, changed files get a status letter (folders holding them a dot), git-ignored entries fade, and the open file is re-read when it is saved, keeping the scroll position. Polling pauses while the changes screen is open, which polls itself.
- **Finding.** `/` on the file list walks the browsed folder (breadth first, capped at 20,000 entries, git-ignored paths skipped) and narrows matches as you type; `Tab` in the prompt switches to searching the text inside files: it reads the indexed regular files (not links, not git-ignored, not binary or non-UTF-8) 16 at a time under the reader's 1 MiB per-file limit, lists up to 200 lines (10 per file), and stops after 64 MiB of text; while a result is highlighted the reader previews its file, scrolled to the line and tinted, and Esc gives the reader back untouched; Enter opens the file at that line and `n` / `N` step through the same matches. On a text file `/` searches the file instead: Enter (or `↓`) goes to the next matching line and Shift+Enter (or `↑`) to the previous, Esc closes the prompt and keeps the matches for `n` / `N`, and a second Esc clears them. Digits before `G` in the reader jump to that line (`120G`).
- **Git safety.** A private copy of the index (`GIT_INDEX_FILE`) preserving the original's mtime, `--no-ext-diff --no-textconv`, `core.fsmonitor=false`, and literal pathspecs.
- **Limits.** 1,000 changed files listed, 1 MiB per file's diff and 4 MiB across the stacked view (files past that are replaced by a note pointing at `a`); text files show their first 1 MiB, marked in the header and footer; binary files show a note instead of a diff.
- **Highlighting.** Tree-sitter grammars for JavaScript/JSX, TypeScript/TSX, Markdown and Zig come with OpenTUI; JSON, CSS, HTML, Go, Rust, Python, Bash, YAML, TOML, C and Java are vendored in `grammars/` (0014). All are local, so no network access is needed. Tree-sitter may create cache directories under `${XDG_CACHE_HOME:-~/.cache}/scouter`.
- **Theme.** The colours follow the terminal. At start, and whenever the terminal announces a change (OpenTUI's `theme_mode` event), and, if the terminal answered for its colours at all and has not announced a change yet, every 3 seconds, Scouter reads the terminal's background; light or dark is decided by its brightness and the sidebar tint is made from it. A change redraws every pane in the other palette without touching what is open, scroll positions or focus. A terminal that never answers stays dark. `tests/theme.test.ts` checks the contrast of both palettes.
- **Rendering.** Tabs display as four spaces; control and bidirectional override characters display as `�`.
