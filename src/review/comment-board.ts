import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { displayLabel, displayText } from "../core/files";
import { boundaryOf, isPlain } from "../core/keys";
import type { Footer } from "../ui/footer";
import { paintScrollbar, scrollbarStyle, segmentsWidth, styled } from "../ui/styled";
import { theme, transparent } from "../ui/theme";
import type { Hint, Segment } from "../ui/types";
import { formatLineRange, type ReviewComments } from "./comments";
import type { DiffRow, ReviewComment } from "./types";

interface CommentBoardHost {
  comments: ReviewComments;
  footer: Footer;
  isOutdated(comment: ReviewComment): boolean;
  onJump(comment: ReviewComment): void;
  onEdit(comment: ReviewComment): void;
  onCopy(clearAfter: boolean): Promise<boolean>;
  onChange(): void;
}

interface BoardRow {
  comment: ReviewComment;
  box: BoxRenderable;
  location: TextRenderable;
  code: TextRenderable;
  body: TextRenderable;
}

const MAX_CARD_WIDTH = 96;
const MIN_CARD_WIDTH = 40;
const CARD_CHROME_ROWS = 5;
const ROWS_PER_ITEM = 4;
const MAX_CODE_PREVIEW_LINES = 3;
const ACTION_GAP = "  ";

const boardActions: Hint[] = [
  ["Enter", "jump"],
  ["e", "edit"],
  ["x", "delete"],
  ["X", "discard all"],
  ["y", "Copy review context"],
  ["c", "copy & clear"],
  ["Esc", "close"],
];

function fitCompactHints(hints: Hint[], columns: number): Segment[] {
  const segments: Segment[] = [];
  for (const [key, action] of hints) {
    const hint: Segment[] = [
      { text: key, fg: theme.accentSoft },
      { text: ` ${action}`, fg: theme.dim },
    ];
    const next = segments.length ? [...segments, { text: ACTION_GAP }, ...hint] : hint;

    if (segmentsWidth(next) > columns) break;

    segments.splice(0, segments.length, ...next);
  }
  return segments;
}

function formatCommentBody(text: string): string {
  return displayText(text)
    .replace(/\t/g, "    ")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatCodePreview(rows: DiffRow[]): Segment[] {
  const shown = rows.length > MAX_CODE_PREVIEW_LINES ? rows.slice(0, MAX_CODE_PREVIEW_LINES - 1) : rows;
  const segments: Segment[] = [];
  for (let index = 0; index < shown.length; index += 1) {
    const row = shown[index]!;

    if (index > 0) segments.push({ text: "\n" });

    const color = row.mark === "+" ? theme.added : row.mark === "-" ? theme.removed : theme.dim;
    const snippet = displayLabel(row.text.trim());
    segments.push({ text: "  " }, { text: `${row.mark} ${snippet}`.trimEnd(), fg: color });
  }

  if (rows.length > MAX_CODE_PREVIEW_LINES) {
    const hidden = rows.length - shown.length;
    segments.push({ text: `\n  … +${hidden} more ${hidden === 1 ? "line" : "lines"}`, fg: theme.dim });
  }

  return segments;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

export class CommentBoard {
  readonly root: BoxRenderable;
  private readonly card: BoxRenderable;
  private readonly scroller: ScrollBoxRenderable;
  private readonly actions: BoxRenderable;
  private readonly actionsText: TextRenderable;
  private rows: BoardRow[] = [];
  private selectedIndex = 0;
  private copying = false;

  constructor(
    private readonly context: RenderContext,
    private readonly host: CommentBoardHost,
    background: string,
  ) {
    this.root = new BoxRenderable(context, {
      id: "comment-board",
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 2,
      zIndex: 20,
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "center",
      overflow: "hidden",
      backgroundColor: background,
      visible: false,
      onSizeChange: () => this.layout(),
    });
    this.card = new BoxRenderable(context, {
      id: "comment-board-card",
      flexDirection: "column",
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      title: " Review Comments ",
      titleAlignment: "center",
      titleColor: theme.accentSoft,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: background,
    });
    this.scroller = new ScrollBoxRenderable(context, {
      id: "comment-board-list",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: false,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: scrollbarStyle(),
      renderAfter: paintScrollbar,
    });
    this.actions = new BoxRenderable(context, {
      height: 2,
      width: "100%",
      flexShrink: 0,
      border: ["top"],
      borderColor: theme.border,
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "row",
    });
    this.actionsText = new TextRenderable(context, {
      height: 1,
      width: "100%",
      wrapMode: "none",
      selectable: false,
    });
    this.actions.add(this.actionsText);
    this.card.add(this.scroller);
    this.card.add(this.actions);
    this.root.add(this.card);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  open(): void {
    const items = this.host.comments.list();

    if (!items.length) {
      this.host.footer.setMessage("No comments yet. Click a line number in the diff.");
      return;
    }

    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));
    this.root.visible = true;
    this.host.footer.clearMessage();
    this.host.footer.setPrompt("comments");
    this.rebuild(items);
  }

  close(): void {
    if (!this.root.visible) return;

    this.root.visible = false;
    this.host.footer.setPrompt(undefined);
  }

  refresh(): void {
    if (!this.root.visible) return;

    const items = this.host.comments.list();

    if (!items.length) {
      this.close();
      return;
    }

    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));
    this.rebuild(items);
  }

  restyle(background: string): void {
    this.root.backgroundColor = background;
    this.card.backgroundColor = background;
    this.card.borderColor = theme.accent;
    this.card.titleColor = theme.accentSoft;
    this.actions.borderColor = theme.border;
    this.scroller.scrollbarOptions = scrollbarStyle();

    if (this.root.visible) {
      this.rows.forEach((row, index) => this.paintRow(row, index === this.selectedIndex));
      this.paintActions();
    }
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.root.visible) return false;

    if (key.ctrl && !key.meta && key.name === "c") return false;

    key.preventDefault();

    if (!isPlain(key)) return true;

    if (key.name === "escape" || key.name === "q") {
      this.close();
      return true;
    }

    if (["j", "down", "k", "up"].includes(key.name)) {
      this.moveSelection((["k", "up"].includes(key.name) ? -1 : 1) * (key.shift ? 5 : 1));
      return true;
    }

    if (["pageup", "pagedown"].includes(key.name)) {
      const step = Math.max(1, Math.floor(this.scroller.viewport.height / ROWS_PER_ITEM));
      this.moveSelection(key.name === "pageup" ? -step : step);
      return true;
    }

    const edge = boundaryOf(key);

    if (edge) {
      this.selectIndex(edge === "start" ? 0 : this.rows.length - 1);
      return true;
    }

    if (key.name === "return") {
      this.jumpSelected();
    } else if (key.name === "e" && !key.shift) {
      this.editSelected();
    } else if (
      (key.name === "x" && !key.shift) ||
      (key.name === "d" && !key.shift) ||
      key.name === "backspace" ||
      key.name === "delete"
    ) {
      this.deleteSelected();
    } else if (key.name === "x" && key.shift) {
      this.discardAll();
    } else if (key.name === "y" && !key.shift) {
      void this.copyAll(false);
    } else if (key.name === "c" && !key.shift) {
      void this.copyAll(true);
    }

    return true;
  }

  private selected(): ReviewComment | undefined {
    return this.rows[this.selectedIndex]?.comment;
  }

  private moveSelection(delta: number): void {
    if (this.rows.length) this.selectIndex(this.selectedIndex + delta);
  }

  private selectIndex(index: number): void {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.rows.length - 1));

    if (previous === this.selectedIndex) return;

    const previousRow = this.rows[previous];

    if (previousRow) this.paintRow(previousRow, false);

    const selectedRow = this.rows[this.selectedIndex];

    if (selectedRow) {
      this.paintRow(selectedRow, true);
      this.scroller.scrollChildIntoView(selectedRow.box);
    }
  }

  private jumpSelected(): void {
    const comment = this.selected();
    this.close();

    if (comment) this.host.onJump(comment);
  }

  private editSelected(): void {
    const comment = this.selected();
    this.close();

    if (comment) this.host.onEdit(comment);
  }

  private deleteSelected(): void {
    const comment = this.selected();

    if (!comment) return;

    this.host.comments.delete(comment);
    const remaining = this.host.comments.size;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, remaining - 1));
    this.host.onChange();

    if (!remaining) this.close();

    this.host.footer.setMessage("Comment removed.");
  }

  private discardAll(): void {
    const count = this.host.comments.clear();
    this.close();
    this.host.onChange();

    if (count) this.host.footer.setMessage(`Discarded ${countLabel(count)}.`);
  }

  private async copyAll(clearAfter: boolean): Promise<void> {
    if (this.copying) return;

    this.copying = true;
    try {
      const ok = await this.host.onCopy(clearAfter);

      if (ok) this.close();
    } finally {
      this.copying = false;
    }
  }

  private rebuild(items: ReviewComment[]): void {
    for (const row of this.rows) row.box.destroyRecursively();
    this.rows = items.map((comment, index) => this.createRow(comment, index));
    this.card.title = ` Review Comments (${items.length}) `;
    this.layout();
    const selectedRow = this.rows[this.selectedIndex];

    if (selectedRow) this.scroller.scrollChildIntoView(selectedRow.box);
  }

  private createRow(comment: ReviewComment, index: number): BoardRow {
    const box = new BoxRenderable(this.context, {
      id: `comment-board-row-${index}`,
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      paddingRight: 1,
      marginBottom: 1,
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;

        event.preventDefault();
        this.selectIndex(index);
      },
    });
    const location = new TextRenderable(this.context, {
      height: 1,
      width: "100%",
      wrapMode: "none",
      selectable: false,
    });
    const code = new TextRenderable(this.context, {
      width: "100%",
      wrapMode: "none",
      selectable: false,
    });
    const body = new TextRenderable(this.context, {
      width: "100%",
      wrapMode: "word",
      selectable: false,
    });
    box.add(location);
    box.add(code);
    box.add(body);
    this.scroller.add(box);
    const row: BoardRow = { comment, box, location, code, body };
    this.paintRow(row, index === this.selectedIndex);
    return row;
  }

  private paintRow(row: BoardRow, selected: boolean): void {
    const { comment } = row;
    const outdated = this.host.isOutdated(comment);
    row.box.backgroundColor = selected ? theme.rowActiveBg : transparent;
    const { range, removed } = formatLineRange(comment);
    const locationParts: Segment[] = [
      { text: selected ? "▎ " : "  ", fg: theme.accent },
      { text: displayLabel(comment.path), fg: selected ? theme.accent : theme.text, bold: true },
      { text: `:${range}`, fg: theme.muted },
    ];

    if (removed) locationParts.push({ text: "  removed", fg: theme.removed });

    if (outdated) locationParts.push({ text: "  outdated", fg: theme.modified, bold: true });

    row.location.content = styled(locationParts);
    row.code.content = styled(formatCodePreview(comment.rows));
    row.body.content = styled([{ text: formatCommentBody(comment.text), fg: theme.commentInk }]);
  }

  private layout(): void {
    const availableWidth = this.root.width || this.context.width;
    const availableHeight = this.root.height || Math.max(8, this.context.height - 2);
    const targetWidth = Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, availableWidth - 6));
    const width = Math.max(12, Math.min(availableWidth, targetWidth));
    const maxHeight = Math.max(8, availableHeight - 2);
    const contentRows = this.rows.reduce(
      (sum, row) =>
        sum +
        2 +
        Math.min(MAX_CODE_PREVIEW_LINES, Math.max(1, row.comment.rows.length)) +
        row.comment.text.split("\n").length,
      0,
    );
    const desiredHeight = Math.max(10, contentRows + CARD_CHROME_ROWS);
    const height = Math.min(maxHeight, desiredHeight);
    this.card.width = width;
    this.card.height = height;
    this.card.marginTop = Math.max(0, Math.floor((availableHeight - height) / 2));
    this.paintActions();
  }

  private paintActions(): void {
    const width = Math.max(0, (typeof this.card.width === "number" ? this.card.width : MIN_CARD_WIDTH) - 6);
    this.actionsText.content = styled(fitCompactHints(boardActions, width));
  }
}
