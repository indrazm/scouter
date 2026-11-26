import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { displayLabel, displayText } from "../core/files";
import { styled } from "../ui/styled";
import { theme } from "../ui/theme";
import type { Segment } from "../ui/types";
import { formatLineRange } from "./comments";
import type { CommentTarget } from "./types";

interface ComposerDraft {
  target: CommentTarget;
  text: string;
  cursor: number;
  outdated: boolean;
}

const MAX_INPUT_ROWS = 6;
const FULL_HINT = "Enter save · Shift+Enter newline · Esc cancel";
const SHORT_HINT = "Enter save · Esc cancel";

function sanitizeEditable(text: string): string {
  return displayText(text).replace(/\t/g, "    ");
}

function buildInputSegments(text: string, cursor: number): Segment[] {
  if (!text) {
    return [
      { text: "▍ ", fg: theme.commentInk, bold: true },
      { text: "▎", fg: theme.commentInk, bold: true },
      { text: "Write a comment…", fg: theme.muted },
    ];
  }

  const beforeLines = sanitizeEditable(text.slice(0, cursor)).split("\n");
  const afterLines = sanitizeEditable(text.slice(cursor)).split("\n");
  const cursorLine = beforeLines.length - 1;
  const cursorBefore = beforeLines[cursorLine] ?? "";
  const cursorAfter = afterLines[0] ?? "";
  const allLines = [...beforeLines.slice(0, -1), `${cursorBefore}${cursorAfter}`, ...afterLines.slice(1)];
  const windowStart = Math.max(0, Math.min(cursorLine - (MAX_INPUT_ROWS - 1), allLines.length - MAX_INPUT_ROWS));
  const windowEnd = Math.min(allLines.length, windowStart + MAX_INPUT_ROWS);
  const segments: Segment[] = [];

  for (let line = windowStart; line < windowEnd; line += 1) {
    if (line > windowStart) segments.push({ text: "\n" });

    segments.push({ text: "▍ ", fg: theme.commentInk, bold: true });

    if (line === cursorLine) {
      if (cursorBefore) segments.push({ text: cursorBefore, fg: theme.text });

      segments.push({ text: "▎", fg: theme.commentInk, bold: true });

      if (cursorAfter) segments.push({ text: cursorAfter, fg: theme.text });
    } else {
      const content = allLines[line] ?? "";

      if (content) segments.push({ text: content, fg: theme.text });
    }
  }

  return segments;
}

function hintForWidth(width: number | "100%"): string {
  if (typeof width !== "number" || width >= 68) return FULL_HINT;

  if (width >= 44) return SHORT_HINT;

  return "";
}

export class CommentComposer {
  readonly root: BoxRenderable;
  private readonly inputText: TextRenderable;
  private readonly footer: BoxRenderable;
  private readonly metaText: TextRenderable;
  private readonly hintText: TextRenderable;
  private draft?: ComposerDraft;
  private boxWidth: number | "100%" = "100%";

  constructor(context: RenderContext) {
    this.root = new BoxRenderable(context, {
      id: "comment-composer",
      position: "absolute",
      zIndex: 10,
      left: 0,
      top: 0,
      width: "100%",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      border: ["bottom"],
      borderColor: theme.commentInk,
      backgroundColor: theme.commentBg,
      visible: false,
    });
    this.inputText = new TextRenderable(context, {
      width: "100%",
      minHeight: 1,
      maxHeight: MAX_INPUT_ROWS,
      flexShrink: 0,
      wrapMode: "word",
      selectable: false,
    });
    this.footer = new BoxRenderable(context, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
    });
    this.metaText = new TextRenderable(context, {
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.hintText = new TextRenderable(context, {
      height: 1,
      flexShrink: 0,
      marginLeft: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.footer.add(this.metaText);
    this.footer.add(this.hintText);
    this.root.add(this.inputText);
    this.root.add(this.footer);
  }

  get active(): boolean {
    return this.draft !== undefined;
  }

  estimatedHeight(text: string): number {
    const columns = typeof this.boxWidth === "number" ? Math.max(12, this.boxWidth - 4) : 64;
    let visualLines = 0;
    for (const line of text.split("\n")) {
      visualLines += Math.max(1, Math.ceil((line.length + 1) / columns));
    }
    return Math.min(MAX_INPUT_ROWS, visualLines) + 2;
  }

  show(target: CommentTarget, text: string, cursor: number, outdated = false): void {
    this.draft = { target, text, cursor, outdated };
    this.root.visible = true;
    this.paint();
  }

  place(left: number, top: number, width: number | "100%"): void {
    this.boxWidth = width;
    this.root.left = left;
    this.root.top = top;
    this.root.width = width;
  }

  hide(): void {
    this.draft = undefined;
    this.root.visible = false;
  }

  restyle(): void {
    this.root.borderColor = theme.commentInk;
    this.root.backgroundColor = theme.commentBg;

    if (this.draft) this.paint();
  }

  private paint(): void {
    const draft = this.draft;

    if (!draft) return;

    this.root.borderColor = theme.commentInk;
    this.root.backgroundColor = theme.commentBg;
    const { target, text, cursor, outdated } = draft;
    this.inputText.content = styled(buildInputSegments(text, cursor));

    const { range, removed } = formatLineRange(target);
    const removedSuffix = removed ? " (removed)" : "";
    const metaParts: Segment[] = [
      { text: "  " },
      { text: `${displayLabel(target.path)}:${range}${removedSuffix}`, fg: theme.muted },
    ];

    if (outdated) metaParts.push({ text: "  outdated", fg: theme.modified, bold: true });

    this.metaText.content = styled(metaParts);
    const hint = hintForWidth(this.boxWidth);
    this.hintText.visible = hint !== "";
    this.hintText.content = styled(hint ? [{ text: hint, fg: theme.muted }] : []);
  }
}
