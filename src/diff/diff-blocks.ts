import {
  BoxRenderable,
  DiffRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  type RenderContext,
  type SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core";
import { posix } from "node:path";
import { displayLabel } from "../core/files";
import { languageFor } from "../reader/code-view";
import { paintScrollbar, scrollbarStyle, styled } from "../ui/styled";
import { theme, transparent } from "../ui/theme";
import type { DiffScope, Segment } from "../ui/types";
import { countSegments, indexMark, statusOf } from "./changes";
import type { Change, DiffView, FilePatch, HunkJumpResult, Patch } from "./types";

export const MIN_SPLIT_COLUMNS = 60;
const STAT_BAR_CELLS = 5;

interface DiffBlocksOptions {
  syntax: { style: SyntaxStyle; client: TreeSitterClient };
  onToggleCollapse: (path: string) => void;
  onLayout: () => void;
}

interface Block {
  change: Change;
  patch: Patch;
  hunkLines: number[];
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
      block.headerCounts.content = styled([...countSegments(block.change), ...statBarSegments(block.change)]);

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
  }

  setTint(color: string): void {
    this.band = color;
    for (const block of this.blocks) block.header.backgroundColor = color;
  }

  toggleCollapse(path: string, activePath: string | undefined): void {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);

    for (const block of this.blocks) {
      if (block.change.path === path) {
        block.content.visible = !this.collapsed.has(path);
        this.paintHeader(block, activePath);
      }
    }
  }

  toggleView(bodyWidth: number): boolean {
    if (this.view === "unified" && bodyWidth < MIN_SPLIT_COLUMNS) return false;

    this.view = this.view === "unified" ? "split" : "unified";
    for (const block of this.blocks) if (block.diff) block.diff.view = this.view;
    return true;
  }

  setWrap(wrap: boolean): void {
    this.wrap = wrap;
    this.applyWrap();
  }

  clear(): void {
    for (const block of this.blocks) block.root.destroyRecursively();
    this.blocks = [];
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
          block.headerCounts.content = styled([...countSegments(change), ...statBarSegments(change)]);
        }

        if (!patchEqual(block.patch, patch)) {
          block.content.destroyRecursively();
          const diff = patch.kind === "text" ? this.createDiff(change, patch.text, minDigits) : undefined;
          const content = diff ?? this.createNote(patch);
          content.visible = !this.collapsed.has(change.path);
          block.root.add(content);
          block.patch = patch;
          block.hunkLines = patch.kind === "text" ? hunkStartLines(patch.text) : [];
          block.content = content;
          block.diff = diff;
        }
      }
    } else {
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
    const rightSegments: Segment[] = [...countSegments(change), ...statBarSegments(change)];
    const headerCounts = new TextRenderable(this.context, {
      height: 1,
      flexShrink: 0,
      marginLeft: 1,
      wrapMode: "none",
      selectable: false,
      content: styled(rightSegments),
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
    });
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
