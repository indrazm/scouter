import { realpath } from "node:fs/promises";
import { posix, relative } from "node:path";
import { statusLetters } from "./changes";
import { closeRepository, listChanges, listIgnored, openRepository, type Change, type Repository } from "./git";
import type { RowStyle } from "./explorer";
import { theme } from "./theme";

/**
 * What git says about the files under the folder being browsed, keyed by path relative to that folder: the changed
 * files, the folders that hold changes, and the paths git ignores.
 */
export class GitMarks {
  private readonly changes = new Map<string, Change>();
  private readonly folders = new Set<string>();
  private readonly ignored = new Set<string>();
  private signature = "";
  /** The git repository the marks come from: the browsed folder's, or none. */
  private source?: { root: string; repository?: Repository };

  /** Asks git what changed under `root` and what it ignores. True when that differs from last time. */
  async refresh(root: string): Promise<boolean> {
    const repository = await this.repositoryFor(root);
    if (!repository) return this.update("", [], []);
    // Git names the repository by its real path, which can differ from the one the tree was opened with (macOS /var).
    const [{ changes }, ignored, real] = await Promise.all([
      listChanges(repository),
      listIgnored(repository),
      realpath(root),
    ]);
    return this.update(relative(repository.root, real), changes, ignored);
  }

  /** Removes the private index copy of the repository, if one is open. */
  async close(): Promise<void> {
    const repository = this.source?.repository;
    this.source = undefined;
    if (repository) await closeRepository(repository);
  }

  /** The repository holding `root`, opened again only when the folder changes. Undefined outside git. */
  private async repositoryFor(root: string): Promise<Repository | undefined> {
    if (this.source?.root !== root) {
      const previous = this.source?.repository;
      const repository = await openRepository(root).catch(() => undefined);
      if (previous) await closeRepository(previous);
      this.source = { root, repository };
    }
    return this.source.repository;
  }

  /**
   * Replaces the marks with what git reported for a repository. `within` is where the browsed folder sits inside that
   * repository ("" for its top). Returns false, changing nothing, when git reported the same as last time.
   */
  private update(within: string, changes: Change[], ignored: string[]): boolean {
    const next = [
      within,
      changes.map((change) => [change.path, change.kind, change.staged, change.unstaged].join("\0")).join("\n"),
      ignored.join("\n"),
    ].join("\u0001");
    if (next === this.signature) return false;
    this.signature = next;
    this.changes.clear();
    this.folders.clear();
    this.ignored.clear();
    for (const change of changes) {
      const path = relativeWithin(within, change.path);
      if (path === undefined) continue;
      this.changes.set(path, change);
      for (let folder = posix.dirname(path); folder !== "."; folder = posix.dirname(folder)) this.folders.add(folder);
    }
    for (const path of ignored) {
      const inside = relativeWithin(within, path.replace(/\/$/, ""));
      if (inside !== undefined) this.ignored.add(inside);
    }
    return true;
  }

  /** The letter and colour for a changed file, or a dot for a folder that holds some. `path` is relative to the browsed folder. */
  styleOf(path: string): RowStyle {
    const change = this.changes.get(path);
    if (change) return { letter: statusLetters[change.kind].letter, color: statusLetters[change.kind].color };
    if (this.folders.has(path)) return { letter: "•", color: theme.modified };
    return {};
  }

  /** Whether git ignores the path, or any folder it sits in. `path` is relative to the browsed folder. */
  isIgnored(path: string): boolean {
    if (this.ignored.has(path)) return true;
    for (let folder = posix.dirname(path); folder !== "."; folder = posix.dirname(folder)) {
      if (this.ignored.has(folder)) return true;
    }
    return false;
  }
}

/** `path` relative to the folder `within`, or undefined when it lies outside that folder. */
function relativeWithin(within: string, path: string): string | undefined {
  if (!within) return path;
  return path.startsWith(`${within}/`) ? path.slice(within.length + 1) : undefined;
}

/** `path` relative to the browsed folder, forward-slashed to match the marks' keys on every platform. */
export function treeRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}
