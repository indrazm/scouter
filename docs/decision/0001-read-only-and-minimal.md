# 0001: Read-only and minimal

## Context

There are plenty of editors and file managers. What was missing was a small viewer that is safe to point at any folder, including code you do not trust yet.

## Decision

Scouter only reads. No editing, no modes, no plugins, no configuration file, no clipboard or autosave. A new feature has to earn its place against "does this keep it small?"

## Consequences

- Nothing in the app can damage the files or repositories it shows.
- Users cannot customize it. Behavior that other tools make configurable is a fixed choice here.
- Feature requests that add editing or settings are declined by default.
