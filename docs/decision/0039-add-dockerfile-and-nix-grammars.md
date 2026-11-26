# 0039: Add Dockerfile and Nix grammars

## Context

Dockerfiles and `.nix` files opened as plain text. OpenTUI detects only the exact names `Dockerfile` and `Containerfile`, and knows no Nix. Neither grammar has an official prebuilt `.wasm` on npm: `tree-sitter-dockerfile` is a placeholder and `tree-sitter-nix` ships source and queries only.

## Decision

Two more grammars are vendored beside the others (0014):

- **Dockerfile** from `tree-sitter-dockerfile-orchard` 0.1.0, the only npm package with a built `.wasm`. It is a fork of Camden Cheek's grammar, and its `LICENSE` file is MIT. The wasm is renamed to `tree-sitter-dockerfile.wasm`.
- **Nix** built from the `tree-sitter-nix` 0.0.2 sources (MIT) with `tree-sitter-cli` 0.25.10 `build --wasm` in `emscripten/emsdk` 4.0.4, matching the `web-tree-sitter` version. The manifest records this in a `build` field. That package has no `tree-sitter.json`, so one was written for the build only.

`languageFor` maps `.nix`, `.dockerfile` and `Dockerfile.*` on top of OpenTUI's detection. Nothing is configurable (0001).

## Consequences

- About 0.4 MB more in the install.
- The Nix wasm is not an npm artifact: updating it means rebuilding it, and the hash only proves the file is unchanged, not that someone else gets the same bytes.
- The Dockerfile wasm comes from a small third-party fork, protected only by its hash.
