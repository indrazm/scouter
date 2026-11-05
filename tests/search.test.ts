import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_TEXT_HITS,
  indexTree,
  matchEntries,
  searchText,
  type IndexedEntry,
  type TextProgress,
} from "../src/search";
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

/** Runs a text search to the end and returns its last report. */
async function finalSearch(entries: IndexedEntry[], query: string): Promise<TextProgress> {
  let last: TextProgress | undefined;
  await searchText(entries, query, (progress) => {
    last = progress;
    return true;
  });
  if (!last?.done) throw new Error("The search never finished.");
  return last;
}

const filesIn = async (directory: string, names: string[]): Promise<IndexedEntry[]> =>
  (await indexTree(directory, () => false)).entries.filter((found) => names.includes(found.relative));

test("text search finds lines containing the query, ignoring case, with their line numbers and the match marked", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "a.ts"), "one\n    const Needle = 1;\nthree\n");
    await writeFile(join(directory, "b.txt"), "no match here\nneedle again\n");
    const result = await finalSearch((await indexTree(directory, () => false)).entries, "NEEDLE");
    expect(result.files).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => [hit.relative, hit.line, hit.text]).toSorted()).toEqual([
      ["b.txt", 2, "needle again"],
      ["src/a.ts", 2, "const Needle = 1;"],
    ]);
    const first = result.hits.find((hit) => hit.relative === "src/a.ts");
    expect(first?.text.slice(first.at, first.at + first.length)).toBe("Needle");
  }));

test("text search skips binary files, folders and symbolic links, and says how many files it read", () =>
  withDirectory(async (directory) => {
    await mkdir(join(directory, "folder-with-needle-in-its-name"));
    await writeFile(join(directory, "binary.dat"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
    await writeFile(join(directory, "text.txt"), "a needle\n");
    await symlink(join(directory, "text.txt"), join(directory, "link.txt"));
    const result = await finalSearch((await indexTree(directory, () => false)).entries, "needle");
    expect(result.hits.map((hit) => hit.relative)).toEqual(["text.txt"]);
    expect(result.total).toBe(2);
    expect(result.scanned).toBe(2);
  }));

test("text search lists a few lines per file and stops at the overall limit, saying the list is cut", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "noisy.txt"), "needle\n".repeat(50));
    await writeFile(join(directory, "quiet.txt"), "needle\n");
    const result = await finalSearch(await filesIn(directory, ["noisy.txt", "quiet.txt"]), "needle");
    expect(result.hits.filter((hit) => hit.relative === "noisy.txt")).toHaveLength(10);
    expect(result.hits.filter((hit) => hit.relative === "quiet.txt")).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.done).toBe(true);

    await Promise.all(
      Array.from({ length: 30 }, (_, index) => writeFile(join(directory, `many-${index}.txt`), "needle\n".repeat(10))),
    );
    const capped = await finalSearch((await indexTree(directory, () => false)).entries, "needle");
    expect(capped.hits).toHaveLength(MAX_TEXT_HITS);
    expect(capped.truncated).toBe(true);
  }));

test("a search whose progress callback returns false stops without a final report", () =>
  withDirectory(async (directory) => {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => writeFile(join(directory, `f${index}.txt`), "needle\n")),
    );
    const reports: boolean[] = [];
    await searchText((await indexTree(directory, () => false)).entries, "needle", (progress) => {
      reports.push(progress.done);
      return false;
    });
    expect(reports).toEqual([false]);
  }));

test("a long line is cut around the match so the match stays visible", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "long.txt"), `${"x".repeat(500)}needle${"y".repeat(500)}\n`);
    const [hit] = (await finalSearch((await indexTree(directory, () => false)).entries, "needle")).hits;
    expect(hit?.text.length).toBeLessThanOrEqual(300);
    expect(hit?.text.slice(hit.at, hit.at + hit.length)).toBe("needle");
  }));
