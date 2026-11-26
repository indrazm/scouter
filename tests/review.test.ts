import { expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app/app";
import { ReviewComments, formatLineRange, rangeTarget, singleLineTarget } from "../src/review/comments";
import { parseRows } from "../src/review/diff-rows";
import { theme } from "../src/ui/theme";
import { createRepository, hasBackground, waitForFrame, waitForText, withDirectory } from "./fixtures";

const numbered = (count: number, replace: Record<number, string> = {}): string =>
  `${Array.from({ length: count }, (_, index) => replace[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;

const footerRows = (setup: TestRendererSetup): string[] =>
  setup
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.trim())
    .slice(-2);

async function openDiff(setup: TestRendererSetup, app: ScouterApp, directory: string): Promise<void> {
  await app.open(directory);
  await setup.renderOnce();
  setup.mockInput.pressKey("d");
  await waitForText(setup, "line ten edited");
}

async function clickNumber(setup: TestRendererSetup, text: string): Promise<void> {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  await setup.mockMouse.click(rows[y]!.indexOf(text) - 3, y);
}

async function dragNumbers(setup: TestRendererSetup, fromText: string, toText: string): Promise<void> {
  const rows = setup.captureCharFrame().split("\n");
  const fromY = rows.findIndex((row) => row.includes(fromText));
  const toY = rows.findIndex((row) => row.includes(toText));
  const x = rows[fromY]!.indexOf(fromText) - 3;
  await setup.mockMouse.drag(x, fromY, x, toY);
}

async function comment(setup: TestRendererSetup, text: string, line: string): Promise<void> {
  await clickNumber(setup, line);
  await waitForText(setup, "COMMENT");
  await setup.mockInput.typeText(text);
  setup.mockInput.pressEnter();
  await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the comment prompt to close");
}

test("rows follow the unified diff, including removed lines that look like file headers", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -3,4 +3,3 @@ heading",
    " keep",
    "--- not a header",
    "-gone",
    "+added",
    "\\ No newline at end of file",
    " tail",
    "@@ -20 +19,2 @@",
    " x",
    "+y",
    "",
  ].join("\n");
  expect(parseRows(patch)).toEqual([
    { mark: " ", line: 3, text: "keep" },
    { mark: "-", line: 4, text: "-- not a header" },
    { mark: "-", line: 5, text: "gone" },
    { mark: "+", line: 4, text: "added" },
    { mark: " ", line: 5, text: "tail" },
    { mark: " ", line: 19, text: "x" },
    { mark: "+", line: 20, text: "y" },
  ]);
});

test("comments are listed by file and line, counted per path, deleted, and cleared", () => {
  const comments = new ReviewComments();
  const b4 = singleLineTarget("b.ts", { mark: "+", line: 4, text: "const b = 2;" });
  const a9 = singleLineTarget("a.ts", { mark: "-", line: 9, text: "old()" });
  const a2 = singleLineTarget("a.ts", { mark: "+", line: 2, text: "next()" });
  comments.set(b4, "Name this.");
  comments.set(a9, "Why drop this?");
  comments.set(a2, "Add a test.");
  expect(comments.countForPath("a.ts")).toBe(2);
  expect(comments.countForPath("b.ts")).toBe(1);
  expect(comments.exportText()).toBe(
    [
      "Review comments on the working tree changes (3):",
      "a.ts:2\n> + next()\nAdd a test.",
      "a.ts:9 (removed line)\n> - old()\nWhy drop this?",
      "b.ts:4\n> + const b = 2;\nName this.",
    ].join("\n\n"),
  );

  expect(comments.delete(b4)).toBe(true);
  expect(comments.size).toBe(2);

  const rows = [{ mark: "+" as const, line: 2, text: "changed since()" }];
  expect([...comments.markedRows("a.ts", rows).keys()]).toEqual([]);
  expect([...comments.markedRows("a.ts", [{ mark: " ", line: 2, text: "next()" }]).keys()]).toEqual([]);
  expect([...comments.markedRows("a.ts", [{ mark: "+", line: 2, text: "next()" }]).keys()]).toEqual([0]);

  const range = rangeTarget("c.ts", [
    { mark: " ", line: 5, text: "start()" },
    { mark: "+", line: 6, text: "middle()" },
    { mark: "+", line: 7, text: "end()" },
  ])!;
  comments.set(range, "Simplify this block.");
  expect(comments.exportText([comments.get(range)!])).toBe(
    "Review comments on the working tree changes (1):\n\nc.ts:5-7\n>   start()\n> + middle()\n> + end()\nSimplify this block.",
  );
  expect([
    ...comments
      .markedRows("c.ts", [
        { mark: " ", line: 4, text: "before()" },
        { mark: " ", line: 5, text: "start()" },
        { mark: "+", line: 6, text: "middle()" },
        { mark: "+", line: 7, text: "end()" },
      ])
      .keys(),
  ]).toEqual([1, 2, 3]);
  comments.delete(range);

  const shiftedDown = rangeTarget("d.ts", [
    { mark: "-", line: 10, text: "old()" },
    { mark: "+", line: 110, text: "new()" },
  ])!;
  expect(formatLineRange(shiftedDown)).toEqual({ range: "110", removed: false });

  const shiftedUp = rangeTarget("d.ts", [
    { mark: " ", line: 9, text: "keep()" },
    { mark: "-", line: 110, text: "old()" },
  ])!;
  expect(formatLineRange(shiftedUp)).toEqual({ range: "9", removed: false });

  const allRemovedRange = rangeTarget("d.ts", [
    { mark: "-", line: 8, text: "a()" },
    { mark: "-", line: 9, text: "b()" },
  ])!;
  expect(formatLineRange(allRemovedRange)).toEqual({ range: "8-9", removed: true });

  const snapshot = comments.list();
  comments.set(a2, "Edited meanwhile.");
  expect(comments.deleteMatching(snapshot)).toBe(1);
  expect(comments.size).toBe(1);
  expect(comments.get(a2)?.text).toBe("Edited meanwhile.");

  expect(comments.clear()).toBe(1);
  expect(comments.size).toBe(0);
});

test("clicking a line number opens the inline composer directly under the clicked line, and shows presence counts", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer);
    await openDiff(setup, app, directory);
    expect(hasBackground(setup, theme.commentBg)).toBe(false);

    await clickNumber(setup, "line 9");
    await waitForText(setup, "Write a comment…");
    expect(hasBackground(setup, theme.commentBg)).toBe(true);

    await setup.mockInput.typeText("why nine");
    await waitForText(setup, "why nine▎");
    setup.mockInput.pressArrow("left");
    setup.mockInput.pressArrow("left");
    setup.mockInput.pressArrow("left");
    setup.mockInput.pressArrow("left");
    await setup.mockInput.typeText("not ");
    await waitForText(setup, "why not ▎nine");

    const rows = setup.captureCharFrame().split("\n");
    const line = rows.findIndex((row) => row.includes("line 9"));
    expect(rows[line + 1]).toContain("why not ▎nine");
    expect(rows[line + 2]).toContain("a.txt:9");
    expect(rows[line + 2]).toContain("Enter save");

    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");
    const frame = setup.captureCharFrame();
    expect(frame).toContain("line 10");
    expect(frame).toContain("(1)");
    expect(frame).toContain("1 comment");
    expect(hasBackground(setup, theme.commentGutter)).toBe(true);
  }));

test("the comments board lets you inspect, edit, delete, copy, and copy & clear comments", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    const copied: string[] = [];
    await using setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
    await using app = new ScouterApp(setup.renderer, {
      copy: (text) => {
        copied.push(text);
        return true;
      },
    });
    await openDiff(setup, app, directory);
    setup.mockInput.pressTab();
    await waitForText(setup, "click # comment");

    await comment(setup, "keep the old value", "line 10");
    await comment(setup, "use a constant", "line ten edited");
    expect(footerRows(setup)[0]).toContain("2 comments");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (2)");
    expect(setup.captureCharFrame()).toContain("Copy review context");
    expect(setup.captureCharFrame()).toContain("keep the old value");
    expect(setup.captureCharFrame()).toContain("use a constant");

    setup.mockInput.pressKey("y");
    await waitForText(setup, "Copied 2 comments.");
    expect(footerRows(setup)[0]).toContain("2 comments");
    expect(copied.at(-1)).toBe(
      [
        "Review comments on the working tree changes (2):",
        "a.txt:10 (removed line)\n> - line 10\nkeep the old value",
        "a.txt:10\n> + line ten edited\nuse a constant",
      ].join("\n\n"),
    );

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (2)");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("e");
    await waitForText(setup, "use a constant▎");
    await setup.mockInput.typeText(" here");
    setup.mockInput.pressEnter();
    await waitForText(setup, "Comment updated.");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "use a constant here");
    setup.mockInput.pressKey("c");
    await waitForText(setup, "Copied and cleared 2 comments.");
    expect(footerRows(setup)[0]).not.toContain("· 2 comments");
    expect(setup.captureCharFrame()).not.toContain("(2)");
    expect(hasBackground(setup, theme.commentGutter)).toBe(false);
    expect(copied.at(-1)).toContain("use a constant here");
  }));

test("the comments board can delete individual comments, discard all, and flag outdated lines after refresh", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20), "b.txt": "one\n" });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await writeFile(join(directory, "b.txt"), "one\ntwo\n");
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer, { diffPollMs: 40 });
    await openDiff(setup, app, directory);

    await comment(setup, "first note", "line 9");
    await comment(setup, "second note", "line ten edited");

    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten revised again" }));
    await waitForText(setup, "line ten revised again");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (2)");
    expect(setup.captureCharFrame()).toContain("outdated");

    setup.mockInput.pressKey("x");
    await waitForText(setup, "Review Comments (1)");
    expect(setup.captureCharFrame()).not.toContain("first note");

    setup.mockInput.pressKey("X", { shift: true });
    await waitForText(setup, "Discarded 1 comment.");
    expect(footerRows(setup)[0]).not.toContain("· 1 comment");
    expect(setup.captureCharFrame()).not.toContain("(1)");
  }));

test("clicking the code, not the line number, does not start a comment", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer);
    await openDiff(setup, app, directory);
    const rows = setup.captureCharFrame().split("\n");
    const y = rows.findIndex((row) => row.includes("line 9"));
    await setup.mockMouse.click(rows[y]!.indexOf("line 9") + 2, y);
    await setup.renderOnce();
    expect(footerRows(setup)[0]).not.toContain("COMMENT");
  }));

test("Ctrl+U clears the composer, saving empty removes the comment, and Esc leaves it untouched", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer);
    await openDiff(setup, app, directory);

    await comment(setup, "first thought", "line 9");
    await waitForText(setup, "1 comment");

    await clickNumber(setup, "line 9");
    await waitForText(setup, "first thought▎");
    await setup.mockInput.typeText(" and more");
    setup.mockInput.pressEscape();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the prompt to close");
    expect(footerRows(setup)[0]).toContain("1 comment");

    await clickNumber(setup, "line 9");
    await waitForText(setup, "first thought▎");
    setup.mockInput.pressKey("u", { ctrl: true });
    await waitForText(setup, "Write a comment…");
    setup.mockInput.pressEnter();
    await waitForText(setup, "Comment removed.");
    expect(footerRows(setup)[0]).not.toContain("1 comment");
    expect(hasBackground(setup, theme.commentGutter)).toBe(false);
  }));

test("e with no comments explains how to add one, and clicking the footer count opens the board", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer);
    await openDiff(setup, app, directory);

    setup.mockInput.pressKey("e");
    await waitForText(setup, "No comments yet.");

    await comment(setup, "check this", "line 9");
    const rows = setup.captureCharFrame().split("\n");
    const statusY = rows.findIndex((row) => row.includes("1 comment") && row.includes("CHANGES"));
    const x = rows[statusY]!.indexOf("1 comment");
    await setup.mockMouse.click(x + 2, statusY);
    await waitForText(setup, "Review Comments (1)");

    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => !frame.includes("Review Comments (1)"), "the board to close on jump");
    expect(setup.captureCharFrame()).toContain("line 9");
  }));

test("Shift+Enter inserts a newline in the inline composer and preserves it on the board and in copied text", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    const copied: string[] = [];
    await using setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
    await using app = new ScouterApp(setup.renderer, {
      copy: (text) => {
        copied.push(text);
        return true;
      },
    });
    await openDiff(setup, app, directory);

    await clickNumber(setup, "line 9");
    await waitForText(setup, "Write a comment…");
    await setup.mockInput.typeText("first line");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("second line");
    await waitForText(setup, "second line▎");
    const rows = setup.captureCharFrame().split("\n");
    const line = rows.findIndex((row) => row.includes("line 9"));
    expect(rows[line + 1]).toContain("first line");
    expect(rows[line + 2]).toContain("second line▎");

    setup.mockInput.pressArrow("up");
    await setup.mockInput.typeText("!");
    await waitForText(setup, "first line!▎");

    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");
    expect(setup.captureCharFrame()).toContain("first line!");
    expect(setup.captureCharFrame()).toContain("second line");

    setup.mockInput.pressKey("y");
    await waitForText(setup, "Copied 1 comment.");
    expect(copied.at(-1)).toContain("first line!\nsecond line");
  }));

test("editor handles leading newlines at index 0, surrogate pairs, and scrolling past 6 lines", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    const copied: string[] = [];
    await using setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
    await using app = new ScouterApp(setup.renderer, {
      copy: (text) => {
        copied.push(text);
        return true;
      },
    });
    await openDiff(setup, app, directory);

    await clickNumber(setup, "line 9");
    await waitForText(setup, "Write a comment…");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("abc");
    setup.mockInput.pressArrow("up");
    setup.mockInput.pressKey("a", { ctrl: true });
    setup.mockInput.pressKey("u", { ctrl: true });
    await setup.mockInput.typeText("x");
    await waitForText(setup, "x▎");
    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");
    setup.mockInput.pressKey("y");
    await waitForText(setup, "Copied 1 comment.");
    expect(copied.at(-1)).toContain("x\nabc");

    await clickNumber(setup, "line 9");
    await waitForText(setup, "abc▎");
    setup.mockInput.pressKey("u", { ctrl: true });
    setup.mockInput.pressKey("u", { ctrl: true });
    setup.mockInput.pressKey("u", { ctrl: true });
    await waitForText(setup, "Write a comment…");
    await setup.mockInput.pasteBracketedText("a🚀b");
    await waitForText(setup, "a🚀b▎");
    setup.mockInput.pressArrow("left");
    setup.mockInput.pressBackspace();
    await waitForText(setup, "a▎b");
    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");
    setup.mockInput.pressKey("y");
    await waitForText(setup, "Copied 1 comment.");
    expect(copied.at(-1)).toContain("\nab");

    await clickNumber(setup, "line 9");
    await waitForText(setup, "ab▎");
    await setup.mockInput.pasteBracketedText("\nrow 1\nrow 2\nrow 3\nrow 4\nrow 5\nrow 6\nrow 7\nrow 8");
    await waitForText(setup, "row 8▎");
    expect(setup.captureCharFrame()).toContain("row 8▎");
    setup.mockInput.pressEscape();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");
  }));

test("editing a valid comment in wrap mode does not flag it outdated, and clean poll cancels an open composer", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer, { diffPollMs: 40 });
    await openDiff(setup, app, directory);

    await comment(setup, "valid note", "line 9");
    setup.mockInput.pressKey("w");
    await waitForText(setup, " wrap ");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");
    setup.mockInput.pressKey("e");
    await waitForText(setup, "valid note▎");
    expect(setup.captureCharFrame()).not.toContain("outdated");

    await writeFile(join(directory, "a.txt"), numbered(20));
    await waitForText(setup, "No changes");
    expect(footerRows(setup)[0]).not.toContain("COMMENT");
  }));

test("async copy & clear ignores duplicate presses and preserves comments added while copying", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    const copied: string[] = [];
    let releaseCopy!: () => void;
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer, {
      copy: (text) =>
        new Promise<boolean>((resolve) => {
          copied.push(text);
          releaseCopy = () => resolve(true);
        }),
    });
    await openDiff(setup, app, directory);

    await comment(setup, "first note", "line 9");
    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");

    setup.mockInput.pressKey("c");
    setup.mockInput.pressKey("c");
    await setup.renderOnce();
    expect(copied).toHaveLength(1);

    setup.mockInput.pressEscape();
    await waitForFrame(setup, (frame) => !frame.includes("Review Comments (1)"), "the board to close");
    await comment(setup, "second note", "line ten edited");

    releaseCopy();
    await waitForText(setup, "Copied and cleared 1 comment.");
    expect(footerRows(setup)[0]).toContain("1 comment");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");
    expect(setup.captureCharFrame()).toContain("second note");
    expect(setup.captureCharFrame()).not.toContain("first note");
  }));

test("clicking the footer count while help is open closes help instead of stacking overlays", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer);
    await openDiff(setup, app, directory);

    await comment(setup, "note", "line 9");
    setup.mockInput.pressKey("?");
    await waitForText(setup, "Keyboard Shortcuts");

    const rows = setup.captureCharFrame().split("\n");
    const statusY = rows.findIndex((row) => row.includes("1 comment"));
    await setup.mockMouse.click(rows[statusY]!.indexOf("1 comment") + 2, statusY);
    await waitForText(setup, "Review Comments (1)");

    setup.mockInput.pressEscape();
    await waitForFrame(setup, (frame) => !frame.includes("Review Comments (1)"), "the board to close");
    expect(setup.captureCharFrame()).not.toContain("Keyboard Shortcuts");
  }));

test("dragging across line numbers creates a range comment, clicking inside reopens it, and exporting quotes every line", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    const copied: string[] = [];
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer, {
      copy: (text) => {
        copied.push(text);
        return true;
      },
    });
    await openDiff(setup, app, directory);

    await dragNumbers(setup, "line 11", "line 9");
    await waitForText(setup, "a.txt:9-11");
    await setup.mockInput.typeText("extract this block");
    await waitForText(setup, "extract this block▎");
    const rows = setup.captureCharFrame().split("\n");
    const endLine = rows.findIndex((row) => row.includes("line 11"));
    expect(rows[endLine + 1]).toContain("extract this block▎");

    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");

    await clickNumber(setup, "line ten edited");
    await waitForText(setup, "extract this block▎");
    expect(setup.captureCharFrame()).toContain("a.txt:9-11");
    setup.mockInput.pressEscape();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");

    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");
    const boardFrame = setup.captureCharFrame();
    expect(boardFrame).toContain("a.txt:9-11");
    expect(boardFrame).toContain("+2 more lines");
    expect(boardFrame).toContain("extract this block");

    setup.mockInput.pressKey("y");
    await waitForText(setup, "Copied 1 comment.");
    expect(copied.at(-1)).toBe(
      [
        "Review comments on the working tree changes (1):",
        "a.txt:9-11\n>   line 9\n> - line 10\n> + line ten edited\n>   line 11\nextract this block",
      ].join("\n\n"),
    );
  }));

test("clicking a revised line with an outdated comment starts a fresh inline comment, and stale gutter drags reset", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    const copied: string[] = [];
    await using setup = await createTestRenderer({ width: 100, height: 24 });
    await using app = new ScouterApp(setup.renderer, {
      diffPollMs: 40,
      copy: (text) => {
        copied.push(text);
        return true;
      },
    });
    await openDiff(setup, app, directory);

    await comment(setup, "old feedback", "line ten edited");
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten revised" }));
    await waitForText(setup, "line ten revised");

    await clickNumber(setup, "line ten revised");
    await waitForText(setup, "Write a comment…");
    expect(setup.captureCharFrame()).not.toContain("outdated");
    const openRows = setup.captureCharFrame().split("\n");
    const revisedRow = openRows.findIndex((row) => row.includes("line ten revised"));
    expect(openRows[revisedRow + 1]).toContain("Write a comment…");

    setup.mockInput.pressEnter();
    await waitForFrame(setup, (frame) => !frame.includes("COMMENT"), "the composer to close");
    expect(footerRows(setup)[0]).toContain("1 comment");

    await comment(setup, "new feedback", "line ten revised");
    setup.mockInput.pressKey("e");
    await waitForText(setup, "Review Comments (1)");
    expect(setup.captureCharFrame()).not.toContain("outdated");
    expect(setup.captureCharFrame()).toContain("new feedback");
    setup.mockInput.pressKey("y");
    await waitForText(setup, "Copied 1 comment.");
    expect(copied.at(-1)).toContain("> + line ten revised\nnew feedback");

    const diffRows = setup.captureCharFrame().split("\n");
    const y9 = diffRows.findIndex((row) => row.includes("line 9"));
    await setup.mockMouse.pressDown(diffRows[y9]!.indexOf("line 9") - 3, y9);
    await setup.renderOnce();
    await setup.mockMouse.click(diffRows[y9]!.indexOf("line 9") + 2, y9);
    await setup.renderOnce();
    expect(footerRows(setup)[0]).not.toContain("COMMENT");
  }));

test("in split view clicking a line number explains why it cannot comment", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { "a.txt": numbered(20) });
    await writeFile(join(directory, "a.txt"), numbered(20, { 10: "line ten edited" }));
    await using setup = await createTestRenderer({ width: 120, height: 24 });
    await using app = new ScouterApp(setup.renderer);
    await openDiff(setup, app, directory);
    setup.mockInput.pressKey("s");
    await waitForText(setup, " split ");
    await clickNumber(setup, "line 9");
    await waitForText(setup, "Comments need the unified view without wrap.");
  }));
