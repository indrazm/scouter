import { relative } from "node:path";
import { readDirectory, type DirectoryEntry } from "./files";

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
