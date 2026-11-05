import { afterEach, expect, test } from "bun:test";
import { BoxRenderable, CodeRenderable } from "@opentui/core";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ScouterApp } from "../src/app";
import { brightness, palettes, setThemeMode, theme, tintedBackground, type ThemeMode } from "../src/theme";
import {
  borderColorOf,
  channels,
  createRepository,
  hasBackground,
  hasBackgroundFrom,
  rowBackgrounds,
  textColorOf,
  waitForFrame,
  waitForText,
  withDirectory,
} from "./fixtures";

// The mode is shared by the whole process, so a test that changes it must put it back for the next one.
afterEach(() => {
  setThemeMode("dark");
});

/** The terminal reports that the system went light or dark, as terminals that announce it do. */
function announce(setup: TestRendererSetup, mode: ThemeMode): void {
  setup.renderer.emit("theme_mode", mode);
}

/** Whether `text` is on screen in the plain text colour of `mode`. */
function isDrawnIn(setup: TestRendererSetup, text: string, mode: ThemeMode): boolean {
  return textColorOf(setup, text)?.join() === channels(palettes[mode].text).join();
}

function sidebarBrightness(setup: TestRendererSetup): number {
  const panel = setup.renderer.root.findDescendantById("browser-panel");
  if (!(panel instanceof BoxRenderable)) throw new Error("No sidebar.");
  const [red, green, blue] = panel.backgroundColor.toInts();
  return (red * 299 + green * 587 + blue * 114) / 255000;
}

test("when the system goes light the sidebar, text, welcome screen and focus border follow, and back to dark again", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "alpha.txt"), "a\n");
    await writeFile(join(directory, "beta.txt"), "b\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await waitForText(setup, "beta.txt");
    await waitForFrame(setup, () => sidebarBrightness(setup) < 0.5, "the dark sidebar");
    expect(textColorOf(setup, "beta.txt")).toEqual(channels(palettes.dark.text));
    expect(textColorOf(setup, "Select a file and press Enter.")).toEqual(channels(palettes.dark.accentSoft));
    expect(borderColorOf(setup.renderer.root, "browser-panel")).toBe(
      channels(palettes.dark.accent).concat(255).join(","),
    );

    announce(setup, "light");
    await waitForFrame(setup, () => isDrawnIn(setup, "beta.txt", "light"), "the file list drawn in light colours");
    expect(sidebarBrightness(setup)).toBeGreaterThan(0.5);
    expect(theme.text).toBe(palettes.light.text);
    expect(textColorOf(setup, "beta.txt")).toEqual(channels(palettes.light.text));
    expect(textColorOf(setup, "Select a file and press Enter.")).toEqual(channels(palettes.light.accentSoft));
    expect(borderColorOf(setup.renderer.root, "browser-panel")).toBe(
      channels(palettes.light.accent).concat(255).join(","),
    );
    expect(brightness(palettes.light.fallbackBackground)).toBeGreaterThan(0.5);

    announce(setup, "dark");
    await waitForFrame(setup, () => isDrawnIn(setup, "beta.txt", "dark"), "the file list drawn in dark colours again");
    expect(sidebarBrightness(setup)).toBeLessThan(0.5);
  }));

test("changing the mode keeps the open file, its scroll position and the pane that has focus", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "log.ts");
    await writeFile(
      path,
      `${Array.from({ length: 80 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n")}\n`,
    );
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    const code = setup.renderer.root.findDescendantById("document");
    if (!(code instanceof CodeRenderable)) throw new Error("No code view.");
    await code.highlightingDone;
    setup.mockInput.pressKey("G");
    await waitForText(setup, "Bot");
    await waitForText(setup, "READER");
    await waitForFrame(
      setup,
      () => textColorOf(setup, "const")?.join() === channels(palettes.dark.syntax.keyword).join(),
      "dark keywords",
    );

    announce(setup, "light");
    await waitForFrame(setup, () => theme.text === palettes.light.text, "light mode");
    await waitForFrame(
      setup,
      () => textColorOf(setup, "const")?.join() === channels(palettes.light.syntax.keyword).join(),
      "keywords in the light colour",
    );
    expect(setup.captureCharFrame()).toContain("const line80 = 80;");
    expect(setup.captureCharFrame()).toContain("Bot");
    expect(setup.captureCharFrame()).toContain("READER");
  }));

test("the changes screen is drawn in the new mode's diff colours", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "app.ts": "const one = 1;\nconst two = 2;\n" });
    await writeFile(join(directory, "app.ts"), "const one = 1;\nconst two = 22;\n");
    await using setup = await createTestRenderer({ width: 110, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "const two = 22;");
    await waitForFrame(setup, () => hasBackground(setup, palettes.dark.addedBg), "dark added lines");
    expect(hasBackground(setup, palettes.light.addedBg)).toBe(false);

    announce(setup, "light");
    await waitForFrame(setup, () => hasBackground(setup, palettes.light.addedBg), "light added lines");
    expect(hasBackground(setup, palettes.light.removedBg)).toBe(true);
    expect(hasBackground(setup, palettes.dark.addedBg)).toBe(false);
    expect(setup.captureCharFrame()).toContain("const two = 22;");
  }));

/** Switches to light and waits until the plain text of `anchor` is drawn in the light colour. */
async function goLight(
  setup: TestRendererSetup,
  anchor: string,
  colour: "text" | "dim" | "muted" = "text",
): Promise<void> {
  announce(setup, "light");
  await waitForFrame(
    setup,
    () => textColorOf(setup, anchor)?.join() === channels(palettes.light[colour]).join(),
    `${anchor} drawn in the light ${colour} colour`,
  );
}

test("the reader header, footer and scrollbar are drawn again in the new colours", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "long.txt");
    await writeFile(path, `${Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await waitForText(setup, "80 lines");
    expect(textColorOf(setup, "read-only")).toEqual(channels(palettes.dark.dim));
    expect(textColorOf(setup, "█")).toEqual(channels(palettes.dark.muted));

    await goLight(setup, "read-only", "dim");
    expect(textColorOf(setup, "80 lines")).toEqual(channels(palettes.light.muted));
    expect(textColorOf(setup, "█")).toEqual(channels(palettes.light.muted));
    const tint = tintedBackground(undefined);
    const status = rowBackgrounds(setup, 12);
    expect(status.some((background) => background.join() === channels(tint).join())).toBe(true);
  }));

test("the key list, the find prompt and the text result preview are drawn again in the new colours", () =>
  withDirectory(async (directory) => {
    await writeFile(
      join(directory, "app.ts"),
      `${Array.from({ length: 30 }, (_, index) => (index === 9 ? "const needle = 1;" : `line ${index + 1}`)).join("\n")}\n`,
    );
    await using setup = await createTestRenderer({ width: 110, height: 40 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();

    setup.mockInput.pressKey("?");
    await waitForText(setup, "collapse a folder or go back");
    expect(textColorOf(setup, "collapse a folder")).toEqual(channels(palettes.dark.text));
    await goLight(setup, "collapse a folder");
    setup.mockInput.pressKey("j");
    await waitForFrame(setup, (frame) => !frame.includes("collapse a folder"), "the key list to close");

    setup.mockInput.pressKey("/");
    await waitForText(setup, "type to find a file");
    expect(textColorOf(setup, "type to find a file")).toEqual(channels(palettes.light.dim));
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "10  const needle = 1;");
    expect(hasBackground(setup, palettes.light.targetBg)).toBe(true);
    expect(hasBackground(setup, palettes.dark.targetBg)).toBe(false);

    announce(setup, "dark");
    await waitForFrame(
      setup,
      () => hasBackground(setup, palettes.dark.targetBg),
      "the preview's target line in dark colours",
    );
    expect(textColorOf(setup, "searching")).toBeUndefined();
    expect(textColorOf(setup, "1 match")).toEqual(channels(palettes.dark.dim));
  }));

test("the bands naming each file in the diff take the new tint", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "app.ts": "const one = 1;\n" });
    await writeFile(join(directory, "app.ts"), "const one = 2;\n");
    await using setup = await createTestRenderer({ width: 110, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "const one = 2;");
    const reader = setup.renderer.root.findDescendantById("viewer-panel");
    if (!(reader instanceof BoxRenderable)) throw new Error("No reader.");

    announce(setup, "light");
    await waitForFrame(setup, () => hasBackground(setup, palettes.light.addedBg), "the diff in light colours");
    // Only the rows above the footer, which is tinted too.
    expect(hasBackgroundFrom(setup, tintedBackground(undefined), reader.x, 14)).toBe(true);
  }));
