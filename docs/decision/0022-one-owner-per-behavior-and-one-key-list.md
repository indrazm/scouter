# 0022: One owner per behavior, and one key list

## Context

`ScouterApp` had grown to about 1,170 lines holding the sidebar drag, the file finder, the in-file search, browse polling and the open file's state all at once. Its state was spread over parallel fields (`hasDocument`, `isImage`, `document`, `documentStamp`) that could disagree, and a search kept the line numbers of a file that had since changed. Keys were described in four places (`--help`, the `?` list, the footer, the README) and had drifted: the `?` list never named `d`.

## Decision

Each behavior with its own state is a small class that `ScouterApp` wires together: `SidebarResizer`, `FileFinder`, `DocumentSearch`, `BrowseWatcher`, and `GitMarks` (which now also owns the repository it reads). What the reader shows is one `Shown` value (nothing, an image or a text file) instead of parallel fields. Shared key checks live in `keys.ts`.

`keymap.ts` is the one list of keys and what they do. The `?` overlay and `--help` are built from it, and a test requires every key in the README's table to appear in it. The footer's hints stay hand-written because they are chosen per pane and per width.

## Consequences

- A change to find, search, resizing or polling touches one file and one class; `app.ts` is left with layout, modes and key routing.
- A kept search follows the file when it is saved or another is opened, because `DocumentSearch` is told when the text changes.
- Adding a key means adding a row to `keymap.ts`; the README and the tests then tell you what else to update.
- `ScouterApp` still switches on `mode` in many places. Splitting it into browse and diff modes was left for when a third mode or a real need arrives (0001).
