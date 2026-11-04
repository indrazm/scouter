# Scouter

A small, read-only terminal file viewer with a built-in git diff screen. Inspired by Neovim's navigation, without editing, modes, plugins, or configuration.

## Run

Requires Bun 1.4.4 or newer and an interactive terminal.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run start
bun run start ./src
bun run start ./README.md
```

With no path, Scouter opens the current directory. Dotfiles are shown, except version-control folders (`.git`, `.hg`, `.svn`) and operating-system clutter (`.DS_Store`, `.AppleDouble`, `Thumbs.db`, `desktop.ini`); directories appear first. Folders expand and collapse in place, keeping the tree rooted in the opened directory. Panes have no frames or divider lines. The sidebar has no header; its tree starts at the top. The reader header shows its title bold and bright when active (muted otherwise), plus a quiet `read-only` tag and a `wrap` chip while word wrap is on. The footer's `FILES` / `READER` pill always shows which pane is active. The pane without focus is also dimmed to 50% (`INACTIVE_OPACITY` in `src/app.ts`); the welcome screen is never dimmed.

The footer has two rows. The status bar shows the active pane (`FILES` or `READER`), the path of the open file, and on the right its line count, language, encoding and scroll position (`Top`, `42%`, `Bot`, or `All`). On narrow terminals the right-hand facts drop away first, then the path is shortened from the left. Below it, key hints change with the active pane and drop from the end when they do not fit.

The reader inherits your terminal's default color and opacity; the sidebar is a faint tint of that color (lighter on dark themes, darker on light ones) so the two panes read as separate without borders. The sidebar starts at roughly 25% of the terminal width (28–40 columns). **Drag the edge of the sidebar** (the one-column gap between the panes, which highlights on hover) to resize it, or press Ctrl+Left / Ctrl+Right. Your chosen width is retained for the current session, including when the terminal shrinks and grows. Resizing leaves at least 24 columns for the sidebar and 28 for the reader when the terminal is wide enough.

File and folder icons use **Nerd Font** glyphs. Set your terminal font to a patched font such as JetBrainsMono Nerd Font or Hack Nerd Font. Scouter does not install fonts; filenames remain readable if an icon is unavailable.

## Keys

| Key | File pane | Text pane |
| --- | --- | --- |
| `j` / `k`, Down / Up | Select next / previous | Scroll one line |
| `h`, Left, Backspace | Collapse folder or select parent | Scroll horizontally (`h` / Left) |
| `l` / Right | Expand folder, select its first child, or open file | Scroll horizontally |
| Enter | Toggle folder or open file | — |
| `g` / `G`, Home / End | First / last entry | Top / bottom |
| Ctrl+`u` / Ctrl+`d`, Page Up / Down | — | Scroll half a page |
| Tab | Switch panes | Switch panes |
| `w` | Toggle word wrap | Toggle word wrap |
| `d` | Show / hide the diff screen | Show / hide the diff screen |
| Escape | Focus file pane | Focus file pane |
| `q` / Ctrl+`c` | Quit | Quit |
| Ctrl+Left / Ctrl+Right | Narrow / widen sidebar | Narrow / widen sidebar |

**Mouse:** left-click a file to open it, or a folder to expand/collapse it. The wheel scrolls the pane under the pointer. Drag the gap between the panes to resize the sidebar. Keyboard navigation remains available.

## Diff screen

Press `d` to see what has changed in the git repository containing the directory you opened; press `d` again to go back to the file you were reading. The sidebar becomes a list of changed files (`M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked) with their line counts, and the reader shows the diff of the highlighted file as you move through the list, with syntax highlighting for the same languages as the file view.

It compares the working tree with `HEAD`: staged and unstaged edits together, plus files git does not track yet (shown as all additions). In a repository with no commits everything staged counts as added.

The screen keeps itself current while it is open: about every two seconds (less often in a slow repository) it re-reads git, so a commit, `git add`, or an edit in your editor shows up on its own. The highlight stays on the same file, or near its place if that file was committed, and the diff you are reading is redrawn in place without losing your scroll position. Nothing is redrawn when nothing changed, and it stops entirely when you leave the screen.

| Key | List | Diff |
| --- | --- | --- |
| `j` / `k`, Down / Up | Select next / previous file | Scroll one line |
| Enter, `l` / Right | Read the diff | — |
| `n` / `p` (or `]` / `[`) | Next / previous hunk | Next / previous hunk |
| `s` | Split / unified view | Split / unified view |
| `w` | Wrap long lines | Wrap long lines |
| `r` | Reload now | Reload now |
| Tab, Escape | Switch panes / back to the list | Switch panes / back to the list |
| `d` | Back to the file view | Back to the file view |

The footer shows `CHANGES` or `DIFF` instead of `FILES` or `READER`, with the file count, hunks and total `+`/`−` lines for the diff on screen. A directory outside a repository, a missing `git`, or a clean working tree is reported in place; nothing else about the app changes.

Scouter stays read-only here. Git works on a private copy of the index, because even `git diff` refreshes and rewrites `.git/index`; your repository is never modified. Programs configured by the repository (external diff tools, text conversion filters, the filesystem monitor) are not run, patch text has terminal control characters replaced just like file text, and file names are treated literally. Limits: 1,000 changed files listed, 1 MiB per diff; binary files show a note instead of a diff.

## Scope

- UTF-8 text files up to **1 MiB**, with line numbers. Lines are not wrapped by default; press `w` to toggle word wrap (the header shows `wrap` while it is on).
- Tabs display as four spaces. Terminal control and bidirectional override characters display as `�`.
- Binary files, invalid UTF-8, devices, and pipes are rejected. Symlinks can be followed.
- File errors appear in the status line; expanding or collapsing folders keeps the document visible. Symbolic-link loops are rejected.
- **Tree-sitter syntax highlighting** for JavaScript/JSX, TypeScript/TSX, Markdown, and Zig, detected from the file extension. Unsupported languages remain plain text.
- Grammars are bundled locally: highlighting needs no network access. Markdown markup stays visible; this is a source viewer, not a preview.
- No changes to viewed files, autosave, clipboard integration, or execution of viewed code. Tree-sitter may create cache directories under `${XDG_CACHE_HOME:-~/.cache}/scouter`.

## Development

```sh
bun run dev                 # Restart on source changes
bun run check               # TypeScript + Bun tests
bun run start --help
bun audit
```

`src/index.ts` handles CLI startup and terminal cleanup. `src/app.ts` owns the two-pane interface and keys. `src/file-tree.ts` manages lazy folder expansion; `src/explorer.ts` renders its icons and clickable, scrollable rows. `src/git.ts` asks git what changed and reads patches; `src/changes.ts` is the changed-file list and `src/diff-screen.ts` the diff view that ties them together. `src/header.ts` and `src/footer.ts` draw the pane headers and the two-row footer; `src/welcome.ts` is the empty reader screen; `src/theme.ts` holds the shared palette and `src/styled.ts` builds multi-colour text. `src/code-view.ts` owns syntax highlighting, the line-number gutter, and parser-worker cleanup. `src/files.ts` performs bounded, read-only filesystem access.

Press `d` in Scouter itself to review changes to this README before committing.

Bun + TypeScript + OpenTUI Core keeps the app small: no React layer or custom terminal renderer. Dependency versions and Bun's package-manager version are pinned; dependency install scripts are not trusted and should remain disabled.
