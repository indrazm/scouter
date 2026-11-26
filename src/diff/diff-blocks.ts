import {
  BoxRenderable,
  DiffRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  type MouseEvent,
  type RGBA,
  type RenderContext,
  type SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core";
import { posix } from "node:path";
import { displayLabel } from "../core/files";
import { languageFor } from "../reader/code-view";
import { CommentComposer } from "../review/comment-composer";
import { matchCommentSpan, rangeTarget, type ReviewComments } from "../review/comments";
import { parseRows } from "../review/diff-rows";
import type { CommentTarget, DiffRow } from "../review/types";
import { paintScrollbar, scrollbarStyle, styled } from "../ui/styled";
import { theme, transparent } from "../ui/theme";
import type { DiffScope, Segment } from "../ui/types";
import { countSegments, indexMark, statusOf } from "./changes";
import type { Change, DiffView, FilePatch, HunkJumpResult, Patch } from "./types";

export const MIN_SPLIT_COLUMNS = 60;
const STAT_BAR_CELLS = 5;
const GUTTER_PADDING = 4;

interface DiffBlocksOptions {
  syntax: { style: SyntaxStyle; client: TreeSitterClient };
  comments: ReviewComments;
  isOutdated: (target: CommentTarget) => boolean;
  onToggleCollapse: (path: string) => void;
  onLayout: () => void;
  onComment: (target: CommentTarget | undefined) => void;
}

interface Block {
  change: Change;
  patch: Patch;
  hunkLines: number[];
  rows: DiffRow[];
  painted: Set<number>;
  root: BoxRenderable;
  header: BoxRenderable;
  headerTitle: TextRenderable;
  headerCounts: TextRenderable;
  content: DiffRenderable | TextRenderable;
  diff?: DiffRenderable;
}

interface HunkEntry {
  row: number;
  path: string;
  line: number;
}

function hunkStartLines(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)/gm)) {
    lines.push(Math.max(1, Number(match[1] ?? 1)));
  }
  return lines;
}

function rowsOf(patch: Patch): DiffRow[] {
  return patch.kind === "text" ? parseRows(patch.text) : [];
}

function baseColors(diff: DiffRenderable, mark: DiffRow["mark"] | undefined): { gutter: RGBA; content: RGBA } {
  if (mark === "+") return { gutter: diff.addedLineNumberBg, content: diff.addedContentBg ?? diff.addedBg };

  if (mark === "-") return { gutter: diff.removedLineNumberBg, content: diff.removedContentBg ?? diff.removedBg };

  return { gutter: diff.lineNumberBg, content: diff.contextContentBg ?? diff.contextBg };
}

function maxGutterDigits(files: FilePatch[]): number {
  let highest = 1;
  for (const { patch } of files) {
    if (patch.kind !== "text") continue;

    for (const match of patch.text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/gm)) {
      const oldEnd = Number(match[1] ?? 0) + Number(match[2] ?? 1);
      const newEnd = Number(match[3] ?? 0) + Number(match[4] ?? 1);

      if (oldEnd > highest) highest = oldEnd;

      if (newEnd > highest) highest = newEnd;
    }
  }
  return Math.max(2, String(highest).length);
}

function statBarSegments(change: Change): Segment[] {
  if (change.binary) return [];

  const added = change.added ?? 0;
  const removed = change.removed ?? 0;
  const total = added + removed;

  if (total <= 0) return [];

  const filled = Math.min(STAT_BAR_CELLS, total);
  let green = Math.round((added / total) * filled);

  if (added > 0 && green === 0) green = 1;

  if (removed > 0 && green === filled && filled > 1) green = filled - 1;

  const red = filled - green;
  const segments: Segment[] = [{ text: "  " }];

  if (green > 0) segments.push({ text: "▪".repeat(green), fg: theme.added });

  if (red > 0) segments.push({ text: "▪".repeat(red), fg: theme.removed });

  return segments;
}

function patchEqual(left: Patch, right: Patch): boolean {
  if (left.kind !== right.kind) return false;

  return left.kind === "text" && right.kind === "text"
    ? left.text === right.text
    : left.kind === "notice" && right.kind === "notice" && left.message === right.message;
}

function changeHeaderEqual(left: Change, right: Change): boolean {
  return (
    left.kind === right.kind &&
    left.oldPath === right.oldPath &&
    left.staged === right.staged &&
    left.unstaged === right.unstaged &&
    left.added === right.added &&
    left.removed === right.removed &&
    left.binary === right.binary
  );
}

function diffColors() {
  return {
    addedBg: theme.addedBg,
    removedBg: theme.removedBg,
    contextBg: transparent,
    addedLineNumberBg: theme.addedGutter,
    removedLineNumberBg: theme.removedGutter,
    addedSignColor: theme.added,
    removedSignColor: theme.removed,
  };
}

export class DiffBlocks {
  readonly scroller: ScrollBoxRenderable;
  private readonly stack: BoxRenderable;
  private blocks: Block[] = [];
  private view: DiffView = "unified";
  private wrap = false;
  private readonly collapsed = new Set<string>();
  private lastHunkIndex?: number;
  private band: string = theme.fallbackBackground;
  private lastMinDigits = 0;
  private activePath?: string;
  private readonly composer: CommentComposer;
  private editing?: { target: CommentTarget; text: string; cursor: number };
  private gutterDrag?: { path: string; startRow: number; endRow: number };

  constructor(
    private readonly context: RenderContext,
    private readonly options: DiffBlocksOptions,
  ) {
    this.scroller = new ScrollBoxRenderable(context, {
      id: "diff-scroller",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: true,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: scrollbarStyle(),
      renderAfter: paintScrollbar,
      horizontalScrollbarOptions: { visible: false },
      verticalScrollbarOptions: { onChange: () => this.options.onLayout() },
    });
    this.stack = new BoxRenderable(context, {
      id: "diff-stack",
      flexDirection: "column",
      flexShrink: 0,
      minWidth: "100%",
    });
    this.composer = new CommentComposer(context);
    this.stack.add(this.composer.root);
    this.scroller.add(this.stack);
    this.scroller.visible = false;
  }

  get hasBlocks(): boolean {
    return this.blocks.length > 0;
  }

  get currentView(): DiffView {
    return this.view;
  }

  isSingleFile(path: string): boolean {
    return this.blocks.length === 1 && this.blocks[0]?.change.path === path;
  }

  totals(): { added: number; removed: number; hunks: number; hunkIndex?: number } | undefined {
    const totals: { added: number; removed: number; hunks: number; hunkIndex?: number } = {
      added: 0,
      removed: 0,
      hunks: 0,
    };
    let anyText = false;
    for (const { patch } of this.blocks) {
      if (patch.kind !== "text") continue;

      anyText = true;
      totals.added += patch.added;
      totals.removed += patch.removed;
      totals.hunks += patch.hunks;
    }

    if (!anyText) return undefined;

    const activeHunk = this.currentHunkIndex();

    if (activeHunk !== undefined) totals.hunkIndex = activeHunk;

    return totals;
  }

  restyle(activePath: string | undefined): void {
    this.scroller.scrollbarOptions = scrollbarStyle();

    if (!this.blocks.length) return;

    const colors = diffColors();
    for (const [index, block] of this.blocks.entries()) {
      if (index > 0) block.header.borderColor = theme.border;

      this.paintHeader(block, activePath);
      block.headerCounts.content = this.headerCountsContent(block.change);

      if (block.diff) {
        block.diff.syntaxStyle = this.options.syntax.style;
        block.diff.fg = theme.text;
        block.diff.selectionBg = theme.selectionBg;
        block.diff.lineNumberFg = theme.dim;
        block.diff.addedBg = colors.addedBg;
        block.diff.removedBg = colors.removedBg;
        block.diff.contextBg = colors.contextBg;
        block.diff.addedLineNumberBg = colors.addedLineNumberBg;
        block.diff.removedLineNumberBg = colors.removedLineNumberBg;
        block.diff.addedSignColor = colors.addedSignColor;
        block.diff.removedSignColor = colors.removedSignColor;
      } else if (block.content instanceof TextRenderable && block.patch.kind === "notice") {
        block.content.content = styled([{ text: block.patch.message, fg: theme.muted }]);
      }
    }

    this.composer.restyle();
    this.repaintAll();
  }

  setTint(color: string): void {
    this.band = color;
    for (const block of this.blocks) block.header.backgroundColor = color;
  }

  toggleCollapse(path: string, activePath: string | undefined): void {
    if (this.gutterDrag?.path === path) this.clearGutterDrag();

    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);

    for (const block of this.blocks) {
      if (block.change.path === path) {
        block.content.visible = !this.collapsed.has(path);
        this.paintHeader(block, activePath);
      }
    }

    this.repaintAll();
  }

  toggleView(bodyWidth: number): boolean {
    if (this.view === "unified" && bodyWidth < MIN_SPLIT_COLUMNS) return false;

    this.gutterDrag = undefined;
    this.view = this.view === "unified" ? "split" : "unified";
    for (const block of this.blocks) if (block.diff) block.diff.view = this.view;
    this.repaintAll();
    return true;
  }

  setWrap(wrap: boolean): void {
    this.gutterDrag = undefined;
    this.wrap = wrap;
    this.applyWrap();
  }

  clear(): void {
    for (const block of this.blocks) block.root.destroyRecursively();
    this.blocks = [];
    this.gutterDrag = undefined;
    this.editing = undefined;
    this.composer.hide();
    this.stack.paddingBottom = 0;
  }

  reset(): void {
    this.clear();
    this.activePath = undefined;
    this.lastMinDigits = 0;
    this.collapsed.clear();
    this.lastHunkIndex = undefined;
  }

  show(files: FilePatch[], scroll: "keep" | "top", nextActivePath: string | undefined): void {
    const previous = this.blocks;
    const minDigits = maxGutterDigits(files);
    const sameOrder =
      minDigits === this.lastMinDigits &&
      files.length === previous.length &&
      files.every((file, index) => previous[index]?.change.path === file.change.path);

    if (sameOrder) {
      for (let index = 0; index < files.length; index += 1) {
        const block = previous[index]!;
        const { change, patch } = files[index]!;
        const headerChanged = !changeHeaderEqual(block.change, change);
        const activeChanged = (block.change.path === this.activePath) !== (block.change.path === nextActivePath);
        block.change = change;

        if (headerChanged || activeChanged) this.paintHeader(block, nextActivePath);

        if (headerChanged) {
          block.headerCounts.content = this.headerCountsContent(change);
        }

        if (!patchEqual(block.patch, patch)) {
          if (this.gutterDrag?.path === change.path) this.gutterDrag = undefined;

          block.content.destroyRecursively();
          const diff = patch.kind === "text" ? this.createDiff(change, patch.text, minDigits) : undefined;
          const content = diff ?? this.createNote(patch);
          content.visible = !this.collapsed.has(change.path);
          block.root.add(content);
          block.patch = patch;
          block.hunkLines = patch.kind === "text" ? hunkStartLines(patch.text) : [];
          block.rows = rowsOf(patch);
          block.painted = new Set();
          block.content = content;
          block.diff = diff;
        }
      }
    } else {
      this.gutterDrag = undefined;
      this.blocks = files.map((file, index) => this.createBlock(file, index, minDigits, nextActivePath));
      for (const block of this.blocks) this.stack.add(block.root);
      for (const block of previous) block.root.destroyRecursively();
    }

    this.lastMinDigits = minDigits;
    this.activePath = nextActivePath;
    this.scroller.visible = true;
    this.applyWrap();

    if (scroll === "top") this.scroller.scrollTo({ x: 0, y: 0 });
  }

  updateActiveHeader(next: string | undefined): void {
    const previous = this.activePath;

    if (previous === next) return;

    this.activePath = next;
    for (const block of this.blocks) {
      if (block.change.path === previous || block.change.path === next) this.paintHeader(block, next);
    }
  }

  jumpTo(path: string): void {
    const block = this.blocks.find((candidate) => candidate.change.path === path);

    if (block) this.scroller.scrollTo({ x: 0, y: this.blockTop(block) });
  }

  jumpHunk(direction: 1 | -1): HunkJumpResult {
    const entries = this.hunkEntries();

    if (!entries.length) return "none";

    const top = this.scroller.scrollTop;
    const target =
      direction > 0 ? entries.find((entry) => entry.row > top) : entries.findLast((entry) => entry.row < top);

    if (!target) return direction > 0 ? "last" : "first";

    this.scroller.scrollTo({ x: 0, y: target.row });
    return "moved";
  }

  activeLineFor(path: string): number {
    const entries = this.hunkEntries().filter((entry) => entry.path === path);
    const top = this.scroller.scrollTop;
    const active = entries.findLast((entry) => entry.row <= top) ?? entries[0];

    if (active) return active.line;

    const block = this.blocks.find((candidate) => candidate.change.path === path);
    const text = block?.patch.kind === "text" ? block.patch.text : "";
    const start = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(text)?.[1];
    return Math.max(1, Number(start ?? 1));
  }

  followScroll(scope: DiffScope, selectedPath: string | undefined): { selected?: Change; hunkChanged: boolean } {
    if (!this.blocks.length) return { hunkChanged: false };

    if (this.editing) this.placeComposer();

    const hunkIndex = this.currentHunkIndex();
    const hunkChanged = hunkIndex !== this.lastHunkIndex;
    this.lastHunkIndex = hunkIndex;

    if (scope !== "all" || !this.scroller.focused) return { hunkChanged };

    const top = this.scroller.scrollTop;
    let current = this.blocks[0];
    for (const block of this.blocks) if (this.blockTop(block) <= top) current = block;

    if (!current || current.change.path === selectedPath) return { hunkChanged };

    return { selected: current.change, hunkChanged };
  }

  hasTextBlock(path: string): boolean {
    return this.blocks.some((block) => block.change.path === path && block.patch.kind === "text");
  }

  hasMatchingRow(target: CommentTarget): boolean {
    const block = this.blocks.find((candidate) => candidate.change.path === target.path);

    if (!block) return false;

    return matchCommentSpan(target, block.rows) !== undefined;
  }

  jumpToComment(target: CommentTarget): boolean {
    const block = this.blocks.find((candidate) => candidate.change.path === target.path);

    if (!block) return false;

    if (this.collapsed.has(target.path)) {
      this.collapsed.delete(target.path);
      block.content.visible = true;
      this.paintHeader(block, this.activePath);
    }

    const span = matchCommentSpan(target, block.rows);

    if (!span || !block.diff) {
      this.scroller.scrollTo({ x: 0, y: this.blockTop(block) });
      return false;
    }

    const top = Math.max(0, block.diff.y - this.stack.y + span.start - 2);
    this.scroller.scrollTo({ x: 0, y: top });
    return true;
  }

  repaintComments(): void {
    for (const block of this.blocks) block.headerCounts.content = this.headerCountsContent(block.change);
    this.repaintAll();
  }

  showCommentComposer(target: CommentTarget, text: string, cursor: number): void {
    const targetChanged = this.editing?.target !== target;
    this.editing = { target, text, cursor };

    if (targetChanged) this.repaintAll();
    else this.placeComposer();

    const bottom = this.scroller.scrollTop + Math.max(1, this.scroller.viewport.height);
    const composerTop = typeof this.composer.root.top === "number" ? this.composer.root.top : 0;
    const composerBottom = composerTop + Math.max(this.composer.estimatedHeight(text), this.composer.root.height);

    if (this.composer.root.visible && composerBottom > bottom) {
      this.scroller.scrollBy({ x: 0, y: composerBottom - bottom });
    }
  }

  hideCommentComposer(): void {
    this.editing = undefined;
    this.composer.hide();
    this.stack.paddingBottom = 0;
    this.repaintAll();
  }

  private editedSpan(block: Block): { start: number; end: number } | undefined {
    const target = this.editing?.target;

    if (!target || target.path !== block.change.path || this.view !== "unified" || this.wrap) return undefined;

    return matchCommentSpan(target, block.rows);
  }

  private placeComposer(): void {
    const editing = this.editing;

    if (!editing) {
      this.composer.hide();
      this.stack.paddingBottom = 0;
      return;
    }

    const block = this.blocks.find((candidate) => candidate.change.path === editing.target.path);
    const span = block ? this.editedSpan(block) : undefined;
    const inline = Boolean(block?.diff && span && block.content.visible);
    const viewportWidth = this.scroller.viewport.width;
    const width: number | "100%" = viewportWidth > 20 ? viewportWidth - 1 : "100%";
    const top = inline && block?.diff && span ? block.diff.y - this.stack.y + span.end + 1 : this.scroller.scrollTop;
    this.composer.place(this.scroller.scrollLeft, top, width);
    this.composer.show(editing.target, editing.text, editing.cursor, this.options.isOutdated(editing.target));
    const composerHeight = Math.max(this.composer.estimatedHeight(editing.text), this.composer.root.height);
    this.stack.paddingBottom = inline ? composerHeight + 1 : 0;
  }

  private repaintAll(): void {
    for (const block of this.blocks) this.paintRows(block);

    this.placeComposer();
  }

  private paintRows(block: Block): void {
    const diff = block.diff;

    if (!diff) return;

    if (this.view !== "unified") {
      block.painted.clear();
      return;
    }

    const marked = this.options.comments.markedRows(block.change.path, block.rows);
    const special = new Set(marked.keys());
    const edited = this.editedSpan(block);

    if (edited) {
      for (let index = edited.start; index <= edited.end; index += 1) special.add(index);
    }

    if (this.gutterDrag?.path === block.change.path) {
      const start = Math.min(this.gutterDrag.startRow, this.gutterDrag.endRow);
      const end = Math.max(this.gutterDrag.startRow, this.gutterDrag.endRow);
      for (let index = start; index <= end; index += 1) special.add(index);
    }

    for (const index of block.painted) {
      if (!special.has(index)) diff.setLineColor(index, baseColors(diff, block.rows[index]?.mark));
    }

    for (const index of special) {
      diff.setLineColor(index, {
        gutter: theme.commentGutter,
        content: theme.commentBg,
      });
    }

    block.painted = special;
  }

  private createBlock(
    { change, patch }: FilePatch,
    index: number,
    minDigits: number,
    activePath: string | undefined,
  ): Block {
    const root = new BoxRenderable(this.context, {
      flexDirection: "column",
      flexShrink: 0,
      minWidth: "100%",
      marginTop: index ? 1 : 0,
    });
    const { header, headerTitle, headerCounts } = this.createHeader(change, index, activePath);
    root.add(header);
    const diff = patch.kind === "text" ? this.createDiff(change, patch.text, minDigits) : undefined;
    const content = diff ?? this.createNote(patch);
    content.visible = !this.collapsed.has(change.path);
    root.add(content);
    const block: Block = {
      change,
      patch,
      hunkLines: patch.kind === "text" ? hunkStartLines(patch.text) : [],
      rows: rowsOf(patch),
      painted: new Set(),
      root,
      header,
      headerTitle,
      headerCounts,
      content,
    };

    if (diff) block.diff = diff;

    return block;
  }

  private headerTitleContent(change: Change, active: boolean) {
    const { letter, color } = statusOf(change.kind);
    const mark = indexMark(change);
    const folder = posix.dirname(change.path);
    const folded = this.collapsed.has(change.path);
    const segments: Segment[] = [
      { text: active ? "▎ " : "  ", fg: theme.accent },
      { text: folded ? "▸ " : "▾ ", fg: theme.dim },
      { text: `${letter} `, fg: color, bold: true },
    ];

    if (mark) segments.push(mark, { text: " " });

    segments.push({
      text: displayLabel(posix.basename(change.path)),
      fg: active ? theme.accentSoft : theme.text,
      bold: true,
    });

    if (change.oldPath) segments.push({ text: `  ← ${displayLabel(change.oldPath)}`, fg: theme.dim });

    if (folder !== ".") segments.push({ text: `  ${displayLabel(folder)}/`, fg: theme.dim });

    return styled(segments);
  }

  private headerCountsContent(change: Change) {
    const count = this.options.comments.countForPath(change.path);
    const segments: Segment[] = [];

    if (count > 0) {
      segments.push({ text: `${count} ${count === 1 ? "comment" : "comments"}`, fg: theme.commentInk }, { text: "  " });
    }

    segments.push(...countSegments(change), ...statBarSegments(change));
    return styled(segments);
  }

  private paintHeader(block: Block, activePath: string | undefined): void {
    block.headerTitle.content = this.headerTitleContent(block.change, block.change.path === activePath);
  }

  private createHeader(
    change: Change,
    index: number,
    activePath: string | undefined,
  ): { header: BoxRenderable; headerTitle: TextRenderable; headerCounts: TextRenderable } {
    const active = change.path === activePath;
    const header = new BoxRenderable(this.context, {
      height: index ? 2 : 1,
      width: "100%",
      flexShrink: 0,
      flexDirection: "row",
      paddingRight: 1,
      backgroundColor: this.band,
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;

        event.preventDefault();
        this.options.onToggleCollapse(change.path);
      },
    });

    if (index > 0) {
      header.border = ["top"];
      header.borderColor = theme.border;
    }

    const headerTitle = new TextRenderable(this.context, {
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: "none",
      selectable: false,
      content: this.headerTitleContent(change, active),
    });
    header.add(headerTitle);
    const headerCounts = new TextRenderable(this.context, {
      height: 1,
      flexShrink: 0,
      marginLeft: 1,
      wrapMode: "none",
      selectable: false,
      content: this.headerCountsContent(change),
    });
    header.add(headerCounts);
    return { header, headerTitle, headerCounts };
  }

  private createDiff(change: Change, text: string, minDigits: number): DiffRenderable {
    return new DiffRenderable(this.context, {
      diff: text,
      view: this.view,
      wrapMode: "none",
      flexShrink: 0,
      conceal: false,
      fg: theme.text,
      selectionBg: theme.selectionBg,
      filetype: languageFor(change.path),
      syntaxStyle: this.options.syntax.style,
      treeSitterClient: this.options.syntax.client,
      lineNumberFg: theme.dim,
      gutter: { minDigits, paddingLeft: 1, paddingRight: 1 },
      ...diffColors(),
      onSizeChange: () => this.options.onLayout(),
      onMouseDown: (event) => this.startGutterDrag(change.path, event),
      onMouseDrag: (event) => this.updateGutterDrag(change.path, event),
      onMouseDragEnd: (event) => this.finishGutterDrag(change.path, event),
      onMouseUp: (event) => this.finishGutterDrag(change.path, event),
    });
  }

  private clearGutterDrag(): void {
    const drag = this.gutterDrag;

    if (!drag) return;

    this.gutterDrag = undefined;
    const block = this.blocks.find((candidate) => candidate.change.path === drag.path);

    if (block) this.paintRows(block);
  }

  private startGutterDrag(path: string, event: MouseEvent): void {
    if (this.gutterDrag) this.clearGutterDrag();

    const block = this.blocks.find((candidate) => candidate.change.path === path);
    const diff = block?.diff;

    if (!block || !diff || event.button !== MouseButton.LEFT || event.x - diff.x >= this.lastMinDigits + GUTTER_PADDING)
      return;

    event.preventDefault();
    event.stopPropagation();

    if (this.view !== "unified" || this.wrap) {
      this.options.onComment(undefined);
      return;
    }

    const row = event.y - diff.y;

    if (row < 0 || row >= block.rows.length) return;

    this.gutterDrag = { path, startRow: row, endRow: row };
    this.paintRows(block);
  }

  private updateGutterDrag(path: string, event: MouseEvent): void {
    const drag = this.gutterDrag;

    if (!drag || drag.path !== path) return;

    const block = this.blocks.find((candidate) => candidate.change.path === path);
    const diff = block?.diff;

    if (!block || !diff || !block.rows.length) return;

    event.preventDefault();
    event.stopPropagation();
    const row = Math.max(0, Math.min(block.rows.length - 1, event.y - diff.y));

    if (row === drag.endRow) return;

    drag.endRow = row;
    this.paintRows(block);
  }

  private finishGutterDrag(path: string, event: MouseEvent): void {
    const drag = this.gutterDrag;

    if (!drag || drag.path !== path) return;

    event.preventDefault();
    event.stopPropagation();
    this.gutterDrag = undefined;
    const block = this.blocks.find((candidate) => candidate.change.path === path);

    if (!block || drag.startRow >= block.rows.length) return;

    const diff = block.diff;
    const endRow =
      diff && block.rows.length ? Math.max(0, Math.min(block.rows.length - 1, event.y - diff.y)) : drag.endRow;
    const start = Math.min(drag.startRow, endRow);
    const end = Math.max(drag.startRow, endRow);
    const target = rangeTarget(path, block.rows.slice(start, end + 1));
    this.paintRows(block);

    if (target) this.options.onComment(target);
  }

  private createNote(patch: Patch): TextRenderable {
    return new TextRenderable(this.context, {
      height: 1,
      paddingLeft: 2,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      content: styled([{ text: patch.kind === "notice" ? patch.message : "", fg: theme.muted }]),
    });
  }

  private applyWrap(): void {
    for (const block of this.blocks) {
      block.root.flexShrink = this.wrap ? 1 : 0;

      if (block.diff) {
        block.diff.wrapMode = this.wrap ? "word" : "none";
        block.diff.flexShrink = this.wrap ? 1 : 0;
      }
    }
    this.stack.flexShrink = this.wrap ? 1 : 0;
    this.scroller.contentOptions = { flexDirection: "column", width: this.wrap ? "100%" : "auto" };
    this.scroller.scrollTo({ x: 0, y: this.scroller.scrollTop });
    this.repaintAll();
  }

  private blockTop(block: Block): number {
    return block.root.y - this.stack.y;
  }

  private hunkEntries(): HunkEntry[] {
    const entries: HunkEntry[] = [];
    for (const block of this.blocks) {
      if (!block.diff || !block.content.visible || block.patch.kind !== "text") continue;

      const top = block.diff.y - this.stack.y;
      const lines = block.hunkLines;
      const offsets = block.diff.getHunkRowOffsets();
      for (const [index, offset] of offsets.entries()) {
        const headerOffset = offset === 0 ? block.header.height : 0;
        entries.push({
          row: Math.max(0, top + offset - headerOffset),
          path: block.change.path,
          line: lines[index] ?? 1,
        });
      }
    }
    return entries;
  }

  private currentHunkIndex(): number | undefined {
    const top = this.scroller.scrollTop;
    let total = 0;
    let active = 0;
    for (const block of this.blocks) {
      if (!block.diff || !block.content.visible || block.patch.kind !== "text") continue;

      const blockDiffTop = block.diff.y - this.stack.y;
      const offsets = block.diff.getHunkRowOffsets();
      for (const offset of offsets) {
        const headerOffset = offset === 0 ? block.header.height : 0;
        const row = Math.max(0, blockDiffTop + offset - headerOffset);

        if (row <= top) active = total;

        total += 1;
      }
    }
    return total ? active + 1 : undefined;
  }
}
