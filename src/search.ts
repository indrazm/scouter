import { relative } from "node:path";
import { readDirectory, readDocument, type DirectoryEntry } from "./files";

/** Enough for any ordinary project. Past it the search says so rather than walking the rest of a huge tree. */
export const MAX_INDEXED_ENTRIES = 20_000;
/** Matches listed at once; the count still reports every match. */
export const MAX_MATCHES = 200;

export interface IndexedEntry {
  path: string;
  /** Path relative to the folder that was indexed, shown as the match's name. */
  relative: string;
  kind: DirectoryEntry["kind"];
}

/**
 * Every entry under `root` that `skip` does not reject, breadth first so shallow names come first. Folders are read
 * a level at a time, and the walk stops at `limit` entries.
 */
export async function indexTree(
  root: string,
  skip: (path: string) => boolean,
  limit = MAX_INDEXED_ENTRIES,
): Promise<{ entries: IndexedEntry[]; truncated: boolean }> {
  const entries: IndexedEntry[] = [];
  let level = [root];
  while (level.length) {
    // Unreadable folders are left out rather than stopping the search.
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

/**
 * Entries whose path contains every word of `query`, ignoring case. Matches on the file name come first, then
 * shorter paths, so the likeliest file is at the top. `total` counts every match, even when only some are listed.
 */
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

/** Lines listed at once; past it the search says so rather than filling the list. */
export const MAX_TEXT_HITS = 200;
/** One file with many matches would crowd out the rest; open it and press `/` to see them all. */
const MAX_HITS_PER_FILE = 10;
/** Text read in total before the search stops, so a huge tree cannot keep it reading for minutes. */
const MAX_SCANNED_CHARS = 64 * 1024 * 1024;
/** Files read at once: enough to keep the disk busy, few enough to hold in memory together. */
const READ_BATCH = 16;
/** Progress is reported at most this often, so the list is not rebuilt for every batch. */
const REPORT_INTERVAL_MS = 120;
/** Characters of a matching line kept before the match, so the match stays in view in a narrow list. */
const SNIPPET_LEAD = 40;
const SNIPPET_LENGTH = 300;

/** One line that contains the query. */
export interface TextHit {
  path: string;
  /** Path relative to the folder that was indexed. */
  relative: string;
  /** Counted from one. */
  line: number;
  /** The line, trimmed and cut around the match. */
  text: string;
  /** Where the match starts in `text`, and how long it is. */
  at: number;
  length: number;
}

export interface TextProgress {
  hits: TextHit[];
  /** How many files the hits are in. */
  files: number;
  /** Files read so far, out of `total`. */
  scanned: number;
  total: number;
  /** There are more matches than are listed, or the search stopped before every file was read. */
  truncated: boolean;
  done: boolean;
}

/** The part of `line` to show: from a little before the match, or from where the text starts when it is near. */
function snippetOf(line: string, index: number, length: number): Pick<TextHit, "text" | "at" | "length"> {
  const indent = line.length - line.trimStart().length;
  const from = index > SNIPPET_LEAD ? index - SNIPPET_LEAD : Math.min(indent, index);
  return { text: line.slice(from, from + SNIPPET_LENGTH), at: index - from, length };
}

/** The lines of `text` that contain `needle` (already lower case), at most `limit`, and whether there were more. */
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

/**
 * Finds the lines containing `query`, ignoring case, in the regular files among `entries`, reading them in order so
 * shallow files come first. Files that cannot be shown as text (binary, not UTF-8, unreadable) are skipped, and each
 * is read under the same 1 MiB limit as the reader. `onProgress` is called as results arrive and once more at the
 * end; returning false from it stops the search.
 */
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
  /** Some file had more matches than are listed. */
  let hidden = false;
  /** The hit limit or the read budget was reached, so the remaining files are not read. */
  let stopped = false;
  let reported = 0;
  for (let start = 0; start < files.length && !stopped; start += READ_BATCH) {
    const batch = files.slice(start, start + READ_BATCH);
    // Batches run one after another, so memory and open files stay bounded and the order of results is stable.
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
