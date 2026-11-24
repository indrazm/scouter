import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app";
import { ChangeList } from "../src/changes";
import { createRepository, git, waitForFrame, waitForText, watchBorder, withDirectory } from "./fixtures";

const numbered = (count: number, replace: Record<number, string> = {}): string =>
  `${Array.from({ length: count }, (_, index) => replace[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;

function footer(setup: TestRendererSetup): { status: string; hints: string } {
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.trim());
  return { status: rows.at(-2) ?? "", hints: rows.at(-1) ?? "" };
}

const headerRow = (setup: TestRendererSetup): string => setup.captureCharFrame().split("\n")[1] ?? "";

function scroller(setup: TestRendererSetup): ScrollBoxRenderable {
  const found = setup.renderer.root.findDescendantById("diff-scroller");

  if (!(found instanceof ScrollBoxRenderable)) throw new Error("No diff scroller mounted.");

  return found;
}

test("d outside a git repository says so and stays on the file view", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "a.txt"), "hello\n");
    await using setup = await createTestRenderer({ width: 100, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "a.txt"));
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "Not a git repository.");
    expect(headerRow(setup)).toContain("Not a git repository.");
    expect(footer(setup).status).toContain("READER");
    expect(footer(setup).status).not.toContain("CHANGES");
    expect(setup.captureCharFrame()).toContain("1  hello");
  }));

test("split view is refused, and the diff stays unified, when the reader is too narrow", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": "one\n" });
    await writeFile(join(directory, "a.txt"), "two\n");
    await using setup = await createTestRenderer({ width: 70, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "a.txt"));
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "CHANGES");
    setup.mockInput.pressKey("s");
    await waitForText(setup, "Split needs 60+ columns.");
    expect(headerRow(setup)).not.toContain(" split ");
  }));

test("a truncated change list says how many changes it shows", async () => {
  await using setup = await createTestRenderer({ width: 60, height: 12 });
  const list = new ChangeList(setup.renderer, { onSelect: () => {}, onActivate: () => {} });
  setup.renderer.root.add(list);
  const changes = Array.from({ length: 1000 }, (_, index) => ({
    path: `file-${index}.txt`,
    kind: "modified" as const,
    added: 1,
    removed: 0,
    binary: false,
  }));
  list.show(changes, undefined, true);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Only the first 1,000 changes are listed.");
});

test("a clean repository shows an empty state instead of a diff", () =>
  withDirectory(async (directory) => {
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
    setup.mockInput.pressTab();
    await setup.renderOnce();
    expect(footer(setup).status).toContain("CHANGES");
  }));

test("shows every changed file's diff stacked by default, and returns to the file view untouched", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, {
      "README.md": "# Title\n\nbody\n",
      "gone.txt": "bye\n",
      "src/app.ts": numbered(60),
    });
    await writeFile(
      join(directory, "src", "app.ts"),
      numbered(60, { 2: "line two changed", 55: "line fifty-five changed" }),
    );
    await rm(join(directory, "gone.txt"));
    await writeFile(join(directory, "notes.txt"), "brand new\nfile\n");
    await using setup = await createTestRenderer({ width: 110, height: 24 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "README.md"));
    await setup.renderOnce();
    expect(footer(setup).status).toContain("3 lines");

    setup.mockInput.pressKey("d");
    await waitForText(setup, "CHANGES");
    await waitForText(setup, "bye");
    await waitForText(setup, "brand new");
    const everything = setup.captureCharFrame();
    for (const expected of ["gone.txt", "notes.txt", "app.ts", "src/", "−1", "new", "line two changed"])
      expect(everything).toContain(expected);
    expect(everything).not.toContain("body");
    expect(headerRow(setup)).toContain("all files");
    expect(footer(setup).hints).toContain("Enter view");
    expect(footer(setup).hints).toContain("a one file");
    await waitForText(setup, "3 files");
    expect(footer(setup).status).toContain("4 hunks");
    expect(footer(setup).status).toContain("+4 −3");

    setup.mockInput.pressKey("G");
    await setup.renderOnce();
    expect(scroller(setup).scrollTop).toBeGreaterThan(0);
    expect(headerRow(setup)).toContain("app.ts");
    expect(footer(setup).status).toContain("src/app.ts");

    setup.mockInput.pressTab();
    await setup.renderOnce();
    expect(footer(setup).status).toContain("DIFF");
    expect(footer(setup).hints).toContain("n N hunk");

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
    await waitForText(setup, "body");
    expect(setup.captureCharFrame()).not.toContain("# Title");
    expect(git(directory, "status", "--porcelain")).toContain(" D gone.txt");
  }));

test("n and p step through the hunks of every file in order", () =>
  withDirectory(async (directory) => {
    const names = ["a.txt", "b.txt", "c.txt"];
    await createRepository(directory, Object.fromEntries(names.map((name) => [name, numbered(100)])));
    await Promise.all(
      names.map((name) => writeFile(join(directory, name), numbered(100, { 2: `${name} early`, 90: `${name} late` }))),
    );
    await using setup = await createTestRenderer({ width: 100, height: 12 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "6 hunks");
    setup.mockInput.pressTab();
    await setup.renderOnce();

    const tops: number[] = [scroller(setup).scrollTop];
    for (let step = 0; step < 6; step += 1) {
      setup.mockInput.pressKey("n");
      // oxlint-disable-next-line no-await-in-loop
      await setup.renderOnce();
      tops.push(scroller(setup).scrollTop);
    }
    expect(tops[0]).toBe(0);
    for (let index = 1; index < tops.length; index += 1) expect(tops[index]!).toBeGreaterThanOrEqual(tops[index - 1]!);
    expect(new Set(tops).size).toBeGreaterThanOrEqual(4);
    expect(setup.captureCharFrame()).toContain("c.txt");

    for (let step = 0; step < 8; step += 1) setup.mockInput.pressKey("p");
    await setup.renderOnce();
    expect(scroller(setup).scrollTop).toBe(0);
  }));

test("N steps back through the hunks, the same as p", () =>
  withDirectory(async (directory) => {
    const names = ["a.txt", "b.txt", "c.txt"];
    await createRepository(directory, Object.fromEntries(names.map((name) => [name, numbered(100)])));
    await Promise.all(
      names.map((name) => writeFile(join(directory, name), numbered(100, { 2: `${name} early`, 90: `${name} late` }))),
    );
    await using setup = await createTestRenderer({ width: 100, height: 12 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "6 hunks");
    setup.mockInput.pressTab();
    await setup.renderOnce();

    for (let step = 0; step < 6; step += 1) setup.mockInput.pressKey("n");
    await setup.renderOnce();
    const last = scroller(setup).scrollTop;
    setup.mockInput.pressKey("N");
    await setup.renderOnce();
    const before = scroller(setup).scrollTop;
    expect(before).toBeLessThan(last);
    setup.mockInput.pressKey("p");
    await setup.renderOnce();
    expect(scroller(setup).scrollTop).toBeLessThan(before);
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    expect(scroller(setup).scrollTop).toBe(before);
  }));

test("the highlight follows the reader as it scrolls, and a pick in the list scrolls the reader", () =>
  withDirectory(async (directory) => {
    const names = ["a.txt", "b.txt", "c.txt"];
    await createRepository(directory, Object.fromEntries(names.map((name) => [name, numbered(30)])));
    await Promise.all(
      names.map((name) =>
        writeFile(join(directory, name), numbered(30, { 2: `${name} edit one`, 28: `${name} edit two` })),
      ),
    );
    await using setup = await createTestRenderer({ width: 100, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "a.txt edit one");
    await waitForText(setup, "3 files");
    expect(footer(setup).status).toContain("a.txt");

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    await setup.renderOnce();
    const second = scroller(setup).scrollTop;
    expect(second).toBeGreaterThan(0);
    expect(footer(setup).status).toContain("b.txt");
    expect(setup.captureCharFrame().split("\n")[1]).toContain("b.txt");

    setup.mockInput.pressTab();
    await setup.renderOnce();
    setup.mockInput.pressKey("G");
    await setup.renderOnce();
    await setup.renderOnce();
    expect(footer(setup).status).toContain("c.txt");
    expect(headerRow(setup)).toContain("c.txt");
    setup.mockInput.pressTab();
    await setup.renderOnce();
    setup.mockInput.pressKey("k");
    await setup.renderOnce();
    await setup.renderOnce();
    expect(footer(setup).status).toContain("b.txt");
  }));

test("a toggles between every file and the highlighted file alone", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    await Promise.all(["a.txt", "b.txt", "c.txt"].map((name) => writeFile(join(directory, name), `${name} changed\n`)));
    await using setup = await createTestRenderer({ width: 100, height: 20 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "c.txt changed");
    expect(setup.captureCharFrame()).toContain("a.txt changed");

    setup.mockInput.pressKey("a");
    await waitForText(setup, "one file");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("a.txt changed");
    expect(setup.captureCharFrame()).not.toContain("b.txt changed");
    expect(setup.captureCharFrame()).not.toContain("c.txt changed");
    expect(footer(setup).hints).toContain("a all files");

    setup.mockInput.pressKey("j");
    await waitForText(setup, "b.txt changed");
    expect(setup.captureCharFrame()).not.toContain("a.txt changed");

    setup.mockInput.pressKey("a");
    await waitForText(setup, "c.txt changed");
    expect(setup.captureCharFrame()).toContain("a.txt changed");
    expect(headerRow(setup)).toContain("all files");
    expect(footer(setup).status).toContain("b.txt");
  }));

test("r reloads the changes without leaving the diff screen", () =>
  withDirectory(async (directory) => {
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

test("explains files with no text to show, and shows untracked files as additions", () =>
  withDirectory(async (directory) => {
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

test("moving through the list quickly always ends on the last file's diff", () =>
  withDirectory(async (directory) => {
    const files = { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" };
    await createRepository(directory, files);
    await Promise.all(Object.keys(files).map((name) => writeFile(join(directory, name), `${name} changed\n`)));
    await using setup = await createTestRenderer({ width: 100, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "a.txt changed");
    setup.mockInput.pressKey("a");
    await waitForText(setup, "one file");
    for (let step = 0; step < 3; step += 1) setup.mockInput.pressKey("j");
    await waitForText(setup, "d.txt changed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("d.txt changed");
    expect(setup.captureCharFrame()).not.toContain("b.txt changed");
    expect(footer(setup).status).toContain("d.txt");
  }));

test("clicking a changed file opens its diff in the reader once it has loaded", () =>
  withDirectory(async (directory) => {
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

test("w wraps long diff lines to the reader's width, and d returns with the sidebar's file tree intact", () =>
  withDirectory(async (directory) => {
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

const rewrite = (word: string): Record<number, string> =>
  Object.fromEntries(Array.from({ length: 60 }, (_, index) => [index + 1, `${word} ${index + 1}`]));

const FAST_POLL = { diffPollMs: 40 };

test("follows a commit made elsewhere without pressing r", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": "one\n", "b.txt": "two\n" });
    await writeFile(join(directory, "a.txt"), "one changed\n");
    await writeFile(join(directory, "b.txt"), "two changed\n");
    await using setup = await createTestRenderer({ width: 100, height: 16 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "2 files");

    git(directory, "commit", "--all", "--quiet", "-m", "from another terminal");
    await waitForText(setup, "No changes");
    expect(footer(setup).status).toContain("0 files");
    expect(footer(setup).status).not.toContain("Loading");

    await writeFile(join(directory, "c.txt"), "created after the commit\n");
    await waitForText(setup, "created after the commit");
    expect(footer(setup).status).toContain("1 file");
  }));

test("keeps the highlight near its place when its file is committed", () =>
  withDirectory(async (directory) => {
    const names = ["a.txt", "b.txt", "c.txt"];
    await createRepository(directory, Object.fromEntries(names.map((name) => [name, "x\n"])));
    await Promise.all(names.map((name) => writeFile(join(directory, name), `${name} changed\n`)));
    await using setup = await createTestRenderer({ width: 100, height: 16 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "a.txt changed");
    setup.mockInput.pressKey("j");
    await waitForText(setup, "b.txt changed");

    git(directory, "add", "b.txt");
    git(directory, "commit", "--quiet", "-m", "only b");
    await waitForText(setup, "2 files");
    await waitForFrame(setup, (frame) => !frame.includes("b.txt changed"), "b.txt to leave the reader");
    expect(setup.captureCharFrame()).toContain("c.txt changed");
    expect(footer(setup).status).toContain("c.txt");
  }));

test("redraws an edited diff in place, and leaves the reader alone while nothing changes", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "long.txt": numbered(80) });
    await writeFile(join(directory, "long.txt"), numbered(80, rewrite("edited")));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "line 1");
    setup.mockInput.pressTab();
    await setup.renderOnce();
    scroller(setup).scrollTo(70);
    await setup.renderOnce();
    const before = scroller(setup).scrollTop;
    expect(before).toBeGreaterThan(60);
    expect(setup.captureCharFrame()).toContain("edited");

    await new Promise((resolve) => setTimeout(resolve, 250));
    await setup.renderOnce();
    expect(scroller(setup).scrollTop).toBe(before);

    await writeFile(join(directory, "long.txt"), numbered(80, rewrite("revised")));
    await waitForText(setup, "revised");
    expect(setup.captureCharFrame()).not.toContain("edited");
    expect(scroller(setup).scrollTop).toBe(before);
    expect(footer(setup).status).toContain("DIFF");
  }));

test("stops reading git once the diff screen is closed", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": "one\n" });
    await writeFile(join(directory, "a.txt"), "two\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "1 file");
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(footer(setup).status).toContain("FILES");

    git(directory, "commit", "--all", "--quiet", "-m", "while closed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "No changes");
  }));

test("moving through the list or clicking a file never pulses the pane borders", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": "a\n", "b.bin": "text\n", "c.txt": "c\n" });
    await writeFile(join(directory, "a.txt"), "a changed\n");
    await writeFile(join(directory, "b.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(directory, "c.txt"), "c changed\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "a changed");

    const writes: string[] = [];
    for (const id of ["browser-panel", "viewer-panel"]) watchBorder(setup.renderer.root, id, writes);

    setup.mockInput.pressKey("j");
    await waitForText(setup, "Binary file");
    setup.mockInput.pressKey("j");
    await waitForText(setup, "c changed");
    expect(writes).toEqual([]);

    setup.mockInput.pressTab();
    await setup.renderOnce();
    writes.length = 0;
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.slice(0, 40).includes("a.txt"));
    await setup.mockMouse.click(lines[y]!.indexOf("a.txt") + 1, y);
    await waitForText(setup, "a changed");
    await setup.renderOnce();
    expect(writes).toEqual([]);
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("diff-scroller");
  }));

test("marks each change as staged, partly staged, not staged, or untracked in the list", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "staged.txt": "one\n", "partly.txt": "one\n", "loose.txt": "one\n" });
    await writeFile(join(directory, "staged.txt"), "two\n");
    git(directory, "add", "staged.txt");
    await writeFile(join(directory, "partly.txt"), "two\n");
    git(directory, "add", "partly.txt");
    await writeFile(join(directory, "partly.txt"), "three\n");
    await writeFile(join(directory, "loose.txt"), "two\n");
    await writeFile(join(directory, "new.txt"), "fresh\n");
    await using setup = await createTestRenderer({ width: 100, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "4 files");
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/M ● +staged\.txt/);
    expect(frame).toMatch(/M ◐ +partly\.txt/);
    expect(frame).toMatch(/M ○ +loose\.txt/);
    expect(frame).toMatch(/\? +new\.txt/);
  }));

test("tracks the active hunk in the footer, reports hunk boundaries, and opens the file at the active hunk", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "long.txt": numbered(80) });
    await writeFile(join(directory, "long.txt"), numbered(80, { 2: "first edit", 65: "second edit" }));
    await using setup = await createTestRenderer({ width: 110, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "1/2 hunks");

    setup.mockInput.pressKey("p");
    await waitForText(setup, "First hunk.");

    setup.mockInput.pressKey("n");
    await waitForText(setup, "2/2 hunks");
    expect(setup.captureCharFrame()).toContain("second edit");

    setup.mockInput.pressKey("n");
    await waitForText(setup, "Last hunk.");

    setup.mockInput.pressKey("o");
    await waitForText(setup, "65  second edit");
    expect(footer(setup).status).toContain("READER");
  }));

test("c collapses and expands a file diff, and x toggles expanded diff context", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "ctx.txt": numbered(40) });
    await writeFile(join(directory, "ctx.txt"), numbered(40, { 20: "line twenty edited" }));
    await using setup = await createTestRenderer({ width: 110, height: 30 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "line twenty edited");
    expect(setup.captureCharFrame()).not.toContain("line 10");

    setup.mockInput.pressKey("c");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("line twenty edited");
    expect(setup.captureCharFrame()).toContain("▸ M ○ ctx.txt");

    setup.mockInput.pressKey("c");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("line twenty edited");

    setup.mockInput.pressKey("x");
    await waitForText(setup, "wide context");
    await waitForText(setup, "line 10");

    setup.mockInput.pressKey("x");
    await waitForFrame(setup, (frame) => !frame.includes("line 10"), "normal context again");
    expect(headerRow(setup)).not.toContain("wide context");
  }));
