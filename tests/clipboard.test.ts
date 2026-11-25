import { expect, test } from "bun:test";
import { CodeRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app/app";
import { copiedSummary } from "../src/core/clipboard";
import { palettes } from "../src/ui/theme";
import { hasBackground, waitForText, withDirectory } from "./fixtures";

test("copiedSummary describes single-line and multi-line selections cleanly", () => {
  expect(copiedSummary("a")).toBe("Copied 1 character.");
  expect(copiedSummary("hello")).toBe("Copied 5 characters.");
  expect(copiedSummary("one\ntwo\nthree")).toBe("Copied 3 lines.");
});

test("dragging text in the reader auto-copies on release and clears the selection", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "sample.txt");
    await writeFile(path, "alpha beta gamma\nsecond line\n");
    const copied: string[] = [];
    await using setup = await createTestRenderer({ width: 100, height: 16, kittyKeyboard: true });
    await using app = new ScouterApp(setup.renderer, {
      copy: (text) => {
        copied.push(text);
        return true;
      },
    });
    await app.open(path);
    await waitForText(setup, "1  alpha beta gamma");

    const code = setup.renderer.root.findDescendantById("document");

    if (!(code instanceof CodeRenderable)) throw new Error("No code view mounted.");

    await setup.mockMouse.drag(code.x, code.y, code.x + 10, code.y);
    await waitForText(setup, "Copied");
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.at(-1)).toContain("alpha");
    expect(setup.renderer.hasSelection).toBe(false);
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");
  }));

test("y copies the current file path when nothing is selected", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "src"));
    const path = join(directory, "src", "index.ts");
    await writeFile(path, "export const value = 42;\n");
    const copied: string[] = [];
    await using setup = await createTestRenderer({ width: 100, height: 16, kittyKeyboard: true });
    await using app = new ScouterApp(setup.renderer, {
      copy: (text) => {
        copied.push(text);
        return true;
      },
    });
    await app.open(directory);
    await app.open(path);
    await waitForText(setup, "export const value = 42;");

    expect(setup.captureCharFrame().split("\n")[1]).toContain("src/index.ts");

    setup.mockInput.pressKey("y");
    await waitForText(setup, "Copied path.");
    expect(copied.at(-1)).toBe(path);
  }));

test("in-file search tints the active match line and clears the tint on Esc", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "notes.txt");
    await writeFile(path, "first line\nneedle here\nthird line\n");
    await using setup = await createTestRenderer({ width: 100, height: 16, kittyKeyboard: true });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await waitForText(setup, "2  needle here");

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "1 of 1");
    expect(hasBackground(setup, palettes.dark.targetBg)).toBe(true);

    setup.mockInput.pressEscape();
    await setup.renderOnce();
    expect(hasBackground(setup, palettes.dark.targetBg)).toBe(true);

    setup.mockInput.pressEscape();
    await setup.renderOnce();
    expect(hasBackground(setup, palettes.dark.targetBg)).toBe(false);
  }));
