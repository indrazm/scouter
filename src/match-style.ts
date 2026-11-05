import type { OnHighlightCallback } from "@opentui/core";
import { theme } from "./theme";

/** The syntax group the words that match a search are put in; `CodeView` registers its style under this name. */
export const MATCH_GROUP = "search.match";
export const MATCH_STYLE = { fg: theme.accentInk, bg: theme.modified, bold: true };

/**
 * A file with no grammar has no filetype, and the renderer then skips highlighting altogether, including ours. Giving
 * it this one, which no grammar answers to, lets the matches be marked in plain text too.
 */
export const PLAIN_FILETYPE = "scouter-plain";

/** One file with this many matches would make a list of marks too long to be worth drawing. */
const MAX_MARKS = 2000;

/** Where `needle` occurs in `text`, ignoring case, as `[start, end)` character ranges that do not overlap. */
export function matchRanges(text: string, needle: string): [number, number][] {
  const lower = text.toLowerCase();
  const wanted = needle.toLowerCase();
  // A few characters change length in lower case, which would put every later mark in the wrong place.
  if (!wanted || lower.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (
    let at = lower.indexOf(wanted);
    at >= 0 && ranges.length < MAX_MARKS;
    at = lower.indexOf(wanted, at + wanted.length)
  ) {
    ranges.push([at, at + wanted.length]);
  }
  return ranges;
}

/** Adds the matches of `needle` to whatever the grammar highlighted. Undefined when there is nothing to mark. */
export function markMatches(needle: string | undefined): OnHighlightCallback | undefined {
  if (!needle) return undefined;
  return (highlights, { content }) => [
    ...highlights,
    ...matchRanges(content, needle).map(([start, end]): [number, number, string] => [start, end, MATCH_GROUP]),
  ];
}
