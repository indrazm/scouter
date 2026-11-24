import { relative } from "node:path";
import { readDirectory, readDocument, type DirectoryEntry } from "./files";

export const MAX_INDEXED_ENTRIES = 20_000;
export const MAX_MATCHES = 200;

export interface IndexedEntry {
  path: string;
  relative: string;
  kind: DirectoryEntry["kind"];
}

export async function indexTree(
  root: string,
  skip: (path: string) => boolean,
  limit = MAX_INDEXED_ENTRIES,
): Promise<{ entries: IndexedEntry[]; truncated: boolean }> {
  const entries: IndexedEntry[] = [];
  let level = [root];
  while (level.length) {
    // oxlint-disable-next-line no-await-in-loop
    const listings = await Promise.all(level.map((folder) => readDirectory(folder).catch(() => [])));
    const next: string[] = [];
    for (const children of listings) {
      for (const child of children) {
        if (skip(child.path)) continue;

        if (entries.length >= limit) return { entries, truncated: true };

        entries.push({ path: child.path, relative: relative(root, child.path), kind: child.kind });

        if (child.kind === "directory") next.push(child.path);
      }
    }
    level = next;
  }
  return { entries, truncated: false };
}

export function matchEntries(entries: IndexedEntry[], query: string): { matches: IndexedEntry[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (!words.length) return { matches: [], total: 0 };

  const [first = ""] = words;
  const matching = entries.filter((entry) => {
    const path = entry.relative.toLowerCase();
    return words.every((word) => path.includes(word));
  });
  const rank = (entry: IndexedEntry): number => {
    const name = entry.relative.slice(entry.relative.lastIndexOf("/") + 1).toLowerCase();
    return name.includes(first) ? 0 : 1;
  };
  matching.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.relative.length - right.relative.length ||
      (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0),
  );
  return { matches: matching.slice(0, MAX_MATCHES), total: matching.length };
}

export const MAX_TEXT_HITS = 200;
const MAX_HITS_PER_FILE = 10;
const MAX_SCANNED_CHARS = 64 * 1024 * 1024;
const READ_BATCH = 16;
const REPORT_INTERVAL_MS = 120;
const SNIPPET_LEAD = 40;
const SNIPPET_LENGTH = 300;

export interface TextHit {
  path: string;
  relative: string;
  line: number;
  text: string;
  at: number;
  length: number;
}

export interface TextProgress {
  hits: TextHit[];
  files: number;
  scanned: number;
  total: number;
  truncated: boolean;
  done: boolean;
}

function snippetOf(line: string, index: number, length: number): Pick<TextHit, "text" | "at" | "length"> {
  const indent = line.length - line.trimStart().length;
  const from = index > SNIPPET_LEAD ? index - SNIPPET_LEAD : Math.min(indent, index);
  return { text: line.slice(from, from + SNIPPET_LENGTH), at: index - from, length };
}

function hitsIn(entry: IndexedEntry, text: string, needle: string, limit: number): { hits: TextHit[]; more: boolean } {
  const lower = text.toLowerCase();

  if (!lower.includes(needle)) return { hits: [], more: false };

  const lines = text.split("\n");
  const lowerLines = lower.split("\n");
  const hits: TextHit[] = [];
  for (const [index, line] of lowerLines.entries()) {
    const at = line.indexOf(needle);

    if (at < 0) continue;

    if (hits.length >= limit) return { hits, more: true };

    hits.push({
      path: entry.path,
      relative: entry.relative,
      line: index + 1,
      ...snippetOf(lines[index] ?? "", at, needle.length),
    });
  }
  return { hits, more: false };
}

export async function searchText(
  entries: IndexedEntry[],
  query: string,
  onProgress: (progress: TextProgress) => boolean,
): Promise<void> {
  const needle = query.toLowerCase();
  const files = entries.filter((entry) => entry.kind === "file");
  const hits: TextHit[] = [];
  const found = new Set<string>();
  let scanned = 0;
  let characters = 0;
  let hidden = false;
  let stopped = false;
  let reported = 0;
  for (let start = 0; start < files.length && !stopped; start += READ_BATCH) {
    const batch = files.slice(start, start + READ_BATCH);
    // oxlint-disable-next-line no-await-in-loop
    const documents = await Promise.all(batch.map((entry) => readDocument(entry.path).catch(() => undefined)));
    for (const [index, entry] of batch.entries()) {
      const document = documents[index];
      scanned += 1;

      if (!document || stopped) continue;

      characters += document.text.length;
      const room = Math.min(MAX_HITS_PER_FILE, MAX_TEXT_HITS - hits.length);
      const inFile = hitsIn(entry, document.text, needle, room);

      if (inFile.hits.length) found.add(entry.path);

      hits.push(...inFile.hits);
      hidden ||= inFile.more;
      stopped = hits.length >= MAX_TEXT_HITS || characters > MAX_SCANNED_CHARS;
    }

    if (Date.now() - reported < REPORT_INTERVAL_MS) continue;

    reported = Date.now();
    const progress = {
      hits,
      files: found.size,
      scanned,
      total: files.length,
      truncated: hidden || stopped,
      done: false,
    };

    if (!onProgress(progress)) return;
  }
  const truncated = hidden || stopped;
  onProgress({ hits, files: found.size, scanned, total: files.length, truncated, done: true });
}
