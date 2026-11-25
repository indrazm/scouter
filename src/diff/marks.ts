import { realpath } from "node:fs/promises";
import { posix, relative } from "node:path";
import { statusOf } from "./changes";
import { closeRepository, listMarks, openRepository, type Change, type Repository } from "./git";
import type { RowStyle } from "../explorer/explorer";
import { theme } from "../ui/theme";

export class GitMarks {
  private readonly changes = new Map<string, Pick<Change, "path" | "kind">>();
  private readonly folders = new Set<string>();
  private readonly ignored = new Set<string>();
  private signature = "";
  private source?: { root: string; real: string; repository?: Repository };

  async refresh(root: string): Promise<boolean> {
    const source = await this.sourceFor(root);

    if (!source.repository) return this.update("", [], []);

    const { changes, ignored } = await listMarks(source.repository);
    return this.update(relative(source.repository.root, source.real), changes, ignored);
  }

  async close(): Promise<void> {
    const repository = this.source?.repository;
    this.source = undefined;

    if (repository) await closeRepository(repository);
  }

  private async sourceFor(root: string): Promise<{ root: string; real: string; repository?: Repository }> {
    if (this.source?.root !== root) {
      const previous = this.source?.repository;
      const [repository, real] = await Promise.all([
        openRepository(root).catch(() => undefined),
        realpath(root).catch(() => root),
      ]);

      if (previous) await closeRepository(previous);

      this.source = { root, real, repository };
    }

    return this.source;
  }

  private update(within: string, changes: Pick<Change, "path" | "kind">[], ignored: string[]): boolean {
    const next = [
      within,
      changes.map((change) => `${change.path}\0${change.kind}`).join("\n"),
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

  styleOf(path: string): RowStyle {
    const change = this.changes.get(path);

    if (change) return statusOf(change.kind);

    if (this.folders.has(path)) return { letter: "•", color: theme.modified };

    return {};
  }

  isIgnored(path: string): boolean {
    if (!this.ignored.size) return false;

    if (this.ignored.has(path)) return true;

    for (let folder = posix.dirname(path); folder !== "."; folder = posix.dirname(folder)) {
      if (this.ignored.has(folder)) return true;
    }
    return false;
  }
}

function relativeWithin(within: string, path: string): string | undefined {
  if (!within) return path;

  return path.startsWith(`${within}/`) ? path.slice(within.length + 1) : undefined;
}

export function treeRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}
