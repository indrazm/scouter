import type { DirectoryEntry } from "../core/types";

export interface IndexedEntry {
  path: string;
  relative: string;
  kind: DirectoryEntry["kind"];
  relativeLower?: string;
  nameLower?: string;
}

export interface TextHit {
  path: string;
  relative: string;
  line: number;
  text: string;
  at: number;
  length: number;
}

export interface TextProgress {
  hits: TextHit[];
  files: number;
  scanned: number;
  total: number;
  truncated: boolean;
  done: boolean;
}
