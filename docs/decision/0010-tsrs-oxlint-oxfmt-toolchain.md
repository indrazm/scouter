# 0010: tsrs, oxlint and oxfmt for checks

## Context

The checks should be fast and need few dependencies.

## Decision

- `tsrs` (a Rust port of the TypeScript 7 compiler) replaces `tsc` for type checking.
- `oxlint` lints with the correctness, suspicious and perf categories as errors. A rule is switched off only at the line, with a stated reason.
- `oxfmt` formats, with a print width of 120.
- `bun run check` runs all of them and then `bun test`.

## Consequences

- `typescript` is not a dependency.
- tsrs is a beta, so it may lag behind `tsc` on edge cases.
- Tests use real temporary git repositories and OpenTUI's test renderer, not mocks.
