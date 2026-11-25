import type { ThemeMode } from "@opentui/core";

export type { ThemeMode };

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export interface SystemTheme {
  mode: ThemeMode;
  background?: string;
}

export interface ThemeSource {
  readonly themeMode: ThemeMode | null;
  on(event: "theme_mode", listener: (mode: ThemeMode) => void): unknown;
  off(event: "theme_mode", listener: (mode: ThemeMode) => void): unknown;
  clearPaletteCache(): void;
  getPalette(options: { size: number; timeout: number }): Promise<{ defaultBackground: string | null }>;
}

export interface HeaderBadge {
  text: string;
  kind: "pill" | "quiet";
}

export type FooterMode = "browse" | "diff";
export type FooterFocus = "files" | "reader";
export type DiffScope = "all" | "one";
export type FooterPrompt = "files" | "text" | "reader";
export type Hint = [key: string, action: string];

export interface DocumentInfo {
  lines: number;
  language: string;
  rendered?: boolean;
  image?: { width: number; height: number; format: string };
  binary?: { size: string };
  truncated?: boolean;
}

export interface DiffInfo {
  location: string;
  files: number;
  scope: DiffScope;
  truncated?: boolean;
  added?: number;
  removed?: number;
  hunks?: number;
  hunkIndex?: number;
}
