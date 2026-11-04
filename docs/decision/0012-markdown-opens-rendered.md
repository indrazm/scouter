# 0012: Markdown opens rendered

## Context

Scouter showed `.md` files as highlighted source only, which made READMEs and docs harder to read than they need to be. OpenTUI Core already ships `MarkdownRenderable`, so rendering needs no new dependency.

## Decision

A Markdown file opens rendered, using OpenTUI's `MarkdownRenderable` with the same syntax colors and tree-sitter client as the file view. `m` switches the open file between rendered and source. Source is the view with line numbers; it is where `w` and sideways panning apply.

Opening another file returns to rendered. The choice is not remembered, and there is no setting for it (0001). Only `.md` is rendered. Everything else is shown as source.

## Consequences

- Rendered Markdown always wraps to the width of the reader, so `w` and panning do not apply to it. The header shows `rendered` instead of `wrap`.
- Line numbers are not shown in the rendered view. Press `m` to see them.
- The diff screen still shows Markdown changes as text diffs.
- It appears after a short parse, not in the same frame as the file opens.
