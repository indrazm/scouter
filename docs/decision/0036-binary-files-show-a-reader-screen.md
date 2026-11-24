# 0036: Binary files show a dedicated reader screen

## Context

Previously, opening a binary file left the previous text file visible in the reader while showing `Binary files are not supported.` in the header. That made it look as though the binary file contained the previous file's text.

## Decision

When opening a binary file, show a dedicated centred reader screen naming the file, its size, and why it cannot be rendered (`Binary files are not supported.` / `Scouter only displays UTF-8 text and images.`), while keeping focus in the sidebar so keyboard navigation continues uninterrupted. Actual read errors (missing files, broken images, symlink loops) still report in the header and footer without discarding the open document.

## Consequences

- The reader content always matches the file named in its header and footer.
- Navigating past binary files in the sidebar never traps focus in an unscrollable pane.
