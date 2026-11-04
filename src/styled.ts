import { StyledText, bg as background, bold as emphasis, fg as foreground, type TextChunk } from "@opentui/core";
import { theme } from "./theme";

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

/** Builds multi-colour text from plain segments, so layout code can measure what it is about to draw. */
export function styled(segments: Segment[]): StyledText {
  return new StyledText(segments.filter((segment) => segment.text).map(chunk));
}

export function segmentsWidth(segments: Segment[]): number {
  return segments.reduce((total, segment) => total + Bun.stringWidth(segment.text), 0);
}

/** Keeps the end of `text`, which is the part of a path that matters, marking the cut with an ellipsis. */
export function fitEnd(text: string, columns: number): string {
  if (columns <= 0) return "";
  if (Bun.stringWidth(text) <= columns) return text;
  let tail = text;
  while (tail && Bun.stringWidth(tail) > columns - 1) tail = tail.slice(1);
  return `…${tail}`;
}

/** Keeps the start of `text`, marking the cut with an ellipsis. */
export function fitStart(text: string, columns: number): string {
  if (columns <= 0) return "";
  if (Bun.stringWidth(text) <= columns) return text;
  let head = text;
  while (head && Bun.stringWidth(head) > columns - 1) head = head.slice(0, -1);
  return `${head}…`;
}

function chunk(segment: Segment): TextChunk {
  let result = foreground(segment.fg ?? theme.text)(segment.text);
  if (segment.bg) result = background(segment.bg)(result);
  if (segment.bold) result = emphasis(result);
  return result;
}
