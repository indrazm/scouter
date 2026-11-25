# 0037: Module-driven layout under src/

## Context

`src/` had grown to 30 flat files, and four of them (`app.ts`, `diff-screen.ts`, `git.ts`, `footer.ts`) held more than half the codebase. Finding where a feature lived meant scanning the whole directory, and editing `app.ts` or `diff-screen.ts` mixed layout, state, rendering and motion in one file.

## Decision

Organize `src/` by feature module (`app/`, `core/`, `explorer/`, `reader/`, `find/`, `diff/`, `ui/`) while keeping `src/index.ts` at the root for `install.sh` and `package.json`. Each module keeps its exported types in a local `types.ts`, and imports point directly to concrete files with no barrel `index.ts` files (`aven/no-barrel-file`).

Split the four largest files along their natural ownership boundaries without changing behavior:

- `app.ts` -> `app/app.ts`, `app/reader-pane.ts`, `app/chrome.ts`, `reader/binary-view.ts`, `reader/reader-motion.ts`.
- `diff-screen.ts` -> `diff/diff-screen.ts` (repository, polling, selection) and `diff/diff-blocks.ts` (stacked diff rendering, folding, wrap, hunk navigation).
- `git.ts` -> `diff/git.ts` (private-index runner, status, marks, stamps) and `diff/patch.ts` (patch reading, splitting and untracked synthesis).
- `footer.ts` -> `ui/footer.ts` and `ui/footer-hints.ts`.

## Consequences

- Each feature's files sit together and stay focused on a single owner, extending 0022.
- `tests/` stays flat so end-to-end tests remain easy to find, importing from the module paths.
- Moving files one level deeper keeps `grammars.ts` (`../../grammars/`) and `welcome.ts` (`../../package.json`) explicit about their root-relative paths.
