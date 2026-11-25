export type ClipboardWriter = (text: string) => Promise<boolean> | boolean;

export type KeyRow = [keys: string, action: string];

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "link" | "other";
}

export interface Document {
  path: string;
  text: string;
  lineCount: number;
  truncated?: boolean;
}

export interface ImageFile {
  path: string;
  bytes: Uint8Array;
}
