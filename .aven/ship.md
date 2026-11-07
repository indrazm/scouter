Ship this thread's work.

1. Commit what belongs to the work. Messages are short, imperative, no prefix (e.g. "Draw ignored paths in a fainter colour"). Never commit .env files or the `.aven/proof/` of another change. Do not touch the `v0.1.0` tag, and do not create release tags or bump the version unless I asked.
2. Rebase onto the default branch: `git fetch origin main && git rebase origin/main`. If conflicts are not trivial, stop and tell me.
3. Check the work as AGENTS.md says: `bun run check` (typecheck, oxlint, oxfmt, tests) must be clean. If you made a real design choice, add `docs/decision/NNNN-name.md`; if users see or type something new, update the README keys table and in-app hints. Fix what you broke; if something fails that you cannot fix, stop and tell me. Never ship with failing checks.
4. If the change alters what a screen looks like, take a screenshot of the changed screen (the app is a terminal UI: run it in the desktop terminal, or render a frame with the test renderer), save it as PNG in `.aven/proof/<short-topic>/`, and commit it. Skip this for changes with no visible effect.
5. Push with `git push -u origin HEAD`. Never force-push main.
6. Open a ready-for-review pull request against main: `gh pr create --base main`. The repo has no template; the description has these sections: Summary (what and why), How it was tested (paste the tail of the `bun run check` output; link screenshots in `.aven/proof/` by their path on the branch), Risks. Do not include secrets or local paths. If a PR already exists for the branch, the push updates it.
7. Do not merge and do not enable auto-merge. Tell me the pull request's URL and note that `.aven/proof/` should be removed before merging.
