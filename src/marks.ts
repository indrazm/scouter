import { posix } from "node:path";
import { statusLetters } from "./changes";
import type { Change } from "./git";
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

  /**
   * Replaces the marks with what git reported for a repository. `within` is where the browsed folder sits inside that
   * repository ("" for its top). Returns false, changing nothing, when git reported the same as last time.
   */
  update(within: string, changes: Change[], ignored: string[]): boolean {
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
      const relative = relativeWithin(within, path.replace(/\/$/, ""));
      if (relative !== undefined) this.ignored.add(relative);
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
