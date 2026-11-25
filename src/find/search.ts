import { relative } from "node:path";
import { isImagePath, readDirectoryRaw, readDocument } from "../core/files";
import type { DirectoryEntry } from "../core/types";
import type { IndexedEntry, TextHit, TextProgress } from "./types";

export const MAX_INDEXED_ENTRIES = 20_000;
export const MAX_MATCHES = 200;
const DIR_BATCH = 32;

function compareEntryName(left: DirectoryEntry, right: DirectoryEntry): number {
  const directoryOrder = Number(right.kind === "directory") - Number(left.kind === "directory");
  return directoryOrder || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export async function indexTree(
  root: string,
  skip: (path: string) => boolean,
  limit = MAX_INDEXED_ENTRIES,
): Promise<{ entries: IndexedEntry[]; truncated: boolean }> {
  const entries: IndexedEntry[] = [];
  let level = [root];
  while (level.length) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += DIR_BATCH) {
      const batch = level.slice(start, start + DIR_BATCH);
      // oxlint-disable-next-line no-await-in-loop
      const listings = await Promise.all(batch.map((folder) => readDirectoryRaw(folder).catch(() => [])));
      for (const children of listings) {
        children.sort(compareEntryName);
        for (const child of children) {
          if (skip(child.path)) continue;

          if (entries.length >= limit) return { entries, truncated: true };

          const rel = relative(root, child.path);
          const relativeLower = rel.toLowerCase();
          const nameLower = relativeLower.slice(relativeLower.lastIndexOf("/") + 1);
          entries.push({ path: child.path, relative: rel, kind: child.kind, relativeLower, nameLower });

          if (child.kind === "directory") next.push(child.path);
        }
      }
    }
    level = next;
  }
  return { entries, truncated: false };
}

function compareRelative(left: IndexedEntry, right: IndexedEntry): number {
  return (
    left.relative.length - right.relative.length ||
    (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)
  );
}

export function matchEntries(entries: IndexedEntry[], query: string): { matches: IndexedEntry[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (!words.length) return { matches: [], total: 0 };

  const [first = ""] = words;
  const byName: IndexedEntry[] = [];
  const byPath: IndexedEntry[] = [];
  for (const entry of entries) {
    const path = entry.relativeLower ?? entry.relative.toLowerCase();
    let matched = true;
    for (const word of words) {
      if (!path.includes(word)) {
        matched = false;
        break;
      }
    }

    if (!matched) continue;

    const name = entry.nameLower ?? path.slice(path.lastIndexOf("/") + 1);

    if (name.includes(first)) byName.push(entry);
    else byPath.push(entry);
  }
  const total = byName.length + byPath.length;
  byName.sort(compareRelative);

  if (byName.length >= MAX_MATCHES) return { matches: byName.slice(0, MAX_MATCHES), total };

  byPath.sort(compareRelative);
  return { matches: [...byName, ...byPath.slice(0, MAX_MATCHES - byName.length)], total };
}

export const MAX_TEXT_HITS = 200;
const MAX_HITS_PER_FILE = 10;
const MAX_SCANNED_CHARS = 64 * 1024 * 1024;
const READ_BATCH = 16;
const REPORT_INTERVAL_MS = 120;
const SNIPPET_LEAD = 40;
const SNIPPET_LENGTH = 300;

function snippetOf(line: string, index: number, length: number): Pick<TextHit, "text" | "at" | "length"> {
  const indent = line.length - line.trimStart().length;
  const from = index > SNIPPET_LEAD ? index - SNIPPET_LEAD : Math.min(indent, index);
  return { text: line.slice(from, from + SNIPPET_LENGTH), at: index - from, length };
}

function rawOffset(raw: string, lowerAt: number): number {
  let lowerPos = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (lowerPos >= lowerAt) return index;

    lowerPos += raw[index]!.toLowerCase().length;
  }
  return raw.length;
}

function hitsInLines(
  entry: IndexedEntry,
  text: string,
  lower: string,
  needle: string,
  limit: number,
): { hits: TextHit[]; more: boolean } {
  const lines = text.split("\n");
  const lowerLines = lower.split("\n");
  const hits: TextHit[] = [];
  for (const [index, line] of lowerLines.entries()) {
    const at = line.indexOf(needle);

    if (at < 0) continue;

    if (hits.length >= limit) return { hits, more: true };

    const raw = lines[index] ?? "";
    const start = line.length === raw.length ? at : rawOffset(raw, at);
    const length = line.length === raw.length ? needle.length : rawOffset(raw, at + needle.length) - start;
    hits.push({
      path: entry.path,
      relative: entry.relative,
      line: index + 1,
      ...snippetOf(raw, start, length),
    });
  }
  return { hits, more: false };
}

function hitsIn(entry: IndexedEntry, text: string, needle: string, limit: number): { hits: TextHit[]; more: boolean } {
  const lower = text.toLowerCase();
  let at = lower.indexOf(needle);

  if (at < 0) return { hits: [], more: false };

  if (lower.length !== text.length) return hitsInLines(entry, text, lower, needle, limit);

  const hits: TextHit[] = [];
  let lineNumber = 1;
  let cursor = 0;
  while (at >= 0) {
    let newline = text.indexOf("\n", cursor);
    while (newline >= 0 && newline < at) {
      lineNumber += 1;
      cursor = newline + 1;
      newline = text.indexOf("\n", cursor);
    }

    const lineStart = cursor;
    const lineEnd = newline >= 0 ? newline : text.length;

    if (hits.length >= limit) return { hits, more: true };

    hits.push({
      path: entry.path,
      relative: entry.relative,
      line: lineNumber,
      ...snippetOf(text.slice(lineStart, lineEnd), at - lineStart, needle.length),
    });

    if (newline < 0) break;

    lineNumber += 1;
    cursor = newline + 1;
    at = lower.indexOf(needle, cursor);
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
    const documents = await Promise.all(
      batch.map((entry) => (isImagePath(entry.path) ? undefined : readDocument(entry.path).catch(() => undefined))),
    );
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
