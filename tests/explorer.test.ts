import { expect, test } from "bun:test";
import { BoxRenderable, CodeRenderable, RGBA, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, MouseButtons, type TestRendererSetup } from "@opentui/core/testing";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app";
import { backgroundIntentsFrom, withDirectory } from "./fixtures";

function explorerCell(setup: TestRendererSetup, name: string): [number, number] {
  const explorer = setup.renderer.root.findDescendantById("browser");
  if (!(explorer instanceof ScrollBoxRenderable)) throw new Error("No explorer mounted.");
  const lines = setup.captureCharFrame().split("\n");
  const row = lines.findIndex((line, index) => index >= explorer.y && index < explorer.y + explorer.height
    && line.slice(explorer.x, explorer.x + explorer.width).includes(name));
  if (row < 0) throw new Error(`No visible explorer row for ${name}.`);
  return [explorer.x + 7, row];
}

test("clicks open files and toggle folders while ignoring right clicks and empty space", () => withDirectory(async (directory) => {
  await mkdir(join(directory, "folder"));
  await writeFile(join(directory, "folder", "inside.txt"), "mouse-opened content");
  await writeFile(join(directory, "sibling.txt"), "sibling");
  await using setup = await createTestRenderer({ width: 120, height: 18 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  await setup.mockMouse.click(...explorerCell(setup, "folder/"));
  await setup.waitForFrame((frame) => frame.includes("\uf016 inside.txt"));
  expect(setup.captureCharFrame()).toContain("sibling.txt");
  await setup.mockMouse.click(...explorerCell(setup, "inside.txt"));
  await setup.waitForFrame((frame) => frame.includes("1  mouse-opened content"));
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");
  await setup.mockMouse.click(...explorerCell(setup, "folder/"), MouseButtons.RIGHT);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("\uf016 inside.txt");
  await setup.mockMouse.click(...explorerCell(setup, "folder/"));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("▸ \uf07b folder/");
  expect(setup.captureCharFrame()).not.toContain("\uf016 inside.txt");
  expect(setup.captureCharFrame()).toContain("1  mouse-opened content");
  const explorer = setup.renderer.root.findDescendantById("browser");
  if (!(explorer instanceof ScrollBoxRenderable)) throw new Error("No explorer mounted.");
  await setup.mockMouse.click(explorer.x + 7, explorer.y + explorer.height - 2);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("▸ \uf07b folder/");
}));

test("wheel scrolling and clicks use visible row bounds after keyboard scrolling and resizing", () => withDirectory(async (directory) => {
  await Promise.all(Array.from({ length: 60 }, (_, index) =>
    writeFile(join(directory, `file${String(index).padStart(2, "0")}.txt`), `opened file ${index}`)));
  await using setup = await createTestRenderer({ width: 120, height: 16 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  const explorer = setup.renderer.root.findDescendantById("browser");
  if (!(explorer instanceof ScrollBoxRenderable)) throw new Error("No explorer mounted.");
  await setup.mockMouse.scroll(explorer.x + 7, explorer.y + 3, "down");
  await setup.renderOnce();
  expect(explorer.scrollTop).toBeGreaterThan(0);
  setup.mockInput.pressKey("G");
  await setup.renderOnce();
  setup.resize(100, 14);
  await setup.renderOnce();
  await setup.mockMouse.click(...explorerCell(setup, "file57.txt"));
  await setup.waitForFrame((frame) => frame.includes("1  opened file 57"));
  expect(setup.captureCharFrame()).not.toContain("1  opened file 59");
}));

test("uses Nerd Font icons, a wider responsive sidebar, and a tinted sidebar over the terminal-default background", () => withDirectory(async (directory) => {
  await mkdir(join(directory, "folder"));
  await writeFile(join(directory, "source.ts"), 'const greeting = "hello";\n');
  await writeFile(join(directory, "settings.json"), "{}");
  await using setup = await createTestRenderer({
    width: 120, height: 16, backgroundColor: RGBA.defaultBackground("#456789"),
  });
  await using app = new ScouterApp(setup.renderer);
  await app.open(join(directory, "source.ts"));
  await setup.renderOnce();
  const code = setup.renderer.root.findDescendantById("document");
  if (!(code instanceof CodeRenderable)) throw new Error("No code view mounted.");
  await code.highlightingDone;
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("\uf07b folder/");
  expect(setup.captureCharFrame()).toContain("\ue628 source.ts");
  expect(setup.captureCharFrame()).toContain("\ue60b settings.json");
  const sidebar = setup.renderer.root.findDescendantById("browser-panel");
  const viewer = setup.renderer.root.findDescendantById("viewer-panel");
  if (!(sidebar instanceof BoxRenderable) || !(viewer instanceof BoxRenderable)) throw new Error("Missing panes.");
  expect(backgroundIntentsFrom(setup, viewer.x, 14).every((intent) => intent === "default")).toBe(true);
  expect(backgroundIntentsFrom(setup, 0, 14).some((intent) => intent !== "default")).toBe(true);
  expect(sidebar.width).toBe(30);
  setup.resize(60, 12);
  await setup.renderOnce();
  expect(sidebar.width).toBeGreaterThanOrEqual(28);
  expect(viewer.width).toBeGreaterThanOrEqual(24);
  expect(backgroundIntentsFrom(setup, viewer.x, 10).every((intent) => intent === "default")).toBe(true);
}));
