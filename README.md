# Scouter

A read-only terminal file viewer with built-in git changes. Browse a folder, read any file with syntax highlighting (Markdown shows rendered, images show as pictures), and press `d` to see every change in your working tree on one page.

![Scouter showing a project folder and its welcome screen](docs/screenshot.png)

```sh
curl -fsSL https://raw.githubusercontent.com/indrazm/scouter/main/install.sh | bash
scouter .
```

Needs [Bun](https://bun.sh) 1.4.4+ and git.

## What you get

- **Review before you commit.** Staged, unstaged and new files, stacked in one scrolling diff. `●` means staged, `○` unstaged, `◐` both. Jump between hunks with `n` / `p`.
- **Stays current.** Commit or save in your editor and the file list, its change marks and the open file update themselves.
- **Find anything.** Press `/` on the file list to find a file by name, then `Tab` to search the text inside every file. On an open file, `/` searches that file.
- **Read-only and safe.** It can't edit anything, never touches your git repository, and never runs code from the folder you open.
- **Quiet and fast.** No config. Vim-style keys, mouse optional. The active pane is framed in indigo.

## Keys

| Key             | Does                                   |
| --------------- | -------------------------------------- |
| `j` `k` `h` `l` | Move, open, go back                    |
| `/`             | Find a file (`Tab`: text in all files) |
| `n` `p`         | Next match, or next change in the diff |
| `Tab`           | Switch panes                           |
| `d`             | Show / hide changes                    |
| `a`             | All files / one file                   |
| `s`             | Split / unified diff (wide)            |
| `o`             | Open the changed file at its change    |
| `m`             | Markdown: rendered / source            |
| `w`             | Wrap long lines                        |
| `Space` `b`     | Page down / up                         |
| `g` `G`         | Top / bottom                           |
| `-`             | Open the folder above                  |
| `?`             | Every key                              |
| `q`             | Quit                                   |

## Update or remove

```sh
scouter --upgrade
~/.scouter/install.sh --uninstall
```

Building on Scouter? See [DEVELOPMENT.md](DEVELOPMENT.md). Released under the [MIT License](LICENSE).
