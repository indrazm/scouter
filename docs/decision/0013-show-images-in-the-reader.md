# 0013: Show images in the reader

## Context

Opening a picture used to fail with "Binary files are not supported." OpenTUI Core already has `ImageRenderable`, which draws with the terminal's own graphics (Kitty or Sixel) and falls back to character blocks anywhere else, so it needs no new dependency.

## Decision

Files ending in `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` open as a picture, scaled to fit the reader. The protocol is left on `auto`. The footer shows the pixel size and format instead of lines and encoding. Nothing is configurable (0001).

The file has to be a regular file of at most 10 MiB, and its header is decoded before anything is shown, so a file with an image name that is not an image is refused with a message and the previous file stays open. The type is decided by the extension only.

## Consequences

- How sharp the picture is depends on the terminal. With Kitty or Sixel support it is a real image; otherwise it is coarse blocks.
- The picture is decoded by OpenTUI's native code, from a file that may be untrusted. The size limit and the header check reduce the exposure but do not remove it.
- No zoom, scroll, crop or animation. Other binary files, including SVG, are still refused.
- The diff screen is unchanged: a changed image there is still a binary file with a note.
