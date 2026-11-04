# 0014: Vendor more tree-sitter grammars

## Context

OpenTUI bundles grammars for JavaScript, TypeScript, Markdown and Zig only, so JSON, CSS, Go, Rust and the other common languages opened as plain text.

## Decision

Eleven more grammars are committed in `grammars/`: JSON, CSS, HTML, Go, Rust, Python, Bash, YAML, TOML, C and Java. Each is the `.wasm` build and `queries/highlights.scm` from the grammar's own npm package, with its MIT license beside it. `grammars/manifest.json` records the package, version and SHA-256 of every file, and a test checks the files against it.

They are registered with the same tree-sitter client as the built-in ones, and each loads only when a file in that language is opened. File types come from OpenTUI's own extension detection. Nothing is configurable (0001).

A grammar is added by dropping its two files into `grammars/<filetype>/`, adding it to the manifest and adding a sample to `tests/languages.test.ts`.

## Consequences

- About 4.5 MB more in the install, on top of the 4.7 MB OpenTUI already carries.
- Grammars are updated by hand: a new version means replacing the files and the hashes.
- The `.wasm` files are third-party binaries. They run inside web-tree-sitter's sandbox, were taken from pinned package versions, and are protected by the hashes, but they are not built from source here.
- C++ (3.3 MB) and Ruby (2.1 MB) were left out for size. Other languages still open as plain text.
