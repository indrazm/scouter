import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ScouterApp } from "../src/app";
import { JumpHistory } from "../src/jump-history";
import { createRepository, waitForFrame, waitForText, withDirectory } from "./fixtures";

function footer(setup: TestRendererSetup): { status: string; hints: string } {
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.trim());
  return { status: rows.at(-2) ?? "", hints: rows.at(-1) ?? "" };
}

const numbered = (count: number, replace: Record<number, string> = {}): string =>
  `${Array.from({ length: count }, (_, index) => replace[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;

/** Opens the file the finder names, from the file list or from the reader. */
async function openByName(setup: TestRendererSetup, name: string, firstLine: string): Promise<void> {
  if (setup.renderer.currentFocusedRenderable?.id === "viewer") setup.mockInput.pressTab();
  setup.mockInput.pressKey("/");
  await setup.mockInput.typeText(name);
  await waitForText(setup, "1 match");
  setup.mockInput.pressEnter();
  await waitForText(setup, firstLine);
}

test("Ctrl+o goes back to the file before, and Alt+i forward again", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "alpha.txt"), "alpha line\n");
    await writeFile(join(directory, "bravo.txt"), "bravo line\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    await openByName(setup, "alpha", "1  alpha line");
    await openByName(setup, "bravo", "1  bravo line");

    setup.mockInput.pressKey("o", { ctrl: true });
    await waitForText(setup, "1  alpha line");

    setup.mockInput.pressKey("i", { meta: true });
    await waitForText(setup, "1  bravo line");

    setup.mockInput.pressKey("o", { ctrl: true });
    await waitForText(setup, "1  alpha line");
    setup.mockInput.pressKey("o", { ctrl: true });
    await waitForText(setup, "No earlier place to go back to.");
    expect(setup.captureCharFrame()).toContain("1  alpha line");
  }));

test("going back returns to the scroll position the file was left at", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "long.txt"), numbered(100));
    await writeFile(join(directory, "other.txt"), "other line\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    await openByName(setup, "long", "1  line 1");
    setup.mockInput.pressKey("G");
    await waitForText(setup, "100  line 100");
    expect(footer(setup).status).toContain("Bot");

    await openByName(setup, "other", "1  other line");
    setup.mockInput.pressKey("o", { ctrl: true });
    await waitForText(setup, "100  line 100");
    expect(footer(setup).status).toContain("Bot");
  }));

test("a new jump after going back drops the places that were ahead", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "alpha.txt"), "alpha line\n");
    await writeFile(join(directory, "bravo.txt"), "bravo line\n");
    await writeFile(join(directory, "charlie.txt"), "charlie line\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    await openByName(setup, "alpha", "1  alpha line");
    await openByName(setup, "bravo", "1  bravo line");
    setup.mockInput.pressKey("o", { ctrl: true });
    await waitForText(setup, "1  alpha line");
    await openByName(setup, "charlie", "1  charlie line");

    setup.mockInput.pressKey("i", { meta: true });
    await waitForText(setup, "No later place to go to.");
    expect(setup.captureCharFrame()).toContain("1  charlie line");
  }));

test("a search result is a jump: Ctrl+o returns to the file it was found from", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "notes.txt"), numbered(60, { 40: "needle here" }));
    await writeFile(join(directory, "plain.txt"), "plain line\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    await openByName(setup, "plain", "1  plain line");

    setup.mockInput.pressTab();
    setup.mockInput.pressKey("/");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "notes.txt:40");
    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => frame.includes("60 lines") && frame.includes("notes.txt"), "notes.txt");

    setup.mockInput.pressKey("o", { ctrl: true });
    await waitForText(setup, "1  plain line");
    setup.mockInput.pressKey("i", { meta: true });
    // Matches are seeded when the file opens, so this checks the file is back rather than the exact line.
    await waitForFrame(setup, (frame) => frame.includes("60 lines") && !frame.includes("plain line"), "notes.txt");
  }));

test("o from the changes is a jump back to the file read before the changes", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "long.txt": numbered(80), "notes.txt": "notes line\n" });
    await writeFile(join(directory, "long.txt"), numbered(80, { 50: "line 50 changed" }));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    await openByName(setup, "notes", "1  notes line");

    setup.mockInput.pressKey("d");
    await waitForText(setup, "line 50 changed");
    setup.mockInput.pressKey("o");
    await waitForFrame(setup, (frame) => frame.includes("80 lines") && frame.includes("long.txt"), "long.txt open");
    expect(footer(setup).status).toContain("READER");

    setup.mockInput.pressKey("o", { ctrl: true });
    await waitForText(setup, "1  notes line");
    expect(footer(setup).status).toContain("READER");
  }));

test("Tab still switches panes: a terminal sends Ctrl+i as the Tab byte, so it is not a jump key", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "alpha.txt"), "alpha line\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    await openByName(setup, "alpha", "1  alpha line");
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");

    setup.mockInput.pressKey("i", { ctrl: true });
    await setup.renderOnce();
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("browser");
    expect(footer(setup).status).toContain("alpha.txt");
  }));

const at = (path: string, top = 0) => ({ path, top });

test("the history keeps the places in order, forgets the ones ahead on a new jump, and is capped", () => {
  const history = new JumpHistory();
  expect(history.canGoBack).toBe(false);
  history.leave(undefined);
  expect(history.canGoBack).toBe(false);

  history.leave(at("a"));
  history.leave(at("a"));
  history.leave(at("b", 4));
  expect(history.back(at("c"))).toEqual(at("b", 4));
  expect(history.forward(at("b", 4))).toEqual(at("c"));
  expect(history.back(at("c"))).toEqual(at("b", 4));
  expect(history.back(at("b", 4))).toEqual(at("a"));
  expect(history.canGoBack).toBe(false);

  history.leave(at("d"));
  expect(history.canGoForward).toBe(false);
  expect(history.forward(at("d"))).toBeUndefined();

  for (let index = 0; index < 150; index += 1) history.leave(at(`file${index}`));
  let count = 0;
  while (history.back(undefined)) count += 1;
  expect(count).toBe(100);
});
