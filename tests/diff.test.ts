import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app";
import { createRepository, git, waitForText, withDirectory } from "./fixtures";

const numbered = (count: number, replace: Record<number, string> = {}): string =>
  `${Array.from({ length: count }, (_, index) => replace[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;

/** The two footer rows: the status bar, then the key hints. */
function footer(setup: TestRendererSetup): { status: string; hints: string } {
  const rows = setup.captureCharFrame().split("\n").filter((row) => row.trim());
  return { status: rows.at(-2) ?? "", hints: rows.at(-1) ?? "" };
}

const headerRow = (setup: TestRendererSetup): string => setup.captureCharFrame().split("\n")[0] ?? "";

function scroller(setup: TestRendererSetup): ScrollBoxRenderable {
  const found = setup.renderer.root.findDescendantById("diff-scroller");
  if (!(found instanceof ScrollBoxRenderable)) throw new Error("No diff scroller mounted.");
  return found;
}

test("d outside a git repository says so and stays on the file view", () => withDirectory(async (directory) => {
  await writeFile(join(directory, "a.txt"), "hello\n");
  await using setup = await createTestRenderer({ width: 100, height: 16 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(join(directory, "a.txt"));
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "Not a git repository.");
  expect(footer(setup).status).toContain("READER");
  expect(footer(setup).status).not.toContain("CHANGES");
  expect(setup.captureCharFrame()).toContain("1  hello");
}));

test("a clean repository shows an empty state instead of a diff", () => withDirectory(async (directory) => {
  await createRepository(directory, { "a.txt": "one\n" });
  await using setup = await createTestRenderer({ width: 100, height: 16 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "No changes");
  expect(setup.captureCharFrame()).toContain("The working tree matches HEAD.");
  expect(footer(setup).status).toContain("CHANGES");
  expect(footer(setup).status).toContain("0 files");
  // Nothing to read, so Tab has nowhere to go.
  setup.mockInput.pressTab();
  await setup.renderOnce();
  expect(footer(setup).status).toContain("CHANGES");
}));

test("lists changes, shows the highlighted file's diff, and returns to the file view untouched", () => withDirectory(async (directory) => {
  await createRepository(directory, {
    "README.md": "# Title\n\nbody\n", "gone.txt": "bye\n", "src/app.ts": numbered(60),
  });
  await writeFile(join(directory, "src", "app.ts"), numbered(60, { 2: "line two changed", 55: "line fifty-five changed" }));
  await rm(join(directory, "gone.txt"));
  await writeFile(join(directory, "notes.txt"), "brand new\nfile\n");
  await using setup = await createTestRenderer({ width: 110, height: 14 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(join(directory, "README.md"));
  await setup.renderOnce();
  expect(footer(setup).status).toContain("3 lines");

  setup.mockInput.pressKey("d");
  await waitForText(setup, "CHANGES");
  const list = setup.captureCharFrame();
  for (const expected of ["gone.txt", "notes.txt", "app.ts", "src/", "−1", "new"]) expect(list).toContain(expected);
  expect(footer(setup).hints).toContain("Enter view");
  await waitForText(setup, "bye");

  setup.mockInput.pressKey("G");
  await waitForText(setup, "line two changed");
  expect(headerRow(setup)).toContain("app.ts");
  expect(headerRow(setup)).toContain("modified");
  await waitForText(setup, "2 hunks");
  expect(footer(setup).status).toContain("+2 −2");
  expect(footer(setup).status).toContain("src/app.ts");

  setup.mockInput.pressTab();
  await setup.renderOnce();
  expect(footer(setup).status).toContain("DIFF");
  expect(footer(setup).hints).toContain("n p hunk");

  // Hunks start at the top of the reader; the second one is far below the first.
  expect(scroller(setup).scrollTop).toBe(0);
  setup.mockInput.pressKey("n");
  await setup.renderOnce();
  const second = scroller(setup).scrollTop;
  expect(second).toBeGreaterThan(0);
  setup.mockInput.pressKey("p");
  await setup.renderOnce();
  expect(scroller(setup).scrollTop).toBe(0);

  setup.mockInput.pressKey("s");
  await setup.renderOnce();
  expect(headerRow(setup)).toContain(" split ");
  setup.mockInput.pressKey("s");
  await setup.renderOnce();
  expect(headerRow(setup)).not.toContain(" split ");

  setup.mockInput.pressKey("d");
  await setup.renderOnce();
  expect(footer(setup).status).toContain("READER");
  expect(footer(setup).status).toContain("README.md");
  expect(footer(setup).status).toContain("3 lines");
  expect(headerRow(setup)).toContain("README.md");
  expect(headerRow(setup)).toContain("read-only");
  expect(setup.captureCharFrame()).toContain("1  # Title");
  expect(git(directory, "status", "--porcelain")).toContain(" D gone.txt");
}));

test("r reloads the changes without leaving the diff screen", () => withDirectory(async (directory) => {
  await createRepository(directory, { "a.txt": "one\n" });
  await writeFile(join(directory, "a.txt"), "two\n");
  await using setup = await createTestRenderer({ width: 100, height: 16 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "1 file");
  expect(setup.captureCharFrame()).not.toContain("later.txt");

  await writeFile(join(directory, "later.txt"), "added after opening\n");
  setup.mockInput.pressKey("r");
  await waitForText(setup, "later.txt");
  expect(footer(setup).status).toContain("CHANGES");
  expect(footer(setup).status).not.toContain("Loading");
}));

test("explains files with no text to show, and shows untracked files as additions", () => withDirectory(async (directory) => {
  await createRepository(directory, { "image.bin": "text for now\n" });
  await writeFile(join(directory, "image.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(directory, "new.txt"), "first\nsecond\n");
  await using setup = await createTestRenderer({ width: 100, height: 16 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "Binary file: no preview.");
  expect(footer(setup).status).toContain("CHANGES");

  setup.mockInput.pressKey("j");
  await waitForText(setup, "second");
  expect(setup.captureCharFrame()).toContain("+");
  expect(headerRow(setup)).toContain("untracked");
  expect(footer(setup).status).toContain("+2 −0");
}));

test("moving through the list quickly always ends on the last file's diff", () => withDirectory(async (directory) => {
  const files = { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" };
  await createRepository(directory, files);
  for (const name of Object.keys(files)) await writeFile(join(directory, name), `${name} changed\n`);
  await using setup = await createTestRenderer({ width: 100, height: 16 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "a.txt changed");
  for (let step = 0; step < 3; step += 1) setup.mockInput.pressKey("j");
  await waitForText(setup, "d.txt changed");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("d.txt changed");
  expect(setup.captureCharFrame()).not.toContain("b.txt changed");
  expect(footer(setup).status).toContain("d.txt");
}));

test("clicking a changed file opens its diff in the reader once it has loaded", () => withDirectory(async (directory) => {
  await createRepository(directory, { "a.txt": "a\n", "b.txt": "b\n" });
  await writeFile(join(directory, "a.txt"), "a changed\n");
  await writeFile(join(directory, "b.txt"), "b changed\n");
  await using setup = await createTestRenderer({ width: 100, height: 16 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "a changed");
  expect(footer(setup).status).toContain("CHANGES");

  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.slice(0, 40).includes("b.txt"));
  await setup.mockMouse.click(lines[y]!.indexOf("b.txt") + 1, y);
  await waitForText(setup, "b changed");
  await waitForText(setup, "DIFF");
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("diff-scroller");
}));

test("w wraps long diff lines to the reader's width, and d returns with the sidebar's file tree intact", () => withDirectory(async (directory) => {
  await createRepository(directory, { "wide.txt": "short\n" });
  await writeFile(join(directory, "wide.txt"), `${"word ".repeat(60)}end\n`);
  await using setup = await createTestRenderer({ width: 90, height: 14 });
  await using app = new ScouterApp(setup.renderer);
  await app.open(directory);
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "word word");
  expect(scroller(setup).scrollWidth).toBeGreaterThan(scroller(setup).viewport.width);

  setup.mockInput.pressKey("w");
  await setup.renderOnce();
  await setup.renderOnce();
  expect(scroller(setup).scrollWidth).toBe(scroller(setup).viewport.width);
  expect(setup.captureCharFrame()).toContain("end");
  expect(headerRow(setup)).toContain(" wrap ");

  setup.mockInput.pressKey("d");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("wide.txt");
  expect(footer(setup).status).toContain("FILES");
}));
