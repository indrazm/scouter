import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { readDirectory, type DirectoryEntry } from "./files";
import type { TextHit } from "./search";

export interface TreeEntry extends DirectoryEntry {
  /** Set on a row that stands for one matching line of a file, in the list of text search results. */
  match?: Pick<TextHit, "line" | "text" | "at" | "length">;
  depth: number;
  parentPath?: string;
  state: "collapsed" | "expanded";
  children?: TreeEntry[];
}

/** Identity of a folder's listing, so a refresh can tell whether anything was added, removed or retyped. */
function listing(children: TreeEntry[]): string {
  return children.map((child) => `${child.path}\0${child.kind}`).join("\n");
}

export class FileTree {
  private root?: TreeEntry;
  private nodes = new Map<string, TreeEntry>();

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  get rootPath(): string | undefined {
    return this.root?.path;
  }

  /** Every folder that is expanded, including ones hidden inside a collapsed parent. */
  expandedPaths(): string[] {
    return [...this.nodes.values()].filter((entry) => entry.state === "expanded").map((entry) => entry.path);
  }

  /**
   * Re-reads an expanded folder so files created, removed or retyped on disk show up, keeping the state of the
   * entries that remain. Returns whether the folder's listing changed.
   */
  async refresh(path: string): Promise<boolean> {
    const entry = this.nodes.get(path);
    if (!entry?.children || entry.state !== "expanded") return false;
    let entries: DirectoryEntry[];
    try {
      entries = await readDirectory(path);
    } catch {
      // The folder may have just disappeared; its parent's refresh removes it.
      return false;
    }
    // The folder may have been collapsed or removed while it was being read.
    if (this.nodes.get(path) !== entry || entry.state !== "expanded" || !entry.children) return false;
    const before = listing(entry.children);
    const previous = new Map(entry.children.map((child) => [child.path, child]));
    const kept = new Set<TreeEntry>();
    const children: TreeEntry[] = [];
    for (const fresh of entries) {
      const existing = previous.get(fresh.path);
      if (existing?.kind === fresh.kind) {
        kept.add(existing);
        children.push(existing);
        continue;
      }
      if (existing) this.forget(existing);
      const child: TreeEntry = { ...fresh, depth: entry.depth + 1, parentPath: path, state: "collapsed" };
      this.nodes.set(child.path, child);
      children.push(child);
    }
    entry.children = children;
    for (const child of previous.values()) if (!kept.has(child)) this.forget(child);
    return listing(entry.children) !== before;
  }

  /** Expands every folder between the tree's root and `path`, so `path` is listed. False when it is outside the tree. */
  async expandTo(path: string): Promise<boolean> {
    if (!this.root) return false;
    const rest = relative(this.root.path, path);
    if (!rest || rest.startsWith("..") || isAbsolute(rest)) return false;
    let folder = this.root.path;
    for (const part of rest.split(sep).slice(0, -1)) {
      // Each folder is listed by expanding its parent, so the next one exists by the time it is reached.
      // oxlint-disable-next-line no-await-in-loop
      await this.expand(folder);
      folder = join(folder, part);
    }
    return true;
  }

  async load(path: string): Promise<void> {
    const entries = await readDirectory(path);
    const root: TreeEntry = { name: basename(path) || path, path, kind: "directory", depth: 0, state: "expanded" };
    this.nodes = new Map([[path, root]]);
    root.children = this.addChildren(root, entries);
    this.root = root;
  }

  async expand(path: string): Promise<void> {
    const entry = this.nodes.get(path);
    if (!entry || entry.state === "expanded") return;
    if (entry.kind === "link") await this.rejectLinkLoop(entry);
    if (!entry.children) entry.children = this.addChildren(entry, await readDirectory(path));
    entry.state = "expanded";
  }

  collapse(path: string): void {
    const entry = this.nodes.get(path);
    if (entry) entry.state = "collapsed";
  }

  reveal(path: string): void {
    let entry = this.nodes.get(path);
    while (entry?.parentPath) {
      entry = this.nodes.get(entry.parentPath);
      if (entry) entry.state = "expanded";
    }
  }

  rows(): TreeEntry[] {
    const rows: TreeEntry[] = [];
    const visit = (entry: TreeEntry): void => {
      rows.push(entry);
      if (entry.state === "expanded") entry.children?.forEach(visit);
    };
    if (this.root) visit(this.root);
    return rows;
  }

  private addChildren(parent: TreeEntry, entries: DirectoryEntry[]): TreeEntry[] {
    return entries.map((entry) => {
      const child: TreeEntry = { ...entry, depth: parent.depth + 1, parentPath: parent.path, state: "collapsed" };
      this.nodes.set(child.path, child);
      return child;
    });
  }

  /** Drops an entry and everything under it from the lookup table. */
  private forget(entry: TreeEntry): void {
    this.nodes.delete(entry.path);
    entry.children?.forEach((child) => this.forget(child));
  }

  private async rejectLinkLoop(entry: TreeEntry): Promise<void> {
    const target = await realpath(entry.path);
    const parents: string[] = [];
    for (let parent = entry.parentPath; parent; parent = this.nodes.get(parent)?.parentPath) parents.push(parent);
    const resolved = await Promise.all(parents.map((parent) => realpath(parent)));
    if (resolved.includes(target)) throw new Error("Cannot expand a symbolic-link loop.");
  }
}
