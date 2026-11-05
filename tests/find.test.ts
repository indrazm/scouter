import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ScouterApp } from "../src/app";
import { createRepository, waitForFrame, waitForText, withDirectory } from "./fixtures";

/** The two footer rows: the status bar, then the key hints. */
function footer(setup: TestRendererSetup): { status: string; hints: string } {
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.trim());
  return { status: rows.at(-2) ?? "", hints: rows.at(-1) ?? "" };
}

const numbered = (count: number, replace: Record<number, string> = {}): string =>
  `${Array.from({ length: count }, (_, index) => replace[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;

test("/ finds a file anywhere under the folder, and Enter opens the highlighted one", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "deep"), { recursive: true });
    await writeFile(join(directory, "deep", "target.txt"), "found it\n");
    await writeFile(join(directory, "other.txt"), "not this\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    expect(footer(setup).status).toContain("FIND");
    await setup.mockInput.typeText("target");
    await waitForText(setup, "1 match");
    expect(setup.captureCharFrame()).toContain("deep/target.txt");
    expect(setup.captureCharFrame()).not.toContain("other.txt");

    setup.mockInput.pressEnter();
    await waitForText(setup, "1  found it");
    expect(footer(setup).status).toContain("READER");
    expect(footer(setup).status).toContain("target.txt");
  }));

test("typed letters search rather than acting, and Esc puts the tree back as it was", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "quit.txt"), "a\n");
    await writeFile(join(directory, "delete.txt"), "b\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("qd");
    await waitForText(setup, "no matches");
    expect(footer(setup).status).toContain("FIND");

    setup.mockInput.pressEscape();
    await waitForFrame(setup, (frame) => frame.includes("quit.txt") && frame.includes("delete.txt"), "the tree");
    expect(footer(setup).status).toContain("FILES");
    expect(footer(setup).status).not.toContain("FIND");
  }));

test("the find prompt leaves out files git ignores", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { ".gitignore": "secret.txt\n", "tracked.txt": "one\n" });
    await writeFile(join(directory, "tracked.txt"), "two\n");
    await writeFile(join(directory, "secret.txt"), "hidden\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    // The git marks arrive once git has answered; the modified file's status letter shows that they have.
    await waitForFrame(setup, (frame) => /tracked\.txt\s+M/.test(frame), "the git marks");
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("secret");
    await waitForText(setup, "no matches");
  }));

test("o in the changes opens the changed file in the reader at its first change", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "long.txt": numbered(80) });
    await writeFile(join(directory, "long.txt"), numbered(80, { 50: "line 50 changed" }));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "line 50 changed");
    setup.mockInput.pressKey("o");
    await waitForText(setup, "50  line 50 changed");
    expect(footer(setup).status).toContain("READER");
    expect(footer(setup).status).toContain("long.txt");
  }));

test("a deleted file has nothing to open from the changes", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "gone.txt": "bye\n", "keep.txt": "keep\n" });
    await rm(join(directory, "gone.txt"));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await waitForText(setup, "CHANGES");
    setup.mockInput.pressKey("o");
    await waitForText(setup, "nothing to open");
    expect(footer(setup).status).toContain("CHANGES");
  }));

test("/ searches the open file as you type, n and p move between matching lines, and Esc drops the search", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "notes.txt");
    await writeFile(path, numbered(60, { 5: "hit one", 30: "hit two" }));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    expect(footer(setup).status).toContain("SEARCH");
    await setup.mockInput.typeText("hit");
    await waitForText(setup, "/hit  1 of 2");
    expect(setup.captureCharFrame()).toContain("5  hit one");

    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(footer(setup).status).toContain("READER");
    expect(footer(setup).status).toContain("/hit  1 of 2");

    setup.mockInput.pressKey("n");
    await waitForText(setup, "/hit  2 of 2");
    expect(setup.captureCharFrame()).toContain("30  hit two");
    setup.mockInput.pressKey("n");
    await waitForText(setup, "/hit  1 of 2");
    setup.mockInput.pressKey("p");
    await waitForText(setup, "/hit  2 of 2");

    setup.mockInput.pressKey("/");
    setup.mockInput.pressEscape();
    await setup.renderOnce();
    expect(footer(setup).status).not.toContain("/hit");
  }));

test("search says where it cannot work, on a rendered Markdown file", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "readme.md"), "# Title\n\nbody\n");
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "readme.md"));
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await waitForText(setup, "Press m to search");
    expect(footer(setup).status).not.toContain("SEARCH");
  }));

test("a kept search follows the file when it is saved, so n lands on the new matches", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "notes.txt");
    await writeFile(path, numbered(60, { 5: "hit one", 30: "hit two" }));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer, { browsePollMs: 40 });
    await app.open(path);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("hit");
    setup.mockInput.pressEnter();
    await waitForText(setup, "/hit  1 of 2");

    await writeFile(path, numbered(60, { 45: "hit only" }));
    await waitForText(setup, "/hit  1 of 1");
    setup.mockInput.pressKey("n");
    await waitForText(setup, "45  hit only");
  }));

test("a kept search runs again on the next file opened instead of keeping the old file's lines", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "a.txt"), numbered(60, { 5: "hit one", 30: "hit two" }));
    await writeFile(join(directory, "b.txt"), numbered(60, { 50: "hit only" }));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "a.txt"));
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("hit");
    setup.mockInput.pressEnter();
    await waitForText(setup, "/hit  1 of 2");

    await app.open(join(directory, "b.txt"));
    await waitForText(setup, "/hit  1 of 1");
    setup.mockInput.pressKey("n");
    await waitForText(setup, "50  hit only");
  }));
