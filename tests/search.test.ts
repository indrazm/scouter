import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { indexTree, matchEntries, type IndexedEntry } from "../src/search";
import { withDirectory } from "./fixtures";

const entry = (relative: string, kind: IndexedEntry["kind"] = "file"): IndexedEntry => ({
  path: `/root/${relative}`,
  relative,
  kind,
});

test("a query matches paths containing every word, ignoring case, with file names first", () => {
  const entries = [
    entry("docs/guide-to-search.md"),
    entry("src/Search.ts"),
    entry("src/search/index.ts"),
    entry("src/other.ts"),
  ];
  const { matches, total } = matchEntries(entries, "SEARCH");
  expect(total).toBe(3);
  // "Search.ts" and "guide-to-search.md" name the query; "index.ts" only has it in a folder, so it comes last.
  expect(matches.map((match) => match.relative)).toEqual([
    "src/Search.ts",
    "docs/guide-to-search.md",
    "src/search/index.ts",
  ]);
  expect(matchEntries(entries, "search ts").matches.map((match) => match.relative)).toEqual([
    "src/Search.ts",
    "src/search/index.ts",
  ]);
  expect(matchEntries(entries, "   ")).toEqual({ matches: [], total: 0 });
});

test("indexing skips what it is told to and stops at the limit", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "ignored"));
    await writeFile(join(directory, "src", "a.txt"), "a");
    await writeFile(join(directory, "ignored", "b.txt"), "b");
    await writeFile(join(directory, "c.txt"), "c");
    const skipped = join(directory, "ignored");
    const everything = await indexTree(directory, (path) => path === skipped);
    expect(everything.truncated).toBe(false);
    expect(everything.entries.map((found) => found.relative).toSorted()).toEqual(["c.txt", "src", "src/a.txt"]);
    const limited = await indexTree(directory, () => false, 2);
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.entries).toHaveLength(2);
  }));
