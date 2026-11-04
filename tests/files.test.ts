import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDirectory, readDocument } from "../src/files";
import { withDirectory } from "./fixtures";

test("lists directories before files, including hidden files and links", () => withDirectory(async (directory) => {
  await mkdir(join(directory, "z-folder"));
  await writeFile(join(directory, "b.txt"), "text");
  await writeFile(join(directory, ".hidden"), "hidden");
  await symlink(join(directory, "b.txt"), join(directory, "c-link"));
  const entries = await readDirectory(directory);
  expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([
    ["z-folder", "directory"], [".hidden", "file"], ["b.txt", "file"], ["c-link", "link"],
  ]);
  expect(entries[0]?.path).toBe(join(directory, "z-folder"));
}));

test("reads UTF-8 without changing source bytes and normalizes display-only characters", () => withDirectory(async (directory) => {
  const path = join(directory, "unicode.txt");
  const source = "hello\r\n\t世界\u001b[31m\rfinish\u009b\u202e\n";
  await writeFile(path, source);
  expect(await readDocument(path)).toEqual({ path, text: "hello\n    世界�[31m\nfinish��\n", lineCount: 3 });
  expect(await readFile(path, "utf8")).toBe(source);
}));

test.each([
  ["", 0], ["one", 1], ["one\n", 1], ["one\n\n", 2], ["\n", 1],
])("counts logical lines for %j", (text, lineCount) => withDirectory(async (directory) => {
  const path = join(directory, "lines.txt");
  await writeFile(path, text);
  expect((await readDocument(path)).lineCount).toBe(lineCount);
}));

test.each([
  ["binary", Buffer.from([65, 0, 66]), "Binary files"],
  ["invalid UTF-8", Buffer.from([0xff, 0xfe]), "Only UTF-8"],
  ["oversized", Buffer.alloc(1024 * 1024 + 1, 65), "File is too large"],
])("rejects %s files", (_name, bytes, error) => withDirectory(async (directory) => {
  const path = join(directory, "unsupported");
  await writeFile(path, bytes);
  await expect(readDocument(path)).rejects.toThrow(error);
}));

test("rejects directories and reports missing paths", () => withDirectory(async (directory) => {
  await expect(readDocument(directory)).rejects.toThrow("Only regular text files");
  await expect(readDirectory(join(directory, "missing"))).rejects.toThrow("ENOENT");
}));

test("follows a file symlink for read-only viewing", () => withDirectory(async (directory) => {
  const path = join(directory, "link");
  await writeFile(join(directory, "target.txt"), "linked text");
  await symlink(join(directory, "target.txt"), path);
  expect((await readDocument(path)).text).toBe("linked text");
}));
