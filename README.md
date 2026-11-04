# Scouter

**Look through any folder, and see what changed, without leaving the terminal.**

Scouter is a read-only file viewer with a built-in git diff screen. Open a project, move around with the keys you already know from Vim, read any file with syntax highlighting, and press `d` to see every change in your working tree on one scrolling page. It cannot edit, save, or run anything, so it is safe to point at any folder.

```sh
scouter .
```

## Why Scouter

- **Review before you commit.** Press `d` and every changed file's diff is stacked in one view: staged, unstaged, and new files together. Step from hunk to hunk with `n` and `p`.
- **It keeps up with you.** Commit, `git add`, or save in your editor and the diff updates on its own. Your place in the page stays put.
- **Read-only by design.** No editing, no modes, no plugins, no configuration. Your repository is never touched, not even its git index.
- **Quiet interface.** No frames or divider lines. The active pane is bright, the other is dimmed, and a two-row footer tells you where you are and which keys do what.
- **Fast to learn.** `j` and `k` to move, `l` to open, `h` to go back, `Tab` to switch panes. Mouse works too.

## Install

You need [Bun](https://bun.sh) 1.4.4 or newer and git.

```sh
curl -fsSL https://raw.githubusercontent.com/indrazm/scouter/main/install.sh | bash
```

Then, in any folder:

```sh
scouter .                # open the current folder
scouter ./src            # or any folder
scouter README.md        # or a single file
scouter --upgrade        # update to the newest release
scouter --version
```

The installer puts the program in `~/.scouter` and a `scouter` command in `~/.local/bin`. It does not edit your shell configuration; if `~/.local/bin` is not on your `PATH`, it prints the one line to add.

To remove Scouter: `~/.scouter/install.sh --uninstall`. It only deletes what it created.

## Browse and read

Open a folder and the sidebar shows its tree: folders first, expanding in place. Pick a file and it opens on the right with line numbers and syntax highlighting for JavaScript, TypeScript (and JSX/TSX), Markdown and Zig. Everything else shows as plain text.

- Press `w` to wrap long lines.
- Drag the edge of the sidebar to resize it, or use Ctrl+Left / Ctrl+Right.
- Version-control folders and system clutter (`.git`, `.DS_Store`, and friends) stay out of your way.
- File icons use [Nerd Font](https://www.nerdfonts.com) glyphs. Pick a patched font such as JetBrainsMono Nerd Font in your terminal for the best look; names stay readable without one.

Scouter shows UTF-8 text files up to 1 MiB. Binary files, devices and pipes are declined with a message, and nothing is ever written to the files you view.

## See what changed

Press `d` in any git repository. The sidebar turns into the list of changed files, each with its status and line counts, and the reader shows all of their diffs stacked in one view.

| Mark | Meaning                            |
| ---- | ---------------------------------- |
| `M`  | Modified                           |
| `A`  | Added                              |
| `D`  | Deleted                            |
| `R`  | Renamed                            |
| `?`  | Untracked (shown as all additions) |

- **Everything compared with your last commit:** staged and unstaged edits together, plus files git does not track yet.
- **Follow along:** move through the list and the reader jumps to that file; scroll the reader and the list follows.
- **Hunk by hunk:** `n` and `p` step through every change across all files.
- **One file or all:** `a` switches between the full stack and just the highlighted file.
- **Unified or split:** `s` flips between a single column and side-by-side.
- **Live:** the screen re-reads git every couple of seconds while it is open, so commits and edits appear by themselves. `r` reloads immediately.

Press `d` again to return to the file you were reading. Outside a repository, or with a clean working tree, Scouter just says so.

## Keys

| Key                                 | Does                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `j` / `k`, Down / Up                | Move down / up (scroll, in the reader)                                   |
| `h` / `l`, Left / Right             | Collapse / expand a folder or open a file; scroll sideways in the reader |
| Enter                               | Open a file or toggle a folder                                           |
| `g` / `G`, Home / End               | Jump to the top / bottom                                                 |
| Ctrl+`u` / Ctrl+`d`, Page Up / Down | Scroll half a page                                                       |
| Tab, Escape                         | Switch panes / return to the file list                                   |
| `w`                                 | Toggle word wrap                                                         |
| `d`                                 | Show / hide the diff screen                                              |
| `q` / Ctrl+`c`                      | Quit                                                                     |

In the diff screen:

| Key                      | Does                              |
| ------------------------ | --------------------------------- |
| `n` / `p` (or `]` / `[`) | Next / previous hunk              |
| `a`                      | All files / highlighted file only |
| `s`                      | Split / unified view              |
| `r`                      | Reload now                        |

With the mouse, click a file or folder to open it, scroll the pane under the pointer with the wheel, and drag the gap between the panes to resize the sidebar.

## Safe to point at anything

Scouter is meant for looking at code you may not trust yet.

- **It never changes your repository.** Git runs on a private copy of its index, because even `git diff` quietly rewrites `.git/index`. External diff tools, text filters and the filesystem monitor configured in a repository are not run.
- **It never runs what it shows.** The `scouter` command starts Bun with an empty config and without loading `.env`, so a `bunfig.toml` or `.env` in the folder you are viewing cannot run code.
- **Hostile text is defused.** Terminal control characters in files and patches are replaced before they reach your screen.
- **The installer is careful.** It never overwrites a different `scouter` command or a folder it did not create, and installs dependencies from the lockfile with install scripts disabled.

## Updating

```sh
scouter --upgrade
```

Scouter finds the newest release, replaces itself, and tells you what changed: `Upgraded: 0.1.0 → 0.1.1`, or `Already up to date`.

## Customizing the install

Set these before running the installer if the defaults do not suit you:

| Variable          | Default               | Meaning                                                   |
| ----------------- | --------------------- | --------------------------------------------------------- |
| `SCOUTER_REF`     | newest release tag    | Release tag or branch to install, e.g. `v0.1.0` or `main` |
| `SCOUTER_HOME`    | `~/.scouter`          | Where the program is kept                                 |
| `SCOUTER_BIN_DIR` | `~/.local/bin`        | Where the `scouter` command goes                          |
| `SCOUTER_REPO`    | the GitHub repository | Git URL to install from                                   |

## Contributing

Scouter is built with Bun, TypeScript and OpenTUI. See [DEVELOPMENT.md](DEVELOPMENT.md) for how to run it from source, the checks, and how the code is laid out.
