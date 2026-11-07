# 0030: Ctrl+o and Alt+i walk the jump history

## Context

Opening a file, jumping to a search result and `o` from the changes all move the reader somewhere else, and there was no way back to where the reader was. Vim-style readers use Ctrl+o and Ctrl+i for this. In a terminal, Ctrl+i is the Tab byte (0x09). Scouter does not enable the kitty keyboard protocol, so opentui reads it as `tab` with no ctrl flag. Tab already switches panes (0021 and the README), so Ctrl+i cannot be forward.

## Decision

- Each jump remembers the reader's file and scroll position (in lines) just before it moves away: opening a file, a search result from the finder or the text search, and `o` from the changes (the file the reader showed before the changes). Images are remembered by path.
- `Ctrl+o` goes back and `Alt+i` goes forward. Going back and forward restores the file and its scroll position.
- A new jump drops the places that were ahead, as in an editor. The history keeps the last 100 places, and only for the session: no config and no saved state.
- The keys are shown in the `?` list, `--help`, the README table and the footer hints of the browser and reader.

## Consequences

- `Alt+i` is the compromise for forward. It arrives as `ESC i`, so terminals that send Option as a character (macOS Terminal by default) need "Option as Meta" turned on before it works.
- A new terminal feature that reports Ctrl+i separately from Tab would not make it a forward key on its own; the same key set still applies.
- Jumping from the changes records the file read before them, not the diff itself, so going back returns to the reader, not to the changes screen.
- Typing in the find or search prompt keeps these keys for the prompt.
