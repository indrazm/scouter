import type { DiffScope } from "../ui/types";

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "typechange" | "conflict" | "untracked";

export interface Change {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  added?: number;
  removed?: number;
  binary: boolean;
  staged?: boolean;
  unstaged?: boolean;
}

export interface IndexStamp {
  sourceIno: bigint;
  sourceSize: bigint;
  sourceMtimeNs: bigint;
  sourceCtimeNs: bigint;
  copyIno: bigint;
  copySize: bigint;
  copyMtimeNs: bigint;
}

export interface Repository {
  root: string;
  base: string;
  headOid: string;
  indexFile: string;
  gitIndex: string;
  indexStamp?: IndexStamp;
  queue: Promise<unknown>;
}

export interface MarksSnapshot {
  changes: Pick<Change, "path" | "kind">[];
  ignored: string[];
}

export interface ChangeSet {
  changes: Change[];
  truncated: boolean;
}

export interface GitOutput {
  text: string;
  truncated: boolean;
}

export interface RunOptions {
  limit?: number;
  indexFile?: string;
  partial?: boolean;
}

export type Patch =
  | { kind: "text"; text: string; hunks: number; added: number; removed: number }
  | { kind: "notice"; message: string };

export interface FilePatch {
  change: Change;
  patch: Patch;
}

export type DiffView = "unified" | "split";
export type HunkJumpResult = "moved" | "first" | "last" | "none";

export interface DiffState {
  repository: string;
  files: number;
  truncated: boolean;
  selected?: Change;
  patch?: { added: number; removed: number; hunks: number; hunkIndex?: number };
  view: DiffView;
  scope: DiffScope;
  expandedContext: boolean;
  showingDiff: boolean;
}
