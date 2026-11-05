import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ScouterApp } from "../src/app";
import { openRepository, listIgnored } from "../src/git";
import { createRepository, waitForFrame, waitForText, withDirectory } from "./fixtures";

const FAST_POLL = { browsePollMs: 40 };

/** The red channel of the first rendered text containing `text`: higher is brighter. */
function brightness(setup: TestRendererSetup, text: string): number {
  const span = setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  if (!span) throw new Error(`No span containing ${text}.`);
  return span.fg.buffer[0] ?? 0;
}

test("files that appear or disappear on disk show up in the list without reopening", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "old.txt"), "old\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(directory);
    await waitForText(setup, "old.txt");

    await writeFile(join(directory, "new.txt"), "new\n");
    await rm(join(directory, "old.txt"));
    await waitForText(setup, "new.txt");
    await waitForFrame(setup, (frame) => !frame.includes("old.txt"), "old.txt to leave the list");
  }));

test("an open file is read again once it is saved, and the reader keeps its place", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "log.txt");
    await writeFile(path, Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n"));
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(path);
    await setup.renderOnce();
    setup.mockInput.pressKey("G");
    await waitForText(setup, "Bot");

    await writeFile(
      path,
      `${Array.from({ length: 79 }, (_, index) => `line ${index + 1}`).join("\n")}\nsaved at last\n`,
    );
    await waitForText(setup, "saved at last");
    expect(setup.captureCharFrame()).toContain("Bot");
  }));

test("a file deleted while it is open stays on screen with a notice", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "gone.txt");
    await writeFile(path, "still here\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(path);
    await waitForText(setup, "1  still here");
    await rm(path);
    await waitForText(setup, "gone.txt is no longer on disk.");
    expect(setup.captureCharFrame()).toContain("1  still here");
  }));

test("changed files, folders holding them, and ignored entries are marked in the list", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, {
      ".gitignore": "*.log\nbuild/\n",
      "keep.txt": "keep\n",
      "src/a.txt": "a\n",
    });
    await writeFile(join(directory, "src", "a.txt"), "a changed\n");
    await writeFile(join(directory, "debug.log"), "noise\n");
    await mkdir(join(directory, "build"));
    await writeFile(join(directory, "build", "out.txt"), "output\n");
    await using setup = await createTestRenderer({ width: 90, height: 16 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(directory);
    await waitForText(setup, "src/");
    await waitForFrame(setup, (frame) => /src\/\s+•/.test(frame), "the folder with a change to be marked");

    // Rows are: the root, build/, src/, then the files. Open src/ and look at its changed file.
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("l");
    await waitForFrame(setup, (frame) => /a\.txt\s+M/.test(frame), "a.txt marked as modified");
    expect(brightness(setup, "build/")).toBeLessThan(brightness(setup, "keep.txt"));
  }));

test("- makes the folder above the root and keeps the old root open in it", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "outer", "inner"), { recursive: true });
    await writeFile(join(directory, "outer", "inner", "deep.txt"), "deep\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer, FAST_POLL);
    await app.open(join(directory, "outer", "inner"));
    await waitForText(setup, "deep.txt");
    setup.mockInput.pressKey("-");
    await waitForText(setup, "outer/");
    expect(setup.captureCharFrame()).toContain("inner/");
    expect(setup.captureCharFrame()).toContain("deep.txt");
  }));

test("git's ignored list names folders once and includes ignored files", () =>
  withDirectory(async (directory) => {
    await createRepository(directory, { ".gitignore": "*.log\nbuild/\n", "keep.txt": "keep\n" });
    await mkdir(join(directory, "build"));
    await writeFile(join(directory, "build", "out.txt"), "output\n");
    await writeFile(join(directory, "debug.log"), "noise\n");
    expect((await listIgnored(await openRepository(directory))).toSorted()).toEqual(["build/", "debug.log"]);
  }));
