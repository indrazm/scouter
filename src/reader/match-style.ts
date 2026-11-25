import type { OnHighlightCallback } from "@opentui/core";
import { theme } from "../ui/theme";

export const MATCH_GROUP = "search.match";
export function matchStyle(): { fg: string; bg: string; bold: boolean } {
  return { fg: theme.matchFg, bg: theme.matchBg, bold: true };
}

export const PLAIN_FILETYPE = "scouter-plain";

const MAX_MARKS = 2000;

export function matchRanges(text: string, needle: string): [number, number][] {
  const lower = text.toLowerCase();
  const wanted = needle.toLowerCase();

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

export function markMatches(needle: string | undefined): OnHighlightCallback | undefined {
  if (!needle) return undefined;

  return (highlights, { content }) => [
    ...highlights,
    ...matchRanges(content, needle).map(([start, end]): [number, number, string] => [start, end, MATCH_GROUP]),
  ];
}
