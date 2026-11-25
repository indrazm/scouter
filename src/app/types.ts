import type { ClipboardWriter, Document } from "../core/types";

export interface ScouterAppOptions {
  diffPollMs?: number;
  browsePollMs?: number;
  imageProtocol?: "auto" | "kitty" | "sixel" | "blocks";
  copy?: ClipboardWriter;
}

export type Shown =
  | { kind: "none" }
  | { kind: "image"; title: string; path: string }
  | { kind: "binary"; title: string; path: string; size: number }
  | {
      kind: "text";
      document: Document;
      title: string;
      stamp?: string;
    };

export interface ReaderPaneOptions {
  imageProtocol?: "auto" | "kitty" | "sixel" | "blocks";
  onPositionChange: () => void;
}

export interface HeaderTitle {
  title: string;
  parent?: string;
}
