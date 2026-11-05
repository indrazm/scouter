# 0026: Enter steps through matches, and Esc keeps them

## Context

In the `/` search over an open file (0016) Enter closed the prompt, so with "1 of 2" showing there was no way to reach the second match without leaving the prompt and pressing `n`. And because every key is text while the prompt is open, nothing could be scrolled or read until it was closed. Browsers and editors do it the other way round.

## Decision

While the prompt is open, Enter (or `↓`) goes to the next matching line, wrapping at the end, and Shift+Enter (or `↑`) to the previous one. Typing still jumps to the first match at or below the top of the reader. Esc closes the prompt but keeps the matches, so they stay highlighted and `n` / `p` keep working while the file is scrolled and read. With the prompt closed and the reader focused, the next Esc clears the kept search; the one after that goes back to the file list, as before. Esc in a prompt with nothing typed clears it at once.

This amends 0016, where Enter kept the search and Esc dropped it.

## Consequences

- Stepping through matches no longer needs a second key or a closed prompt.
- A kept search, including the one a text search result opens with (0023), now takes one extra Esc before the file list gets one.
- Some terminals cannot tell Shift+Enter from Enter, so `↑` is the dependable way back.
