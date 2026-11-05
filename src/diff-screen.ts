import {
  BoxRenderable,
  DiffRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type RenderContext,
  type SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core";
import { basename, join, posix } from "node:path";
import { ChangeList, countSegments, statusOf } from "./changes";
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
import { scrollbarStyle, styled } from "./styled";
import { theme, transparent } from "./theme";

export type DiffView = "unified" | "split";
/** Narrower than this, two side-by-side columns are unreadable, so split view stays off. */
export const MIN_SPLIT_COLUMNS = 60;

/** What the rest of the interface (header, footer) needs to know about the diff screen. */
export interface DiffState {
  repository: string;
  /** Number of changed files listed. */
  files: number;
  truncated: boolean;
  /** The highlighted file: the one picked in the list, or the one at the top of the reader while scrolling. */
  selected?: Change;
  /** Line counts and hunk count of everything in the reader. */
  patch?: { added: number; removed: number; hunks: number };
  view: DiffView;
  scope: DiffScope;
  /** True when the reader holds diffs to scroll, as opposed to the empty-state message. */
  showingDiff: boolean;
}

interface DiffScreenOptions {
  syntax: { style: SyntaxStyle; client: TreeSitterClient };
  /** Anything in `DiffState` changed. */
  onChange: () => void;
  /** The user opened the highlighted file (Enter or a click) and wants to read its diff. */
  onActivate: () => void;
  /** The user clicked a file that has no diff to read, so the click belongs to the list. */
  onFocusList: () => void;
  /** The diff's rendered size or scroll position changed, so the position readout may be stale. */
  onLayout: () => void;
  /** How often to re-read git while the screen is watched. */
  pollMs: number;
}

/** One file in the reader: a header band naming it, then its diff or a note about why there is none. */
interface Block {
  change: Change;
  patch: Patch;
  root: BoxRenderable;
  header: BoxRenderable;
  diff?: DiffRenderable;
}

function signature(result: ChangeSet): string {
  const rows = result.changes.map((change) =>
    [change.path, change.oldPath, change.kind, change.added, change.removed, change.binary].join("\0"),
  );
  return `${result.truncated}\n${rows.join("\n")}`;
}

/** Identity of what is on screen, so an unchanged re-read redraws nothing and keeps the scroll position. */
function contentKey(files: FilePatch[]): string {
  return files
    .map(({ change, patch }) => `${change.path}\0${patch.kind === "text" ? patch.text : patch.message}`)
    .join("\u0001");
}

/** Added and removed lines are tinted lightly so the diff reads on any terminal background. */
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

/**
 * Everything the diff screen needs: the list of changed files for the sidebar, the diffs for the reader, the
 * message shown when there is nothing to diff, and the git calls behind them. It never modifies the repository.
 */
export class DiffScreen {
  readonly list: ChangeList;
  /** Reader content, holding either the scrollable diffs or a centred message. */
  readonly body: BoxRenderable;
  /** The scrollable diffs, focusable like the file viewer. */
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
  private band: string = theme.fallbackBackground;
  /** What the empty-state message says, so it can be drawn again in other colours. */
  private empty?: { title: string; detail: string };
  /** Fingerprint of the list on screen, so a refresh only redraws it when something actually changed. */
  private signature = "";
  /** Fingerprint of the diffs on screen. */
  private shownKey = "";
  /**
   * Bumped whenever a read starts or the one in flight stops being wanted (new selection, scope change, empty list,
   * close), so a slow read for an earlier choice cannot overwrite a newer one.
   */
  private request = 0;
  /** True from the moment diffs are being read until they are on screen. */
  private pending = false;
  /** The user opened a file while its diff was still loading; hand focus over once it arrives. */
  private activateWhenReady = false;
  /** Set while the list is rebuilt behind the user's back, so the reader is not scrolled to the highlight. */
  private holdScroll = false;
  /** A file to scroll to once newly built blocks have been laid out. */
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

  /** Whether there is anything listed at all, whatever the highlighted file shows. */
  get hasChanges(): boolean {
    return this.changes.length > 0;
  }

  state(): DiffState {
    const totals = { added: 0, removed: 0, hunks: 0 };
    let anyText = false;
    for (const { patch } of this.blocks) {
      if (patch.kind !== "text") continue;
      anyText = true;
      totals.added += patch.added;
      totals.removed += patch.removed;
      totals.hunks += patch.hunks;
    }
    return {
      repository: this.repository ? basename(this.repository.root) : "",
      files: this.changes.length,
      truncated: this.truncated,
      ...(this.selected ? { selected: this.selected } : {}),
      ...(anyText ? { patch: totals } : {}),
      view: this.view,
      scope: this.scope,
      showingDiff: this.showingDiff,
    };
  }

  /** Draws the list and the diffs again in the colours of the mode now in use. Set the new tint first. */
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

  /** The tint behind each file's header band, matching the sidebar and footer. */
  setTint(color: string): void {
    this.band = color;
    for (const block of this.blocks) block.header.backgroundColor = color;
  }

  /**
   * Reads the repository containing `directory` and lists what changed. Throws a `GitError` with a message fit
   * for the footer when there is nothing to show, such as outside a repository.
   */
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

  /** Starts re-reading git in the background, so commits, staging and edits show up without pressing `r`. */
  watch(): void {
    if (this.watching) return;
    this.watching = true;
    this.schedule(this.options.pollMs);
  }

  unwatch(): void {
    this.watching = false;
    clearTimeout(this.timer);
  }

  /** Stops watching, forgets what was on screen and removes the private index copy. */
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
    if (repository) await closeRepository(repository);
  }

  /** Returns false, changing nothing, when the reader is too narrow for two side-by-side columns. */
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

  /** Switches between every file stacked in the reader and the highlighted file alone. */
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

  /** Scrolls so the next (1) or previous (-1) hunk, across every file in the reader, is at the top. */
  jumpHunk(direction: 1 | -1): void {
    const rows = this.hunkRows();
    const top = this.scroller.scrollTop;
    const target = direction > 0 ? rows.find((row) => row > top) : rows.findLast((row) => row < top);
    if (target !== undefined) this.scroller.scrollTo({ x: 0, y: target });
  }

  /**
   * The highlighted file on disk and the first line its diff changes, from the hunk header's new-file start. Undefined
   * for a deleted file, which has nothing on disk to open.
   */
  changedFile(): { path: string; line: number } | undefined {
    const change = this.selected;
    if (!change || !this.repository || change.kind === "deleted") return undefined;
    const block = this.blocks.find((candidate) => candidate.change.path === change.path);
    const text = block?.patch.kind === "text" ? block.patch.text : "";
    const start = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(text)?.[1];
    return { path: join(this.repository.root, change.path), line: Math.max(1, Number(start ?? 1)) };
  }

  /** Enter or a click on the highlighted file: hand focus to the reader, now or as soon as it has loaded. */
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
    } catch {
      // A failed read, such as git being busy, keeps what is on screen; the next poll tries again.
    }
    // A slow repository is polled less often, so watching never keeps git busy.
    if (this.watching) this.schedule(Math.max(this.options.pollMs, (Date.now() - started) * 3));
  }

  /** Re-reads the changes and, if the list did not move, the diffs themselves, which may have been edited. */
  private async refresh(): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const result = await listChanges(repository);
    if (repository !== this.repository) return;
    if (signature(result) !== this.signature) this.apply(result);
    else if (this.scope === "all") await this.loadAll();
    else if (this.selected) await this.reread(this.selected);
  }

  /** Shows a fresh list of changes, keeping the highlight on the same file where it still exists. */
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

  /** The list's highlight moved, by key or click. */
  private async select(change: Change | undefined): Promise<void> {
    this.selected = change;
    if (!change || !this.repository) return;
    if (this.scope === "all") {
      // Everything is already on screen; the reader just scrolls to this file's section.
      if (!this.holdScroll) this.jumpTo(change);
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

  /** Reads the highlighted file's diff again without touching the selection or any pending Enter. */
  private async reread(change: Change): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const patch = await this.read(repository, change);
    if (repository !== this.repository || this.scope !== "one" || this.selected !== change || this.pending) return;
    this.presentOne(change, patch);
  }

  /** Reads every file's diff for the stacked view. */
  private async loadAll(): Promise<void> {
    const repository = this.repository;
    if (!repository || this.scope !== "all" || !this.changes.length) return;
    const request = ++this.request;
    this.pending = true;
    let files: FilePatch[];
    try {
      files = await readAllPatches(repository, this.changes);
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
      return await readPatch(repository, change);
    } catch (error) {
      return { kind: "notice", message: error instanceof GitError ? error.message : describeError(error) };
    }
  }

  /** Puts one file alone on screen, doing nothing when it is already there as it is. */
  private presentOne(change: Change, patch: Patch): void {
    const key = contentKey([{ change, patch }]);
    if (key === this.shownKey) return;
    // The same file edited underneath the reader keeps its scroll position; a different file starts at the top.
    const sameFile = this.blocks.length === 1 && this.blocks[0]?.change.path === change.path;
    this.shownKey = key;
    this.show([{ change, patch }], sameFile ? "keep" : "top");
    this.options.onChange();
  }

  /** Replaces what the reader shows. The new blocks are built before the old are removed, so nothing blinks. */
  private show(files: FilePatch[], scroll: "keep" | "top"): void {
    const previous = this.blocks;
    this.blocks = files.map((file, index) => this.createBlock(file, index));
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

  private createBlock({ change, patch }: FilePatch, index: number): Block {
    const context = this.context;
    const root = new BoxRenderable(context, {
      flexDirection: "column",
      flexShrink: 0,
      minWidth: "100%",
      ...(index ? { marginTop: 1 } : {}),
    });
    const header = this.createHeader(change);
    root.add(header);
    const diff = patch.kind === "text" ? this.createDiff(change, patch.text) : undefined;
    root.add(diff ?? this.createNote(patch));
    return { change, patch, root, header, ...(diff ? { diff } : {}) };
  }

  /** The band naming a file: status letter, name, where it came from and lives, and its line counts. */
  private createHeader(change: Change): BoxRenderable {
    const context = this.context;
    const header = new BoxRenderable(context, {
      height: 1,
      width: "100%",
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: this.band,
    });
    const { letter, color } = statusOf(change.kind);
    const folder = posix.dirname(change.path);
    header.add(
      new TextRenderable(context, {
        height: 1,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        wrapMode: "none",
        selectable: false,
        content: styled([
          { text: `${letter} `, fg: color, bold: true },
          { text: displayLabel(posix.basename(change.path)), fg: theme.text, bold: true },
          ...(change.oldPath ? [{ text: `  ← ${displayLabel(change.oldPath)}`, fg: theme.dim }] : []),
          ...(folder === "." ? [] : [{ text: `  ${displayLabel(folder)}/`, fg: theme.dim }]),
        ]),
      }),
    );
    header.add(
      new TextRenderable(context, {
        height: 1,
        flexShrink: 0,
        marginLeft: 1,
        wrapMode: "none",
        selectable: false,
        content: styled(countSegments(change)),
      }),
    );
    return header;
  }

  private createDiff(change: Change, text: string): DiffRenderable {
    return new DiffRenderable(this.context, {
      diff: text,
      view: this.view,
      wrapMode: "none",
      flexShrink: 0,
      conceal: false,
      fg: theme.text,
      filetype: languageFor(change.path),
      syntaxStyle: this.options.syntax.style,
      treeSitterClient: this.options.syntax.client,
      lineNumberFg: theme.muted,
      ...diffColors(),
      onSizeChange: () => this.layoutChanged(),
    });
  }

  /** The line shown instead of a diff when there is nothing textual to show. */
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

  /** Wrapped text is laid out against the viewport width; unwrapped lines may run past it and scroll sideways. */
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

  /** Where a block starts, in rows from the top of the scrolled content. */
  private blockTop(block: Block): number {
    return block.root.y - this.stack.y;
  }

  private jumpTo(change: Change): void {
    const block = this.blocks.find((candidate) => candidate.change.path === change.path);
    if (block) this.scroller.scrollTo({ x: 0, y: this.blockTop(block) });
  }

  /** Scrolls to a file once layout has placed the freshly built blocks; before that every block sits at row 0. */
  private queueJump(): void {
    queueMicrotask(() => {
      const target = this.jumpAfterLayout;
      this.jumpAfterLayout = undefined;
      if (target && this.scope === "all") this.jumpTo(target);
    });
  }

  /** Rows where each hunk starts (the file's header band, for a hunk at the top of its diff). */
  private hunkRows(): number[] {
    const rows: number[] = [];
    for (const block of this.blocks) {
      if (!block.diff) continue;
      const top = block.diff.y - this.stack.y;
      for (const offset of block.diff.getHunkRowOffsets())
        rows.push(Math.max(0, top + offset - (offset === 0 ? 1 : 0)));
    }
    return rows;
  }

  private layoutChanged(): void {
    this.followScroll();
    this.options.onLayout();
  }

  /** While the reader has focus, the sidebar highlight follows whichever file is at the top of it. */
  private followScroll(): void {
    if (this.scope !== "all" || !this.scroller.focused || !this.blocks.length) return;
    const top = this.scroller.scrollTop;
    let current = this.blocks[0];
    for (const block of this.blocks) if (this.blockTop(block) <= top) current = block;
    if (!current || current.change.path === this.selected?.path) return;
    this.selected = current.change;
    this.list.highlight(current.change.path);
    this.options.onChange();
  }
}
