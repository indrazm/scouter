import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { readDirectory, type DirectoryEntry } from "./files";

export interface TreeEntry extends DirectoryEntry {
  depth: number;
  parentPath?: string;
  state: "collapsed" | "expanded";
  children?: TreeEntry[];
}

export class FileTree {
  private root?: TreeEntry;
  private nodes = new Map<string, TreeEntry>();

  has(path: string): boolean {
    return this.nodes.has(path);
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

  private async rejectLinkLoop(entry: TreeEntry): Promise<void> {
    const target = await realpath(entry.path);
    let parent = entry.parentPath;
    while (parent) {
      if ((await realpath(parent)) === target) throw new Error("Cannot expand a symbolic-link loop.");
      parent = this.nodes.get(parent)?.parentPath;
    }
  }
}
