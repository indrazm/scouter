# Working in this codebase

Scouter is a small, read-only terminal file viewer with a git diff screen (Bun, TypeScript, `@opentui/core`). Layout and commands are in [DEVELOPMENT.md](DEVELOPMENT.md); the reasons behind choices are in [docs/decision](docs/decision).

## Keep it minimal

- No editing, modes, plugins, settings or config files. If a feature needs one, the answer is usually no (0001).
- No new dependency without a strong reason. Versions are pinned exactly; installs use `--frozen-lockfile --ignore-scripts`.
- Prefer deleting code to adding options.

## Never break these

- **Read-only.** Nothing writes to a viewed file or repository. Git runs on a private copy of the index with `--no-ext-diff --no-textconv`, `core.fsmonitor=false` and literal pathspecs (0007). Do not run git against the real index.
- **Untrusted folders.** Text from files and patches goes through `displayText` before it is drawn. The installed launcher keeps `--config=/dev/null --no-env-file` (0008).
- **Installer safety.** `install.sh` only touches what carries its markers (`.scouter-installer`, `# scouter-launcher`). It never edits shell configuration. Keep `main "$@"; exit $?` on one line.
- **No focus change on click** in the file or change list. It makes both panes flash (0003). Dimming depends on whether there is something to read, not on which file is highlighted.

## Before you finish

- Run `bun run check` (tsrs, oxlint, oxfmt, tests). It must be clean.
- A lint rule is disabled only on the line, with a reason.
- New behavior gets a test, using real temporary git repos and `createTestRenderer` (see `tests/fixtures.ts`). Wait for async git with `waitForText` / `waitForFrame`, not fixed sleeps.
- Fix a bug with a test that fails first.
- Make a real choice? Add `docs/decision/NNNN-name.md` (next number, Context / Decision / Consequences, short) in the same change.
- If you change what a user sees or types, update the README keys table and the in-app hints.

## Machine and git etiquette

- **No stress or load tests, no busy loops, no running tests many times in a row** to chase flakes. Reason about the race, or write a deterministic test. Kill any process you start and leave running.
- Commit and push only when asked. Do not touch the `v0.1.0` tag; a release is a new `v*` tag, made on request.
- Do not install, upgrade or uninstall Scouter on the developer's machine unless asked. Tests use temporary `SCOUTER_HOME` / `SCOUTER_BIN_DIR`.
- Keep the README short and about the product. Development detail goes in `DEVELOPMENT.md`.
