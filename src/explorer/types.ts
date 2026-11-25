import type { DirectoryEntry } from "../core/types";

export interface TreeMatch {
  line: number;
  text: string;
  at: number;
  length: number;
}

export interface TreeEntry extends DirectoryEntry {
  match?: TreeMatch;
  depth: number;
  parentPath?: string;
  state: "collapsed" | "expanded";
  children?: TreeEntry[];
}

export interface RowStyle {
  letter?: string;
  color?: string;
  ignored?: boolean;
}

export interface RefreshOptions {
  marksOnly?: boolean;
}
