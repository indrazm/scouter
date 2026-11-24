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
import { basename, join, posix } from "node:path";
import { ChangeList, countSegments, indexMark, statusOf } from "./changes";
import { languageFor } from "./code-view";
import { describeError, displayLabel } from "./files";
import type { DiffScope } from "./footer";
import {
  GitError,
  closeRepository,
  listChanges,
  openRepository,
  readAllPatches,
  readPatch,
  type Change,
  type ChangeSet,
  type FilePatch,
  type Patch,
  type Repository,
} from "./git";
import { scrollbarStyle, styled, type Segment } from "./styled";
import { theme, transparent } from "./theme";

export type DiffView = "unified" | "split";
export type HunkJumpResult = "moved" | "first" | "last" | "none";
export const MIN_SPLIT_COLUMNS = 60;
const NORMAL_CONTEXT_LINES = 3;
const WIDE_CONTEXT_LINES = 12;
const STAT_BAR_CELLS = 5;

export interface DiffState {
  repository: string;
  files: number;
  truncated: boolean;
  selected?: Change;
  patch?: { added: number; removed: number; hunks: number; hunkIndex?: number };
  view: DiffView;
  scope: DiffScope;
  expandedContext: boolean;
  showingDiff: boolean;
}

interface DiffScreenOptions {
  syntax: { style: SyntaxStyle; client: TreeSitterClient };
  onChange: () => void;
  onActivate: () => void;
  onFocusList: () => void;
  onLayout: () => void;
  pollMs: number;
}

interface Block {
  change: Change;
  patch: Patch;
  root: BoxRenderable;
  header: BoxRenderable;
  headerTitle: TextRenderable;
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

function signature(result: ChangeSet): string {
  const rows = result.changes.map((change) =>
    [change.path, change.oldPath, change.kind, change.added, change.removed, change.binary].join("\0"),
  );
  return `${result.truncated}\n${rows.join("\n")}`;
}

function contentKey(files: FilePatch[]): string {
  return files
    .map(({ change, patch }) => `${change.path}\0${patch.kind === "text" ? patch.text : patch.message}`)
    .join("\u0001");
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

export class DiffScreen {
  readonly list: ChangeList;
  readonly body: BoxRenderable;
  readonly scroller: ScrollBoxRenderable;
  private readonly stack: BoxRenderable;
  private readonly message: BoxRenderable;
  private readonly messageTitle: TextRenderable;
  private readonly messageDetail: TextRenderable;
  private repository?: Repository;
  private directory = "";
  private changes: Change[] = [];
  private truncated = false;
  private selected?: Change;
  private blocks: Block[] = [];
  private view: DiffView = "unified";
  private scope: DiffScope = "all";
  private wrap = false;
  private expandedContext = false;
  private collapsed = new Set<string>();
  private lastHunkIndex?: number;
  private band: string = theme.fallbackBackground;
  private empty?: { title: string; detail: string };
  private signature = "";
  private shownKey = "";
  private request = 0;
  private pending = false;
  private activateWhenReady = false;
  private holdScroll = false;
  private jumpAfterLayout?: Change;
  private watching = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    context: RenderContext,
    private readonly options: DiffScreenOptions,
  ) {
    this.list = new ChangeList(context, {
      onSelect: (change) => void this.select(change),
      onActivate: () => this.openSelected(),
    });
    this.body = new BoxRenderable(context, {
      id: "diff-body",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
    });
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
      horizontalScrollbarOptions: { visible: false },
      verticalScrollbarOptions: { onChange: () => this.layoutChanged() },
    });
    this.stack = new BoxRenderable(context, {
      id: "diff-stack",
      flexDirection: "column",
      flexShrink: 0,
      minWidth: "100%",
    });
    this.scroller.add(this.stack);
    this.message = new BoxRenderable(context, {
      id: "diff-message",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    });
    this.messageTitle = new TextRenderable(context, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.messageDetail = new TextRenderable(context, {
      height: 1,
      flexShrink: 0,
      marginTop: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.message.add(this.messageTitle);
    this.message.add(this.messageDetail);
    this.body.add(this.message);
    this.body.add(this.scroller);
    this.scroller.visible = false;
  }

  private get context(): RenderContext {
    return this.list.ctx;
  }

  get showingDiff(): boolean {
    return this.blocks.length > 0;
  }

  get hasChanges(): boolean {
    return this.changes.length > 0;
  }

  state(): DiffState {
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

    const activeHunk = this.currentHunkIndex();

    if (activeHunk !== undefined) totals.hunkIndex = activeHunk;

    const state: DiffState = {
      repository: this.repository ? basename(this.repository.root) : "",
      files: this.changes.length,
      truncated: this.truncated,
      view: this.view,
      scope: this.scope,
      expandedContext: this.expandedContext,
      showingDiff: this.showingDiff,
    };

    if (this.selected) state.selected = this.selected;

    if (anyText) state.patch = totals;

    return state;
  }

  restyle(): void {
    this.list.repaint();
    this.scroller.scrollbarOptions = scrollbarStyle();

    if (this.blocks.length)
      this.show(
        this.blocks.map(({ change, patch }) => ({ change, patch })),
        "keep",
      );
    else if (this.empty) this.showEmpty(this.empty.title, this.empty.detail);
  }

  setTint(color: string): void {
    this.band = color;
    for (const block of this.blocks) block.header.backgroundColor = color;
  }

  async load(directory: string): Promise<void> {
    const previous = this.repository;
    const repository = previous && directory === this.directory ? previous : await openRepository(directory);
    let result: ChangeSet;
    try {
      result = await listChanges(repository);
    } catch (error) {
      if (repository !== previous) await closeRepository(repository);

      throw error;
    }

    if (repository !== previous) {
      if (previous) await closeRepository(previous);

      this.repository = repository;
      this.directory = directory;
    }

    this.apply(result);
  }

  watch(): void {
    if (this.watching) return;

    this.watching = true;
    this.schedule(this.options.pollMs);
  }

  unwatch(): void {
    this.watching = false;
    clearTimeout(this.timer);
  }

  async close(): Promise<void> {
    this.unwatch();
    const repository = this.repository;
    this.repository = undefined;
    this.directory = "";
    this.request += 1;
    this.changes = [];
    this.selected = undefined;
    this.clearBlocks();
    this.signature = "";
    this.shownKey = "";
    this.pending = false;
    this.activateWhenReady = false;
    this.jumpAfterLayout = undefined;
    this.collapsed.clear();
    this.lastHunkIndex = undefined;

    if (repository) await closeRepository(repository);
  }

  toggleContext(): void {
    this.expandedContext = !this.expandedContext;
    this.shownKey = "";
    this.request += 1;
    this.activateWhenReady = false;

    if (this.scope === "all") {
      this.jumpAfterLayout = this.selected;
      void this.loadAll();
    } else if (this.selected) {
      void this.select(this.selected);
    }

    this.options.onChange();
  }

  toggleCollapse(path?: string): void {
    const target = path ?? this.selected?.path;

    if (!target) return;

    if (this.collapsed.has(target)) this.collapsed.delete(target);
    else this.collapsed.add(target);

    for (const block of this.blocks) {
      if (block.change.path === target) block.content.visible = !this.collapsed.has(target);
    }
    this.paintHeaders();
    this.options.onChange();
  }

  private contextLines(): number {
    return this.expandedContext ? WIDE_CONTEXT_LINES : NORMAL_CONTEXT_LINES;
  }

  toggleView(): boolean {
    if (this.view === "unified" && this.body.width < MIN_SPLIT_COLUMNS) return false;

    this.view = this.view === "unified" ? "split" : "unified";
    for (const block of this.blocks) if (block.diff) block.diff.view = this.view;
    this.options.onChange();
    return true;
  }

  setWrap(wrap: boolean): void {
    this.wrap = wrap;
    this.applyWrap();
    this.options.onChange();
  }

  toggleScope(): void {
    this.scope = this.scope === "all" ? "one" : "all";
    this.shownKey = "";
    this.request += 1;
    this.activateWhenReady = false;

    if (this.scope === "all") {
      this.jumpAfterLayout = this.selected;
      void this.loadAll();
    } else if (this.selected) {
      void this.select(this.selected);
    }

    this.options.onChange();
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

  changedFile(): { path: string; line: number } | undefined {
    const change = this.selected;

    if (!change || !this.repository || change.kind === "deleted") return undefined;

    const entries = this.hunkEntries().filter((entry) => entry.path === change.path);
    const top = this.scroller.scrollTop;
    const active = entries.findLast((entry) => entry.row <= top) ?? entries[0];

    if (active) return { path: join(this.repository.root, change.path), line: active.line };

    const block = this.blocks.find((candidate) => candidate.change.path === change.path);
    const text = block?.patch.kind === "text" ? block.patch.text : "";
    const start = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(text)?.[1];
    return { path: join(this.repository.root, change.path), line: Math.max(1, Number(start ?? 1)) };
  }

  openSelected(): void {
    if (this.pending) this.activateWhenReady = true;
    else if (this.blocks.length) this.options.onActivate();
    else this.options.onFocusList();
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => void this.poll(), delay);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this.watching) return;

    const started = Date.now();
    try {
      await this.refresh();
    } catch {}

    if (this.watching) this.schedule(Math.max(this.options.pollMs, (Date.now() - started) * 3));
  }

  private async refresh(): Promise<void> {
    const repository = this.repository;

    if (!repository) return;

    const result = await listChanges(repository);

    if (repository !== this.repository) return;

    if (signature(result) !== this.signature) this.apply(result);
    else if (this.scope === "all") await this.loadAll();
    else if (this.selected) await this.reread(this.selected);
  }

  private apply(result: ChangeSet): void {
    const keep = this.selected?.path;
    this.changes = result.changes;
    this.truncated = result.truncated;
    this.signature = signature(result);

    if (result.changes.length) {
      this.holdScroll = true;
      try {
        this.list.show(result.changes, keep, result.truncated);
      } finally {
        this.holdScroll = false;
      }

      if (this.scope === "all") void this.loadAll();
    } else {
      this.request += 1;
      this.selected = undefined;
      this.pending = false;
      this.activateWhenReady = false;
      this.list.show([]);
      this.showEmpty("No changes", `The working tree matches ${this.baseLabel()}.`);
    }

    this.options.onChange();
  }

  private baseLabel(): string {
    return this.repository?.base === "HEAD" ? "HEAD" : "an empty repository";
  }

  private async select(change: Change | undefined): Promise<void> {
    this.selected = change;

    if (!change || !this.repository) return;

    if (this.scope === "all") {
      if (!this.holdScroll) this.jumpTo(change);

      this.paintHeaders();
      this.options.onChange();
      return;
    }

    const request = ++this.request;
    this.activateWhenReady = false;
    this.pending = true;
    const patch = await this.read(this.repository, change);

    if (request !== this.request) return;

    this.pending = false;
    this.presentOne(change, patch);
    this.finishPending();
  }

  private async reread(change: Change): Promise<void> {
    const repository = this.repository;

    if (!repository) return;

    const patch = await this.read(repository, change);

    if (repository !== this.repository || this.scope !== "one" || this.selected !== change || this.pending) return;

    this.presentOne(change, patch);
  }

  private async loadAll(): Promise<void> {
    const repository = this.repository;

    if (!repository || this.scope !== "all" || !this.changes.length) return;

    const request = ++this.request;
    this.pending = true;
    let files: FilePatch[];
    try {
      files = await readAllPatches(repository, this.changes, this.contextLines());
    } catch {
      this.pending = false;
      return;
    }

    if (request !== this.request || repository !== this.repository) return;

    this.pending = false;
    const key = contentKey(files);

    if (key !== this.shownKey) {
      this.shownKey = key;
      this.show(files, "keep");
      this.options.onChange();
    }

    this.finishPending();
  }

  private finishPending(): void {
    if (!this.activateWhenReady) return;

    this.activateWhenReady = false;

    if (this.blocks.length) this.options.onActivate();
    else this.options.onFocusList();
  }

  private async read(repository: Repository, change: Change): Promise<Patch> {
    try {
      return await readPatch(repository, change, this.contextLines());
    } catch (error) {
      return { kind: "notice", message: error instanceof GitError ? error.message : describeError(error) };
    }
  }

  private presentOne(change: Change, patch: Patch): void {
    const key = contentKey([{ change, patch }]);

    if (key === this.shownKey) return;

    const sameFile = this.blocks.length === 1 && this.blocks[0]?.change.path === change.path;
    this.shownKey = key;
    this.show([{ change, patch }], sameFile ? "keep" : "top");
    this.options.onChange();
  }

  private show(files: FilePatch[], scroll: "keep" | "top"): void {
    const previous = this.blocks;
    const minDigits = maxGutterDigits(files);
    this.blocks = files.map((file, index) => this.createBlock(file, index, minDigits));
    for (const block of this.blocks) this.stack.add(block.root);
    for (const block of previous) block.root.destroyRecursively();
    this.message.visible = false;
    this.scroller.visible = true;
    this.applyWrap();

    if (scroll === "top") this.scroller.scrollTo({ x: 0, y: 0 });

    if (this.scope === "all" && this.jumpAfterLayout) this.queueJump();
  }

  private showEmpty(title: string, detail: string): void {
    this.empty = { title, detail };
    this.clearBlocks();
    this.shownKey = "";
    this.messageTitle.content = styled([{ text: title, fg: theme.text, bold: true }]);
    this.messageDetail.content = styled([{ text: detail, fg: theme.muted }]);
    this.messageDetail.visible = detail !== "";
    this.message.visible = true;
    this.scroller.visible = false;
  }

  private clearBlocks(): void {
    for (const block of this.blocks) block.root.destroyRecursively();
    this.blocks = [];
  }

  private createBlock({ change, patch }: FilePatch, index: number, minDigits: number): Block {
    const context = this.context;
    const root = new BoxRenderable(context, {
      flexDirection: "column",
      flexShrink: 0,
      minWidth: "100%",
      marginTop: index ? 1 : 0,
    });
    const { header, headerTitle } = this.createHeader(change, index);
    root.add(header);
    const diff = patch.kind === "text" ? this.createDiff(change, patch.text, minDigits) : undefined;
    const content = diff ?? this.createNote(patch);
    content.visible = !this.collapsed.has(change.path);
    root.add(content);
    const block: Block = { change, patch, root, header, headerTitle, content };

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

  private paintHeaders(): void {
    for (const block of this.blocks) {
      const active = this.scope === "all" && block.change.path === this.selected?.path;
      block.headerTitle.content = this.headerTitleContent(block.change, active);
    }
  }

  private createHeader(change: Change, index: number): { header: BoxRenderable; headerTitle: TextRenderable } {
    const context = this.context;
    const active = this.scope === "all" && change.path === this.selected?.path;
    const header = new BoxRenderable(context, {
      height: index ? 2 : 1,
      width: "100%",
      flexShrink: 0,
      flexDirection: "row",
      paddingRight: 1,
      backgroundColor: this.band,
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;

        event.preventDefault();
        this.toggleCollapse(change.path);
      },
    });

    if (index > 0) {
      header.border = ["top"];
      header.borderColor = theme.border;
    }

    const headerTitle = new TextRenderable(context, {
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
    header.add(
      new TextRenderable(context, {
        height: 1,
        flexShrink: 0,
        marginLeft: 1,
        wrapMode: "none",
        selectable: false,
        content: styled(rightSegments),
      }),
    );
    return { header, headerTitle };
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
      onSizeChange: () => this.layoutChanged(),
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

  private jumpTo(change: Change): void {
    const block = this.blocks.find((candidate) => candidate.change.path === change.path);

    if (block) this.scroller.scrollTo({ x: 0, y: this.blockTop(block) });
  }

  private queueJump(): void {
    queueMicrotask(() => {
      const target = this.jumpAfterLayout;
      this.jumpAfterLayout = undefined;

      if (target && this.scope === "all") this.jumpTo(target);
    });
  }

  private hunkEntries(): HunkEntry[] {
    const entries: HunkEntry[] = [];
    for (const block of this.blocks) {
      if (!block.diff || !block.content.visible || block.patch.kind !== "text") continue;

      const top = block.diff.y - this.stack.y;
      const lines = hunkStartLines(block.patch.text);
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
    const entries = this.hunkEntries();

    if (!entries.length) return undefined;

    const top = this.scroller.scrollTop;
    let index = 0;
    for (let current = 0; current < entries.length; current += 1) {
      if ((entries[current]?.row ?? 0) <= top) index = current;
    }
    return index + 1;
  }

  private layoutChanged(): void {
    this.followScroll();
    this.options.onLayout();
  }

  private followScroll(): void {
    if (!this.blocks.length) return;

    const hunkIndex = this.currentHunkIndex();
    const hunkChanged = hunkIndex !== this.lastHunkIndex;
    this.lastHunkIndex = hunkIndex;

    if (this.scope !== "all" || !this.scroller.focused) {
      if (hunkChanged) this.options.onChange();

      return;
    }

    const top = this.scroller.scrollTop;
    let current = this.blocks[0];
    for (const block of this.blocks) if (this.blockTop(block) <= top) current = block;

    if (!current || current.change.path === this.selected?.path) {
      if (hunkChanged) this.options.onChange();

      return;
    }

    this.selected = current.change;
    this.list.highlight(current.change.path);
    this.paintHeaders();
    this.options.onChange();
  }
}
