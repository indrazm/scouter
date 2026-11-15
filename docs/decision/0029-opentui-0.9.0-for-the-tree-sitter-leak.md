# 0029 — OpenTUI 0.9.0 for the tree-sitter leak

Date: 2026-11-15

## Context

While a folder was being edited by an agent, Scouter sometimes closed itself. Its own polling
paths are guarded, so nothing in Scouter's code exits on a failed refresh. What the refresh does
while files churn is re-read the open document and set new content on the code view every two
seconds, and rebuild the diff screen's `DiffRenderable`s on every poll — each of those is a
tree-sitter buffer on the shared `TreeSitterClient`.

OpenTUI 0.8.2, the version Scouter pinned, leaked the replaced syntax tree on every
`updateBuffer`/`resetBuffer` in the parser worker (opentui #1937, fixed in 0.9.0 by #1978), and
could apply a debounced reset after an immediate edit, rewinding the buffer so every later parse
failed (opentui #1914, fixed by #2002). Re-highlighting every poll grew the worker's WebAssembly
memory without limit until the process was killed, which looked like the app closing itself.

## Decision

Upgrade `@opentui/core` from 0.8.2 to 0.9.0, keeping the exact-pin convention. The 0.8.4 line's
Code highlight and culling fixes ride along; `web-tree-sitter` stays at 0.25.10 because OpenTUI
pins it identically and Scouter does not import it.

## Consequences

Sessions that watch a folder being edited no longer grow memory per refresh, and the
out-of-order parse failures that silenced highlighting are gone. The API surface Scouter uses is
unchanged; `bun run check` passes without source changes. Future OpenTUI upgrades should be
pushed by crash fixes like this one, not by new features.
