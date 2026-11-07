import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ScouterApp } from "../src/app";
import { createRepository, markedWords, waitForFrame, waitForText, withDirectory } from "./fixtures";

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

test("in the search prompt Enter goes to the next match and wraps, and the prompt stays open", () =>
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
    await waitForText(setup, "/hit  2 of 2");
    expect(setup.captureCharFrame()).toContain("30  hit two");
    expect(footer(setup).status).toContain("SEARCH");
    setup.mockInput.pressEnter();
    await waitForText(setup, "/hit  1 of 2");
    setup.mockInput.pressArrow("up");
    await waitForText(setup, "/hit  2 of 2");
    setup.mockInput.pressArrow("down");
    await waitForText(setup, "/hit  1 of 2");
    expect(footer(setup).status).toContain("SEARCH");
  }));

test("Esc closes the search prompt but keeps the matches for n and p, and a second Esc clears them", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "notes.txt");
    await writeFile(path, numbered(60, { 5: "hit one", 30: "hit two" }));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("hit");
    await waitForFrame(setup, () => markedWords(setup).length === 1, "the match marked");

    setup.mockInput.pressEscape();
    await waitForText(setup, "READER");
    expect(footer(setup).status).toContain("/hit  1 of 2");
    expect(markedWords(setup)).toEqual(["hit"]);

    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("n");
    await waitForText(setup, "/hit  2 of 2");
    expect(setup.captureCharFrame()).toContain("30  hit two");
    setup.mockInput.pressKey("p");
    await waitForText(setup, "/hit  1 of 2");

    setup.mockInput.pressEscape();
    await waitForFrame(setup, () => !footer(setup).status.includes("/hit"), "the search to clear");
    expect(markedWords(setup)).toEqual([]);
    expect(footer(setup).status).toContain("READER");

    setup.mockInput.pressEscape();
    await waitForText(setup, "FILES");
  }));

test("N steps back through the kept matches, as p does, wrapping at the start", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "notes.txt");
    await writeFile(path, numbered(60, { 5: "hit one", 30: "hit two", 50: "hit three" }));
    await using setup = await createTestRenderer({ width: 100, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("hit");
    await waitForFrame(setup, () => markedWords(setup).length === 1, "the first match marked");
    setup.mockInput.pressEscape();
    await waitForText(setup, "READER");
    expect(footer(setup).status).toContain("/hit  1 of 3");

    setup.mockInput.pressKey("N");
    await waitForText(setup, "/hit  3 of 3");
    expect(setup.captureCharFrame()).toContain("50  hit three");
    setup.mockInput.pressKey("N");
    await waitForText(setup, "/hit  2 of 3");
    expect(setup.captureCharFrame()).toContain("30  hit two");
    setup.mockInput.pressKey("n");
    await waitForText(setup, "/hit  3 of 3");
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
    setup.mockInput.pressEscape();
    await waitForText(setup, "READER");
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
    setup.mockInput.pressEscape();
    await waitForText(setup, "READER");
    await waitForText(setup, "/hit  1 of 2");

    await app.open(join(directory, "b.txt"));
    await waitForText(setup, "/hit  1 of 1");
    setup.mockInput.pressKey("n");
    await waitForText(setup, "50  hit only");
  }));

test("Tab in the find prompt searches the text inside files, and Enter opens the line, ready for n and p", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "app.ts"), numbered(60, { 5: "const needle = 1;", 40: "needle again" }));
    await writeFile(join(directory, "other.txt"), "nothing to see\n");
    await using setup = await createTestRenderer({ width: 170, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();

    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    expect(footer(setup).status).toContain("FIND");
    setup.mockInput.pressTab();
    await setup.renderOnce();
    expect(footer(setup).status).toContain("TEXT");
    await setup.mockInput.typeText("NEEDLE");
    await waitForText(setup, "2 matches");
    expect(setup.captureCharFrame()).toContain("app.ts:5  const needle = 1;");
    expect(setup.captureCharFrame()).toContain("app.ts:40  needle again");
    expect(setup.captureCharFrame()).not.toContain("other.txt");

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await waitForText(setup, "40  needle again");
    expect(footer(setup).status).toContain("READER");
    await waitForText(setup, "/NEEDLE  2 of 2");
    setup.mockInput.pressKey("n");
    await waitForText(setup, "/NEEDLE  1 of 2");
    expect(setup.captureCharFrame()).toContain("5  const needle = 1;");
  }));

test("Tab again goes back to file names with what was typed kept, and a single character waits for more", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "needle-notes.txt"), "text\n");
    await writeFile(join(directory, "plain.txt"), "plain\n");
    await using setup = await createTestRenderer({ width: 110, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("n");
    setup.mockInput.pressTab();
    await waitForText(setup, "type 2+ characters");
    setup.mockInput.pressTab();
    await waitForText(setup, "FIND");
    await waitForText(setup, "needle-notes.txt");
    expect(footer(setup).status).toContain("FIND");
    setup.mockInput.pressEscape();
    await waitForText(setup, "FILES");
    expect(footer(setup).status).not.toContain("FIND");
  }));

test("text search leaves out ignored and binary files, and says when nothing matches", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { ".gitignore": "secret.txt\n", "tracked.txt": "one\n" });
    await writeFile(join(directory, "tracked.txt"), "needle\n");
    await writeFile(join(directory, "secret.txt"), "needle in an ignored file\n");
    await writeFile(join(directory, "blob.bin"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
    await using setup = await createTestRenderer({ width: 110, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await waitForFrame(setup, (frame) => /tracked\.txt\s+M/.test(frame), "the git marks");
    setup.mockInput.pressKey("/");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "1 match");
    expect(setup.captureCharFrame()).toContain("tracked.txt:1");
    expect(setup.captureCharFrame()).not.toContain("secret.txt");
    await setup.mockInput.typeText("zzz");
    await waitForText(setup, "no matches");
  }));

test("a text result in a Markdown file opens its source at that line, not the rendered page", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "guide.md"), `# Title\n\n${numbered(40, { 30: "the needle is here" })}`);
    await using setup = await createTestRenderer({ width: 110, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "guide.md:32");
    setup.mockInput.pressEnter();
    await waitForText(setup, "32  the needle is here");
    expect(footer(setup).status).toContain("READER");
  }));

test("the reader previews the highlighted text result, follows ↑ ↓, and Esc gives the reader back", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "app.ts"), numbered(60, { 5: "const needle = 1;", 50: "needle again" }));
    await using setup = await createTestRenderer({ width: 120, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Select a file");

    setup.mockInput.pressKey("/");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "2 matches");
    await waitForText(setup, "5  const needle = 1;");
    expect(setup.captureCharFrame()).toContain("preview");
    expect(setup.captureCharFrame()).not.toContain("Select a file");

    setup.mockInput.pressArrow("down");
    await waitForText(setup, "50  needle again");
    expect(footer(setup).status).toContain("TEXT");

    setup.mockInput.pressEscape();
    await waitForText(setup, "Select a file");
    expect(setup.captureCharFrame()).not.toContain("50  needle again");
    expect(setup.captureCharFrame()).not.toContain("preview");
  }));

test("closing the preview puts back the file that was open, untouched", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "open.txt"), numbered(30, { 3: "the open file" }));
    await writeFile(join(directory, "other.txt"), `${numbered(30, { 20: "other has needle" })}`);
    await using setup = await createTestRenderer({ width: 120, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "open.txt"));
    await waitForText(setup, "3  the open file");

    setup.mockInput.pressTab();
    setup.mockInput.pressKey("/");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "20  other has needle");
    expect(setup.captureCharFrame()).not.toContain("3  the open file");

    setup.mockInput.pressEscape();
    await waitForText(setup, "3  the open file");
    expect(setup.captureCharFrame()).not.toContain("other has needle");
    expect(setup.captureCharFrame()).not.toContain("preview");
  }));

test("clicking a text result opens it at its line, as Enter does", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "app.ts"), numbered(60, { 45: "needle far down" }));
    await using setup = await createTestRenderer({ width: 120, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "app.ts:45");
    const row = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("app.ts:45"));
    await setup.mockMouse.click(6, row);
    await waitForText(setup, "READER");
    await waitForText(setup, "45  needle far down");
    expect(footer(setup).status).toContain("/needle  1 of 1");
  }));

test("a kept search marks every occurrence in the open file, in plain text and in code, and Esc clears them", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "notes.txt"), "first\nthe Needle and a needle\nlast\n");
    await writeFile(join(directory, "code.ts"), "const needle = 1; // needle\nconst other = 2;\n");
    await using setup = await createTestRenderer({ width: 120, height: 12 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "notes.txt"));
    await waitForText(setup, "the Needle and a needle");
    expect(markedWords(setup)).toEqual([]);

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("needle");
    await waitForFrame(setup, () => markedWords(setup).length === 2, "both words marked");
    expect(markedWords(setup)).toEqual(["Needle", "needle"]);
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(markedWords(setup)).toEqual(["Needle", "needle"]);

    await app.open(join(directory, "code.ts"));
    await waitForText(setup, "const other");
    await waitForFrame(setup, () => markedWords(setup).length === 2, "marks in the code file");
    expect(markedWords(setup)).toEqual(["needle", "needle"]);

    setup.mockInput.pressKey("/");
    setup.mockInput.pressEscape();
    await waitForFrame(setup, () => markedWords(setup).length === 0, "the marks to go");
  }));

test("the preview and the file opened from a text result mark the words that were searched for", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "app.ts"), numbered(30, { 6: "const needle = needle + 1;" }));
    await using setup = await createTestRenderer({ width: 120, height: 12 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("/");
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("needle");
    await waitForText(setup, "6  const needle = needle + 1;");
    await waitForFrame(setup, () => markedWords(setup).length === 2, "the preview's marks");
    expect(markedWords(setup)).toEqual(["needle", "needle"]);

    setup.mockInput.pressEnter();
    await waitForText(setup, "READER");
    await waitForFrame(setup, () => markedWords(setup).length === 2, "the opened file's marks");
    expect(markedWords(setup)).toEqual(["needle", "needle"]);
  }));
