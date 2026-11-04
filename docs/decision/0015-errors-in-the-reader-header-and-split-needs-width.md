# 0015: Errors in the reader header, split view needs 60 columns

## Context

Errors such as "Not a git repository." only appeared in the footer, which is easy to miss. Split view on a narrow reader squeezed two columns into unreadable slivers. Keys pressed while a file or the changes were loading were swallowed with no sign of it.

## Decision

- An error from the last action also replaces the reader header's title, in the error colour, until the next key press or action.
- Split view needs a reader at least 60 columns wide. Narrower, `s` says so in the footer and stays unified.
- A change list that was cut short says how many changes it shows.
- A key pressed while loading says "Still loading" in the footer.

## Consequences

- Quit is the last hint in every footer and the last one dropped on a narrow terminal.
- Split view is not switched off when the window narrows later; the user presses `s` again.
- The changes screen is called "changes" in the interface and the README.
