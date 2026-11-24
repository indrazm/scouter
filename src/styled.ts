import { StyledText, bg as background, bold as emphasis, fg as foreground, type TextChunk } from "@opentui/core";
import { theme } from "./theme";

export function scrollbarStyle(): { trackOptions: { backgroundColor: string; foregroundColor: string } } {
  return { trackOptions: { backgroundColor: "transparent", foregroundColor: theme.muted } };
}

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export function styled(segments: Segment[]): StyledText {
  const chunks: TextChunk[] = [];
  for (const segment of segments) {
    if (segment.text) chunks.push(chunk(segment));
  }
  return new StyledText(chunks);
}

export function segmentsWidth(segments: Segment[]): number {
  return segments.reduce((total, segment) => total + Bun.stringWidth(segment.text), 0);
}

export function fitEnd(text: string, columns: number): string {
  if (columns <= 0) return "";

  if (Bun.stringWidth(text) <= columns) return text;

  let tail = text;
  while (tail && Bun.stringWidth(tail) > columns - 1) tail = tail.slice(1);
  return `…${tail}`;
}

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
