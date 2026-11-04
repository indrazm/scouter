import { expect, test } from "bun:test";
import { BoxRenderable, RGBA } from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app";
import { backgroundIntentsFrom, withDirectory } from "./fixtures";

test("drags the divider without changing focus or selecting text and restores the chosen width after terminal resize", () => withDirectory(async (directory) => {
  await writeFile(join(directory, "readme.txt"), "still reading");
  await using setup = await createTestRenderer({ width: 120, height: 18, backgroundColor: RGBA.defaultBackground() });
  await using app = new ScouterApp(setup.renderer);
  await app.open(join(directory, "readme.txt"));
  await setup.renderOnce();
  const sidebar = setup.renderer.root.findDescendantById("browser-panel");
  const divider = setup.renderer.root.findDescendantById("sidebar-resizer");
  const viewer = setup.renderer.root.findDescendantById("viewer-panel");
  if (!(sidebar instanceof BoxRenderable) || !(divider instanceof BoxRenderable) || !(viewer instanceof BoxRenderable)) {
    throw new Error("Missing split panes.");
  }
  const initialWidth = sidebar.width;
  await setup.mockMouse.drag(divider.x, divider.y + 5, divider.x + 20, divider.y + 5);
  await setup.renderOnce();
  expect(sidebar.width).toBe(initialWidth + 20);
  expect(sidebar.width + divider.width + viewer.width).toBe(120);
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");
  expect(setup.renderer.hasSelection).toBe(false);
  expect(setup.captureCharFrame()).toContain("1  still reading");
  expect(backgroundIntentsFrom(setup, viewer.x, 16).every((intent) => intent === "default")).toBe(true);
  await setup.mockMouse.moveTo(divider.x + 5, divider.y + 5);
  await setup.renderOnce();
  expect(sidebar.width).toBe(initialWidth + 20);
  setup.resize(70, 18);
  await setup.renderOnce();
  expect(viewer.width).toBeGreaterThanOrEqual(28);
  setup.resize(120, 18);
  await setup.renderOnce();
  expect(sidebar.width).toBe(initialWidth + 20);
}));

test("only left-button drags resize the divider and pane widths are clamped at both edges", async () => {
  await using setup = await createTestRenderer({ width: 120, height: 18 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(import.meta.dir);
  await setup.renderOnce();
  const sidebar = setup.renderer.root.findDescendantById("browser-panel");
  const divider = setup.renderer.root.findDescendantById("sidebar-resizer");
  const viewer = setup.renderer.root.findDescendantById("viewer-panel");
  if (!(sidebar instanceof BoxRenderable) || !(divider instanceof BoxRenderable) || !(viewer instanceof BoxRenderable)) {
    throw new Error("Missing split panes.");
  }
  const initialWidth = sidebar.width;
  await setup.mockMouse.drag(divider.x, 5, divider.x + 20, 5, MouseButtons.RIGHT);
  await setup.renderOnce();
  expect(sidebar.width).toBe(initialWidth);
  await setup.mockMouse.drag(divider.x, 5, 0, 5);
  await setup.renderOnce();
  expect(sidebar.width).toBe(24);
  await setup.mockMouse.drag(divider.x, 5, 119, 5);
  await setup.renderOnce();
  expect(sidebar.width).toBe(91);
  expect(viewer.width).toBe(28);
});

test("keyboard resizing works in either pane and is retained when the terminal grows", async () => {
  await using setup = await createTestRenderer({ width: 120, height: 18 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(import.meta.dir);
  await setup.renderOnce();
  const sidebar = setup.renderer.root.findDescendantById("browser-panel");
  if (!(sidebar instanceof BoxRenderable)) throw new Error("No sidebar mounted.");
  const initialWidth = sidebar.width;
  setup.mockInput.pressArrow("left", { ctrl: true });
  await setup.renderOnce();
  expect(sidebar.width).toBe(initialWidth - 2);
  setup.mockInput.pressTab();
  setup.mockInput.pressArrow("right", { ctrl: true });
  setup.mockInput.pressArrow("right", { ctrl: true });
  await setup.renderOnce();
  expect(sidebar.width).toBe(initialWidth + 2);
  setup.resize(160, 18);
  await setup.renderOnce();
  expect(sidebar.width).toBe(initialWidth + 2);
});
