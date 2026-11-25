import {
  RGBA,
  StyledText,
  bg as background,
  bold as emphasis,
  fg as foreground,
  type OptimizedBuffer,
  type ScrollBoxRenderable,
  type TextChunk,
} from "@opentui/core";
import { theme } from "./theme";
import type { Segment } from "./types";

let cachedScrollbarColor: { hex: string; rgba: RGBA } | undefined;

function scrollbarColor(): RGBA {
  if (cachedScrollbarColor?.hex !== theme.muted) {
    cachedScrollbarColor = { hex: theme.muted, rgba: RGBA.fromHex(theme.muted) };
  }

  return cachedScrollbarColor.rgba;
}

export function scrollbarStyle(): { trackOptions: { backgroundColor: string; foregroundColor: string } } {
  return { trackOptions: { backgroundColor: "transparent", foregroundColor: "transparent" } };
}

function renderScrollbar(this: ScrollBoxRenderable, buffer: OptimizedBuffer): void {
  const bar = this.verticalScrollBar;

  if (!bar.visible || bar.height <= 0 || bar.width <= 0 || bar.scrollSize <= bar.viewportSize) return;

  const virtualTrack = bar.height * 2;
  const range = bar.scrollSize - bar.viewportSize;
  const ratio = Math.max(0, Math.min(1, bar.scrollPosition / range));
  const thumbSize = Math.max(
    Math.min(2, virtualTrack),
    Math.min(virtualTrack, Math.round((bar.viewportSize / bar.scrollSize) * virtualTrack)),
  );
  const thumbStart = Math.round(ratio * (virtualTrack - thumbSize));
  const thumbEnd = thumbStart + thumbSize;
  const color = scrollbarColor();

  for (let row = 0; row < bar.height; row += 1) {
    const top = thumbStart <= row * 2 && thumbEnd > row * 2;
    const bottom = thumbStart <= row * 2 + 1 && thumbEnd > row * 2 + 1;
    const glyph = top && bottom ? "▐" : top ? "▝" : bottom ? "▗" : undefined;

    if (glyph) buffer.drawText(glyph, bar.x, bar.y + row, color);
  }
}

export const paintScrollbar = renderScrollbar;

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
