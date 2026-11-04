# 0011: CI runs the checks; a pushed tag is the release

## Context

The checks (`bun run check`) only ran on the developer's machine. The installer already treats a `v*` git tag as a release (0009), so there is nothing to build or publish to a registry.

## Decision

- `ci.yml` runs `bun run check` on every push to `main` and every pull request, on Linux and macOS (git behaves differently on each, and Scouter is built around git's index handling).
- `release.yml` runs on a pushed `v*` tag: it calls the same CI workflow, confirms the tag equals the version in `package.json`, then creates the GitHub release with generated notes.
- Bun is pinned to the version in `package.json`, and each action is pinned to a commit SHA, in line with 0002.
- Workflows have read-only permissions. Only the release job can write contents.

## Consequences

- To release: bump `version` in `package.json`, commit, tag `vX.Y.Z`, push both.
- A tag that does not match `package.json` fails and publishes nothing.
- The Bun version appears in `package.json` and in `ci.yml`, and has to be changed in both.
- Nothing is deployed: users get a release by running `scouter --upgrade`.
