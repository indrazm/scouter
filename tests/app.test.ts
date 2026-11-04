import { expect, test } from "bun:test";
import { BoxRenderable, CodeRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScouterApp } from "../src/app";
import { withDirectory } from "./fixtures";

test("opens files from the browser, switches panes, and ignores editing input", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "hello.txt");
    await writeFile(path, "first line\nsecond line\n");
    await using setup = await createTestRenderer({ width: 100, height: 20, kittyKeyboard: true });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Select a file");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("1  first line"));
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");
    expect(setup.captureCharFrame()).toContain("2  second line");
    await setup.mockInput.typeText("iabc");
    setup.mockInput.pasteBracketedText("overwrite this file");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1  first line");
    expect(await readFile(path, "utf8")).toBe("first line\nsecond line\n");
    setup.mockInput.pressTab();
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("browser");
    setup.mockInput.pressTab();
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");
    setup.mockInput.pressEscape();
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("browser");
  }));

test("expands folders in place and collapses them without losing siblings or the document", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "inside.txt"), "inside");
    await writeFile(join(directory, "sibling.txt"), "sibling");
    await using setup = await createTestRenderer({ width: 100, height: 20 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("l");
    await setup.waitForFrame((frame) => frame.includes("inside.txt"));
    expect(setup.captureCharFrame()).toContain("▾ \uf07c nested/");
    expect(setup.captureCharFrame()).toContain("sibling.txt");
    setup.mockInput.pressKey("l");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("1  inside"));
    setup.mockInput.pressTab();
    setup.mockInput.pressKey("h");
    setup.mockInput.pressKey("h");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("▸ \uf07b nested/");
    expect(setup.captureCharFrame()).not.toContain("\uf016 inside.txt");
    expect(setup.captureCharFrame()).toContain("sibling.txt");
    expect(setup.captureCharFrame()).toContain("1  inside");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("▾ \uf07c nested/"));
    expect(setup.captureCharFrame()).toContain("▾ \uf07c nested/");
    expect(setup.captureCharFrame()).toContain("\uf016 inside.txt");
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("▸ \uf07b nested/");
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("browser");
  }));

test("scrolls single lines and jumps to the bottom without double-handling arrows", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "long.txt");
    await writeFile(path, Array.from({ length: 80 }, (_, index) => `content-${index + 1}`).join("\n"));
    await using setup = await createTestRenderer({ width: 100, height: 15 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1  content-1");
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("1  content-1 ");
    expect(setup.captureCharFrame()).toContain("2  content-2");
    setup.mockInput.pressKey("G");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("80  content-80");
    setup.mockInput.pressKey("g");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1  content-1");
  }));

test("keeps the last document when a file cannot be opened and survives resizing", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "good.txt"), "readable content");
    await writeFile(join(directory, "binary"), Buffer.from([0, 1, 2]));
    await using setup = await createTestRenderer({ width: 100, height: 20 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "good.txt"));
    await app.open(join(directory, "binary"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Binary files are not supported");
    expect(setup.captureCharFrame()).toContain("readable content");
    setup.resize(60, 10);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("readable content");
    setup.mockInput.pressKey("q");
    await setup.renderer.closed;
    expect(setup.renderer.isDestroyed).toBe(true);
  }));

test.each([
  ["example.TS", 'const greeting: string = "hello";\n'],
  ["example.js", 'const greeting = "hello";\n'],
  ["example.tsx", 'const greeting = <span title="hello" />;\n'],
  ["example.jsx", 'const greeting = <span title="hello" />;\n'],
  ["example.zig", 'const greeting = "hello";\n'],
])("highlights %s with real bundled parsers while preserving source text", (name, source) =>
  withDirectory(async (directory) => {
    const path = join(directory, name);
    await writeFile(path, source);
    await using setup = await createTestRenderer({ width: 120, height: 15 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(path);
    await setup.renderOnce();
    const code = setup.renderer.root.findDescendantById("document");
    if (!(code instanceof CodeRenderable)) throw new Error("No source view mounted.");
    await code.highlightingDone;
    await setup.renderOnce();
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    expect(
      spans.some((span) => span.text.includes("const") && span.fg.toInts().slice(0, 3).join(",") === "199,146,234"),
    ).toBe(true);
    expect(
      spans.some((span) => span.text.includes("hello") && span.fg.toInts().slice(0, 3).join(",") === "167,199,161"),
    ).toBe(true);
    expect(setup.captureCharFrame()).toContain(`1  ${source.trimEnd()}`);
    expect(await readFile(path, "utf8")).toBe(source);
  }),
);

test("preserves Markdown markup and resets highlighting and line numbers for plain and empty files", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "readme.md"), "# Heading\n\n**bold**\n");
    await writeFile(join(directory, "unknown.xyz"), 'const plain = "untouched";\n');
    await writeFile(join(directory, "empty.txt"), "");
    await using setup = await createTestRenderer({ width: 120, height: 15 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "readme.md"));
    await setup.renderOnce();
    const code = setup.renderer.root.findDescendantById("document");
    if (!(code instanceof CodeRenderable)) throw new Error("No source view mounted.");
    await code.highlightingDone;
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1  # Heading");
    expect(setup.captureCharFrame()).toContain("3  **bold**");
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => span.text.includes("Heading") && span.fg.toInts().slice(0, 3).join(",") === "130,170,255"),
    ).toBe(true);
    await app.open(join(directory, "unknown.xyz"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('1  const plain = "untouched";');
    const sourceSpans = setup.captureSpans().lines[1]?.spans ?? [];
    expect(
      sourceSpans.some(
        (span) => span.text.includes("const plain") && span.fg.toInts().slice(0, 3).join(",") === "212,216,222",
      ),
    ).toBe(true);
    expect(setup.captureCharFrame()).not.toContain("Heading");
    await app.open(join(directory, "empty.txt"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("(empty file)");
    expect(setup.captureCharFrame()).not.toContain("1  (empty file)");
    expect(setup.captureCharFrame()).not.toContain("untouched");
  }));

test("rejects directory symlink cycles and keeps the tree usable", () =>
  withDirectory(async (directory) => {
    await symlink(directory, join(directory, "loop"));
    await writeFile(join(directory, "safe.txt"), "still readable");
    await using setup = await createTestRenderer({ width: 120, height: 15 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await app.open(join(directory, "loop"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Cannot expand a symbolic-link loop");
    expect(setup.captureCharFrame()).toContain("safe.txt");
    await app.open(join(directory, "safe.txt"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1  still readable");
  }));

test("w toggles word wrap in either pane, keeping content inside the viewport", () =>
  withDirectory(async (directory) => {
    const words = Array.from({ length: 20 }, (_, index) => `word${String(index).padStart(2, "0")}`).join(" ");
    await writeFile(join(directory, "long.txt"), `${words}\nshort\n`);
    await using setup = await createTestRenderer({ width: 80, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "long.txt"));
    await setup.renderOnce();
    const viewer = setup.renderer.root.findDescendantById("viewer");
    if (!(viewer instanceof ScrollBoxRenderable)) throw new Error("No viewer mounted.");
    expect(setup.captureCharFrame()).not.toContain("word19");

    setup.mockInput.pressKey("w");
    await setup.renderOnce();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("word19");
    expect(setup.captureCharFrame().split("\n")[0]).toContain(" wrap ");
    expect(viewer.scrollWidth).toBe(viewer.viewport.width);
    expect(setup.captureCharFrame()).toContain("2  short");

    setup.mockInput.pressTab();
    setup.mockInput.pressKey("w");
    await setup.renderOnce();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("word19");
    expect(setup.captureCharFrame().split("\n")[0]).not.toContain(" wrap ");
    expect(viewer.scrollWidth).toBeGreaterThan(viewer.viewport.width);
  }));

const footerRows = (setup: { captureCharFrame(): string }): [status: string, hints: string] => {
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .filter((row) => row.trim());
  return [rows.at(-2) ?? "", rows.at(-1) ?? ""];
};

test("footer follows the active pane and reports file facts and scroll position", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "tall.txt"), Array.from({ length: 60 }, (_, index) => `row ${index}`).join("\n"));
    await using setup = await createTestRenderer({ width: 100, height: 16 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "tall.txt"));
    await setup.renderOnce();
    await setup.renderOnce();
    let [status, hints] = footerRows(setup);
    expect(status).toContain("READER");
    expect(status).toContain("tall.txt");
    expect(status).toContain("60 lines");
    expect(status).toContain("UTF-8");
    expect(status).toMatch(/Top\s*$/);
    expect(hints).toContain("scroll");

    setup.mockInput.pressKey("g", { shift: true });
    await setup.renderOnce();
    expect(footerRows(setup)[0]).toMatch(/Bot\s*$/);
    setup.mockInput.pressKey("g");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    expect(footerRows(setup)[0]).toMatch(/\d+%\s*$/);

    setup.mockInput.pressTab();
    await setup.renderOnce();
    [status, hints] = footerRows(setup);
    expect(status).toContain("FILES");
    expect(status).toContain("tall.txt");
    expect(hints).toContain("Enter open");
  }));

test("footer shows errors without losing the open file, and drops facts before the path on narrow terminals", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "note.txt"), "hello\n");
    await using setup = await createTestRenderer({ width: 50, height: 12 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "note.txt"));
    await setup.renderOnce();
    await setup.renderOnce();
    const [narrow] = footerRows(setup);
    expect(narrow).toContain("note.txt");
    expect(narrow).not.toContain("UTF-8");
    expect(narrow).toMatch(/All\s*$/);

    await app.open(join(directory, "missing.txt"));
    await setup.renderOnce();
    expect(footerRows(setup)[0]).toContain("ENOENT");
    expect(setup.captureCharFrame()).toContain("1  hello");
  }));

test("the pane without focus is dimmed, but the welcome screen is not", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "alpha.txt"), "alpha content\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(directory);
    await setup.renderOnce();
    const brightness = (text: string, row?: number): number => {
      const lines = setup.captureSpans().lines;
      const span = (row === undefined ? lines : lines.slice(row, row + 1))
        .flatMap((line) => line.spans)
        .find((candidate) => candidate.text.includes(text));
      if (!span) throw new Error(`No span containing ${text}.`);
      return span.fg.buffer[0] ?? 0;
    };
    const welcomeBrightness = brightness("Select a file");
    // Its text is a light indigo (red channel ~199); a 50% dim would pull it below 110.
    expect(welcomeBrightness).toBeGreaterThan(150);

    setup.mockInput.pressKey("j");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("1  alpha content"));
    await setup.renderOnce();
    const sidebarDimmed = brightness("alpha.txt", 1);
    const readerActive = brightness("alpha content", 1);

    setup.mockInput.pressTab();
    await setup.renderOnce();
    expect(brightness("alpha.txt", 1)).toBeGreaterThan(sidebarDimmed);
    expect(brightness("alpha content", 1)).toBeLessThan(readerActive);
  }));

/** Left-clicks the first sidebar row whose text contains `name`. */
async function clickRow(setup: Awaited<ReturnType<typeof createTestRenderer>>, name: string): Promise<void> {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.slice(0, 40).includes(name));
  if (y < 0) throw new Error(`No sidebar row for ${name}.`);
  await setup.mockMouse.click(lines[y]!.indexOf(name) + 1, y);
}

test("clicking a file from the reader opens it without flashing the panes' opacity", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "a.txt"), "alpha\n");
    await writeFile(join(directory, "b.txt"), "beta\n");
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "a.txt"));
    await setup.renderOnce();
    await setup.renderOnce();
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");

    // Pulsing either pane on the way (sidebar bright, reader dim, then back) reads as a flash in a real terminal.
    const writes: string[] = [];
    for (const id of ["browser-panel", "viewer-panel"]) {
      const panel = setup.renderer.root.findDescendantById(id);
      if (!(panel instanceof BoxRenderable)) throw new Error(`No ${id}.`);
      let opacity = panel.opacity;
      Object.defineProperty(panel, "opacity", {
        configurable: true,
        get: () => opacity,
        set: (value: number) => {
          if (value !== opacity) writes.push(`${id} -> ${value}`);
          opacity = value;
        },
      });
    }
    await clickRow(setup, "b.txt");
    await setup.waitForFrame((frame) => frame.includes("1  beta"));
    await setup.renderOnce();
    expect(writes).toEqual([]);
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");
  }));

test("clicking folders keeps the sidebar focused, and a file that cannot open returns focus to it", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "folder"));
    await writeFile(join(directory, "folder", "inside.txt"), "inside\n");
    await writeFile(join(directory, "text.txt"), "text\n");
    await writeFile(join(directory, "zzz.bin"), Buffer.from([0, 1, 2, 3]));
    await using setup = await createTestRenderer({ width: 90, height: 14 });
    await using app = new ScouterApp(setup.renderer);
    await app.open(join(directory, "text.txt"));
    await setup.renderOnce();
    await setup.renderOnce();
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");

    await clickRow(setup, "folder/");
    await setup.waitForFrame((frame) => frame.includes("inside.txt"));
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("browser");

    await clickRow(setup, "folder/");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("inside.txt");
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("browser");

    setup.mockInput.pressTab();
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("viewer");
    await clickRow(setup, "zzz.bin");
    await setup.waitForFrame((frame) => frame.includes("Binary files are not supported"));
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("browser");
    expect(setup.captureCharFrame()).toContain("1  text");
  }));
