import { afterEach, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import {
  brightness,
  modeOfBackground,
  palettes,
  setThemeMode,
  theme,
  themeMode,
  tintedBackground,
  type ThemeMode,
} from "../src/theme";

/** How much light a colour gives off, from 0 to 1, as WCAG defines it. */
function luminance(hex: string): number {
  const { r, g, b } = RGBA.fromHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function linear(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio between two colours: 1 (the same) to 21 (black on white). */
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].toSorted((left, right) => right - left);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

afterEach(() => {
  setThemeMode("dark");
});

const modes: ThemeMode[] = ["dark", "light"];

test("both palettes define every colour, so neither mode can be left half done", () => {
  expect(Object.keys(palettes.light).toSorted()).toEqual(Object.keys(palettes.dark).toSorted());
  expect(Object.keys(palettes.light.syntax).toSorted()).toEqual(Object.keys(palettes.dark.syntax).toSorted());
});

test.each(modes)("in %s mode text can be read on the sidebar and on the added and removed lines", (mode) => {
  const palette = palettes[mode];
  const background = palette.fallbackBackground;
  for (const name of ["text", "muted", "accent", "accentSoft", "added", "removed", "modified", "error"] as const) {
    expect(contrast(palette[name], background)).toBeGreaterThanOrEqual(4.5);
  }
  for (const name of ["keyword", "string", "comment", "constant", "function", "punctuation"] as const) {
    expect(contrast(palette.syntax[name], background)).toBeGreaterThanOrEqual(4.5);
  }
  // Dim text (paths, hints) is meant to recede, but must stay visible.
  expect(contrast(palette.dim, background)).toBeGreaterThanOrEqual(3);
  // Ignored paths recede further than dim text, but must not vanish.
  expect(contrast(palette.ignored, background)).toBeGreaterThanOrEqual(1.8);
  expect(contrast(palette.ignored, background)).toBeLessThan(contrast(palette.dim, background));
  for (const tint of [palette.addedBg, palette.removedBg, palette.targetBg]) {
    expect(contrast(palette.text, tint)).toBeGreaterThanOrEqual(7);
  }
  expect(contrast(palette.accentInk, palette.accent)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(palette.matchFg, palette.matchBg)).toBeGreaterThanOrEqual(7);
});

test("theme gives out the colours of the mode in use, and says when the mode changed", () => {
  expect(themeMode()).toBe("dark");
  expect(theme.text).toBe(palettes.dark.text);
  expect(setThemeMode("light")).toBe(true);
  expect(theme.text).toBe(palettes.light.text);
  expect(setThemeMode("light")).toBe(false);
});

test("a background is called light or dark by how bright it looks", () => {
  expect(modeOfBackground("#000000")).toBe("dark");
  expect(modeOfBackground("#1e1e2e")).toBe("dark");
  expect(modeOfBackground("#ffffff")).toBe("light");
  expect(modeOfBackground("#eff1f5")).toBe("light");
});

test("the sidebar tint is a slight nudge from the terminal background, toward white on dark and toward black on light", () => {
  const dark = tintedBackground("#101010");
  expect(dark).not.toBe("#101010");
  expect(brightness(dark)).toBeGreaterThan(brightness("#101010"));
  expect(brightness(dark)).toBeLessThan(brightness("#101010") + 0.05);
  const light = tintedBackground("#ffffff");
  expect(brightness(light)).toBeLessThan(brightness("#ffffff"));
  expect(brightness(light)).toBeGreaterThan(brightness("#ffffff") - 0.05);
});

test("until the terminal's background is known the tint is the palette's fallback for the mode in use", () => {
  expect(tintedBackground(undefined)).toBe(palettes.dark.fallbackBackground);
  setThemeMode("light");
  expect(tintedBackground(undefined)).toBe(palettes.light.fallbackBackground);
});
