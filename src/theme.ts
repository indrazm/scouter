import { RGBA, type ThemeMode } from "@opentui/core";

export type { ThemeMode };

/** Colours of one mode. Every colour the interface draws comes from here, so a mode is complete or it does not build. */
interface Palette {
  text: string;
  muted: string;
  dim: string;
  /** Files and folders git ignores: fainter than `dim`, so they recede behind everything tracked. */
  ignored: string;
  accent: string;
  accentSoft: string;
  /** Text on top of a solid accent background. */
  accentInk: string;
  error: string;
  hover: string;
  /** Meaning of a change, shared by the change list, the diff and the footer. */
  added: string;
  removed: string;
  modified: string;
  /** Added and removed lines in a diff, and the gutters beside their line numbers. */
  addedBg: string;
  removedBg: string;
  addedGutter: string;
  removedGutter: string;
  /** The chip drawn over the words a search found. */
  matchFg: string;
  matchBg: string;
  /** The line a search result points at, in the preview. */
  targetBg: string;
  targetGutter: string;
  wordmark: [string, string, string];
  /** Behind the sidebar and footer until the terminal's own background is known. */
  fallbackBackground: string;
  syntax: {
    keyword: string;
    string: string;
    comment: string;
    /** Numbers, booleans, types and other named things. */
    constant: string;
    /** Functions, properties, headings and links. */
    function: string;
    punctuation: string;
  };
}

const dark: Palette = {
  text: "#d4d8de",
  muted: "#8b929c",
  dim: "#666d78",
  ignored: "#4a505a",
  accent: "#818cf8",
  accentSoft: "#c7d2fe",
  accentInk: "#0f1117",
  error: "#f2a1a1",
  hover: "#343a42",
  added: "#8fd3a8",
  removed: "#f2a1a1",
  modified: "#e5b880",
  addedBg: "#12281c",
  removedBg: "#2b1518",
  addedGutter: "#173a27",
  removedGutter: "#3b1b20",
  matchFg: "#0f1117",
  matchBg: "#e5b880",
  targetBg: "#262b46",
  targetGutter: "#343b66",
  wordmark: ["#a5b4fc", "#818cf8", "#6366f1"],
  fallbackBackground: "#131519",
  syntax: {
    keyword: "#c792ea",
    string: "#a7c7a1",
    comment: "#8b929c",
    constant: "#e5b880",
    function: "#82aaff",
    punctuation: "#b2b9c3",
  },
};

const light: Palette = {
  text: "#1f2328",
  muted: "#59636e",
  dim: "#7d8590",
  ignored: "#b1b8c0",
  accent: "#4f46e5",
  accentSoft: "#4338ca",
  accentInk: "#ffffff",
  error: "#cf222e",
  hover: "#d0d7de",
  added: "#1a7f37",
  removed: "#cf222e",
  modified: "#9a6700",
  addedBg: "#dafbe1",
  removedBg: "#ffebe9",
  addedGutter: "#aceebb",
  removedGutter: "#ffcecb",
  matchFg: "#1f2328",
  matchBg: "#ffdf5d",
  targetBg: "#e0e7ff",
  targetGutter: "#c7d2fe",
  wordmark: ["#6366f1", "#4f46e5", "#3730a3"],
  fallbackBackground: "#f6f8fa",
  syntax: {
    keyword: "#8250df",
    string: "#116329",
    comment: "#646e78",
    constant: "#953800",
    function: "#0550ae",
    punctuation: "#57606a",
  },
};

export const palettes: Record<ThemeMode, Palette> = { dark, light };

let mode: ThemeMode = "dark";

/** The colours of the mode in use. Read when drawing, never kept, so a change of mode reaches everything. */
export const theme: Palette = new Proxy(dark, {
  get: (_target, key: keyof Palette) => palettes[mode][key],
});

export function themeMode(): ThemeMode {
  return mode;
}

/** Switches the colours `theme` gives out. Returns whether the mode changed. */
export function setThemeMode(next: ThemeMode): boolean {
  if (next === mode) return false;
  mode = next;
  return true;
}

/** How bright a colour looks, from 0 (black) to 1 (white). */
export function brightness(hex: string): number {
  const { r, g, b } = RGBA.fromHex(hex);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

export function modeOfBackground(hex: string): ThemeMode {
  return brightness(hex) < 0.5 ? "dark" : "light";
}

const TINT = 0.025;

/** The terminal's background nudged toward white (dark) or black (light), so the sidebar reads as its own surface. */
export function tintedBackground(background: string | undefined): string {
  if (!background) return theme.fallbackBackground;
  const base = RGBA.fromHex(background);
  const target = modeOfBackground(background) === "dark" ? 1 : 0;
  const mix = (channel: number): number => Math.round((channel + (target - channel) * TINT) * 255);
  return `#${[mix(base.r), mix(base.g), mix(base.b)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export const transparent = RGBA.fromValues(0, 0, 0, 0);
