import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app";
import { waitForFrame, waitForText, withDirectory } from "./fixtures";

function reader(setup: { renderer: { root: { findDescendantById(id: string): unknown } } }): ScrollBoxRenderable {
  const viewer = setup.renderer.root.findDescendantById("viewer");
  if (!(viewer instanceof ScrollBoxRenderable)) throw new Error("No viewer mounted.");
  return viewer;
}

/** Paragraphs of nine lines, each followed by a blank line: blank lines are at zero-based 9, 19, 29 … */
const paragraphs = Array.from({ length: 80 }, (_, index) =>
  (index + 1) % 10 === 0 ? "" : `content-${index + 1}`,
).join("\n");

test("{ and } move the reader to the previous and next blank line, and stop at the ends", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "paragraphs.txt");
    await writeFile(path, paragraphs);
    await using setup = await createTestRenderer({ width: 100, height: 15 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();
    const viewer = reader(setup);
    expect(viewer.scrollTop).toBe(0);

    setup.mockInput.pressKey("}");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(9);

    setup.mockInput.pressKey("}");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(19);

    setup.mockInput.pressKey("{");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(9);

    setup.mockInput.pressKey("{");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(0);
    setup.mockInput.pressKey("{");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(0);

    setup.mockInput.pressKey("G");
    await setup.renderOnce();
    const bottom = viewer.scrollTop;
    expect(bottom).toBeGreaterThan(59);
    setup.mockInput.pressKey("}");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(bottom);
  }));

test("{ and } are left alone while the file list has focus", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "paragraphs.txt");
    await writeFile(path, paragraphs);
    await using setup = await createTestRenderer({ width: 100, height: 15 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await waitForText(setup, "FILES");
    setup.mockInput.pressKey("}");
    await setup.renderOnce();
    expect(reader(setup).scrollTop).toBe(0);
  }));

test("zz centres the kept search's match, and a z followed by another key is not a centre", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "needles.txt");
    const text = Array.from({ length: 80 }, (_, index) =>
      index === 29 || index === 59 ? "needle here" : `content-${index + 1}`,
    ).join("\n");
    await writeFile(path, text);
    await using setup = await createTestRenderer({ width: 100, height: 20 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();
    const viewer = reader(setup);
    const middle = Math.floor(viewer.viewport.height / 2);

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "/needle  1 of 2");
    expect(viewer.scrollTop).toBe(29 - middle);
    setup.mockInput.pressEscape();
    await waitForFrame(setup, (frame) => frame.includes("READER"), "the prompt to close");

    setup.mockInput.pressKey("n");
    await waitForText(setup, "/needle  2 of 2");
    expect(viewer.scrollTop).toBe(59 - middle);
    setup.mockInput.pressKey("p");
    await waitForText(setup, "/needle  1 of 2");
    expect(viewer.scrollTop).toBe(29 - middle);

    setup.mockInput.pressKey("G");
    await setup.renderOnce();
    expect(viewer.scrollTop).not.toBe(29 - middle);
    setup.mockInput.pressKey("z");
    setup.mockInput.pressKey("z");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(29 - middle);
    expect(setup.captureCharFrame()).toContain("30  needle here");

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(30 - middle);
    setup.mockInput.pressKey("z");
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    expect(viewer.scrollTop).toBe(31 - middle);
  }));
