# 0002: Bun, TypeScript and OpenTUI Core

## Context

The app is a small terminal UI. A heavy framework or a custom terminal renderer would work against keeping it minimal.

## Decision

Bun runs TypeScript directly, with `@opentui/core` for rendering and `web-tree-sitter` for syntax highlighting. No React layer, no build step. Dependency versions are pinned exactly and installed with `--ignore-scripts`.

## Consequences

- Users need Bun 1.4.4 or newer installed.
- Startup is quick and there is nothing to compile or publish.
- Dependency install scripts are not trusted to run on the user's machine.
