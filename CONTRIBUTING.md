# Contributing to Scouter

Scouter is small on purpose: a read-only terminal file viewer with a git diff screen. Contributions that keep it small are welcome.

## Before you start

Read [0001-read-only-and-minimal](docs/decision/0001-read-only-and-minimal.md). No editing, modes, plugins, settings or config files; no new dependency without a strong reason; prefer deleting code to adding an option. A feature that needs one of those is usually a no.

Open an issue before a large change, so the answer does not come after you wrote it.

## Set up

Requires Bun 1.4.4+ and an interactive terminal. git is needed for the tests.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run start .
```

Layout, the commands, and how each screen behaves are in [DEVELOPMENT.md](DEVELOPMENT.md). The rules an agent or a person should follow while working in the code are in [AGENTS.md](AGENTS.md).

## Checks

CI runs this on Linux and macOS, so it must pass before a pull request is ready:

```sh
bun run check    # typecheck, lint, format:check, tests
```

A new behavior gets a test, using real temporary git repositories and OpenTUI's test renderer (`tests/fixtures.ts`). Wait for git with `waitForText` / `waitForFrame`, not fixed sleeps. Fix a bug with a test that fails first.

## In the same change

- **A decision.** If you made a real choice, add `docs/decision/NNNN-name.md` (next number, Context / Decision / Consequences, short).
- **The keys.** If a user sees or types something new, update the README's key table and `src/core/keymap.ts`, and the in-app hints behind `?`.

## Never break these

- **Read-only.** Nothing writes to a viewed file or repository, and git never runs against the real index: it gets a private copy (`GIT_INDEX_FILE`) with `--no-ext-diff --no-textconv`, `core.fsmonitor=false` and literal pathspecs (0007).
- **Untrusted folders.** Text from files and patches goes through `displayText` before it is drawn, and the launcher keeps `--config=/dev/null --no-env-file` (0008).

## Sending a pull request

- One change per branch, against `main`. Commit messages are short and imperative (`Draw ignored paths in a fainter colour`), with no prefix.
- Say what changed and why, how you tested it (paste the tail of `bun run check`), and what could still go wrong.
- Do not bump the version or push a `v*` tag; a release is made separately. Do not force-push `main`.
- Do not commit secrets, local paths, or an editor's leftover files.

Questions about a change are fine as an issue. Scouter is released under the [MIT License](LICENSE).
