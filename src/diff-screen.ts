import {
  BoxRenderable,
  DiffRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
  type RenderContext,
  type SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core";
import { basename } from "node:path";
import { ChangeList } from "./changes";
import { languageFor } from "./code-view";
import { describeError } from "./files";
import {
  GitError, closeRepository, listChanges, openRepository, readPatch, type Change, type ChangeSet, type Patch, type Repository,
} from "./git";
import { styled } from "./styled";
import { theme } from "./theme";

export type DiffView = "unified" | "split";

/** What the rest of the interface (header, footer) needs to know about the diff screen. */
export interface DiffState {
  repository: string;
  /** Number of changed files listed. */
  files: number;
  truncated: boolean;
  selected?: Change;
  /** Line counts and hunk count of the diff on screen, when there is one. */
  patch?: { added: number; removed: number; hunks: number };
  view: DiffView;
  /** True when the reader shows a diff to scroll, rather than a message. */
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
  /** The diff's rendered size changed, so the scroll position readout may be stale. */
  onLayout: () => void;
  /** How often to re-read git while the screen is watched. */
  pollMs: number;
}

function signature(result: ChangeSet): string {
  const rows = result.changes.map((change) =>
    [change.path, change.oldPath, change.kind, change.added, change.removed, change.binary].join("\0"));
  return `${result.truncated}\n${rows.join("\n")}`;
}

/** Added and removed lines are tinted lightly so the diff reads on any terminal background. */
const diffColors = {
  addedBg: "#12281c", removedBg: "#2b1518", contextBg: RGBA.fromValues(0, 0, 0, 0),
  addedLineNumberBg: "#173a27", removedLineNumberBg: "#3b1b20",
  addedSignColor: theme.added, removedSignColor: theme.removed,
} as const;

/**
 * Everything the diff screen needs: the list of changed files for the sidebar, the diff for the reader, the
 * message shown when there is nothing to diff, and the git calls behind them. It never modifies the repository.
 */
export class DiffScreen {
  /** Sidebar content. */
  readonly list: ChangeList;
  /** Reader content, holding either the scrollable diff or a centred message. */
  readonly body: BoxRenderable;
  /** The scrollable diff, focusable like the file viewer. */
  readonly scroller: ScrollBoxRenderable;
  private readonly diff: DiffRenderable;
  private readonly message: BoxRenderable;
  private readonly messageTitle: TextRenderable;
  private readonly messageDetail: TextRenderable;
  private repository?: Repository;
  private changes: Change[] = [];
  private truncated = false;
  private selected?: Change;
  private patch?: Extract<Patch, { kind: "text" }>;
  private view: DiffView = "unified";
  private wrap = false;
  /** Bumped whenever the selection changes so a slow diff for an earlier file cannot overwrite a newer one. */
  private request = 0;
  /** True from the moment the selection moves until its diff has been read. */
  private pending = false;
  /** The user opened a file whose diff was still loading; hand focus over once it arrives. */
  private activateWhenReady = false;
  private watching = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** Fingerprint of the list on screen, so a refresh only redraws it when something actually changed. */
  private signature = "";
  /** Path of the file whose diff is on screen, if any. */
  private shownPath?: string;
  private messageKey = "";

  constructor(context: RenderContext, private readonly options: DiffScreenOptions) {
    this.list = new ChangeList(context, {
      onSelect: (change) => void this.select(change),
      onActivate: () => this.openSelected(),
    });
    this.body = new BoxRenderable(context, {
      id: "diff-body", flexGrow: 1, flexBasis: 0, minHeight: 0, minWidth: 0, flexDirection: "column",
    });
    this.scroller = new ScrollBoxRenderable(context, {
      id: "diff-scroller", width: "100%", flexGrow: 1, flexBasis: 0, minHeight: 0, scrollX: true, scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: { trackOptions: { backgroundColor: "transparent", foregroundColor: theme.muted } },
      horizontalScrollbarOptions: { visible: false },
      verticalScrollbarOptions: { onChange: () => options.onLayout() },
    });
    this.diff = new DiffRenderable(context, {
      id: "diff", diff: "", view: this.view, wrapMode: "none", flexShrink: 0, conceal: false, fg: theme.text,
      syntaxStyle: options.syntax.style, treeSitterClient: options.syntax.client, lineNumberFg: theme.muted,
      ...diffColors, onSizeChange: () => options.onLayout(),
    });
    this.scroller.add(this.diff);
    this.message = new BoxRenderable(context, {
      id: "diff-message", flexGrow: 1, flexBasis: 0, minHeight: 0, flexDirection: "column",
      alignItems: "center", justifyContent: "center",
    });
    this.messageTitle = new TextRenderable(context, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.messageDetail = new TextRenderable(context, {
      height: 1, flexShrink: 0, marginTop: 1, wrapMode: "none", selectable: false,
    });
    this.message.add(this.messageTitle);
    this.message.add(this.messageDetail);
    this.body.add(this.message);
    this.body.add(this.scroller);
    this.scroller.visible = false;
  }

  get showingDiff(): boolean {
    return this.patch !== undefined;
  }

  /** Whether there is anything listed at all, whatever the highlighted file shows. */
  get hasChanges(): boolean {
    return this.changes.length > 0;
  }

  state(): DiffState {
    return {
      repository: this.repository ? basename(this.repository.root) : "",
      files: this.changes.length,
      truncated: this.truncated,
      ...(this.selected ? { selected: this.selected } : {}),
      ...(this.patch ? { patch: { added: this.patch.added, removed: this.patch.removed, hunks: this.patch.hunks } } : {}),
      view: this.view,
      showingDiff: this.showingDiff,
    };
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

  private directory = "";

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
    this.patch = undefined;
    this.shownPath = undefined;
    this.signature = "";
    this.pending = false;
    this.activateWhenReady = false;
    if (repository) await closeRepository(repository);
  }

  toggleView(): void {
    this.view = this.view === "unified" ? "split" : "unified";
    this.diff.view = this.view;
    this.options.onChange();
  }

  setWrap(wrap: boolean): void {
    this.wrap = wrap;
    this.applyWrap();
    this.options.onChange();
  }

  /** Scrolls so the next (1) or previous (-1) hunk starts at the top of the reader. */
  jumpHunk(direction: 1 | -1): void {
    const offsets = this.diff.getHunkRowOffsets();
    const top = this.scroller.scrollTop;
    const target = direction > 0 ? offsets.find((offset) => offset > top) : [...offsets].reverse().find((offset) => offset < top);
    if (target !== undefined) this.scroller.scrollTo({ x: 0, y: target });
  }

  /** Enter or a click on the highlighted file: hand focus to its diff, now or as soon as it has loaded. */
  openSelected(): void {
    if (this.pending) this.activateWhenReady = true;
    else if (this.patch) this.options.onActivate();
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

  /** Re-reads the changes and, if the list did not move, the highlighted file's diff, which may have been edited. */
  private async refresh(): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const result = await listChanges(repository);
    if (repository !== this.repository) return;
    if (signature(result) !== this.signature) this.apply(result);
    else if (this.selected) await this.reread(this.selected);
  }

  /** Shows a fresh list of changes, keeping the highlight on the same file where it still exists. */
  private apply(result: ChangeSet): void {
    const keep = this.selected?.path;
    this.changes = result.changes;
    this.truncated = result.truncated;
    this.signature = signature(result);
    if (result.changes.length) {
      this.list.show(result.changes, keep);
    } else {
      this.request += 1;
      this.selected = undefined;
      this.pending = false;
      this.activateWhenReady = false;
      this.list.show([]);
      this.showMessage("No changes", `The working tree matches ${this.baseLabel()}.`);
    }
    this.options.onChange();
  }

  private baseLabel(): string {
    return this.repository?.base === "HEAD" ? "HEAD" : "an empty repository";
  }

  private async select(change: Change | undefined): Promise<void> {
    const request = ++this.request;
    this.selected = change;
    this.activateWhenReady = false;
    this.pending = change !== undefined;
    if (!change || !this.repository) return;
    const patch = await this.read(this.repository, change);
    if (request !== this.request) return;
    this.pending = false;
    this.present(change, patch);
    if (this.activateWhenReady) {
      this.activateWhenReady = false;
      if (this.patch) this.options.onActivate();
      else this.options.onFocusList();
    }
  }

  /** Reads the highlighted file's diff again without touching the selection or any pending Enter. */
  private async reread(change: Change): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    const patch = await this.read(repository, change);
    if (repository !== this.repository || this.selected !== change || this.pending) return;
    this.present(change, patch);
  }

  private async read(repository: Repository, change: Change): Promise<Patch> {
    try {
      return await readPatch(repository, change);
    } catch (error) {
      return { kind: "notice", message: error instanceof GitError ? error.message : describeError(error) };
    }
  }

  /** Puts a diff or message on screen, doing nothing when it is what the reader already shows. */
  private present(change: Change, patch: Patch): void {
    if (patch.kind === "text") {
      if (this.shownPath === change.path && this.patch?.text === patch.text) return;
      this.showPatch(change, patch);
    } else if (!this.showMessage(change.path, patch.message)) {
      return;
    }
    this.options.onChange();
  }

  private showPatch(change: Change, patch: Extract<Patch, { kind: "text" }>): void {
    // The same file edited underneath the reader keeps its scroll position; a different file starts at the top.
    const sameFile = this.shownPath === change.path;
    this.shownPath = change.path;
    this.messageKey = "";
    this.patch = patch;
    this.diff.filetype = languageFor(change.path);
    this.diff.diff = patch.text;
    this.applyWrap();
    this.scroller.visible = true;
    this.message.visible = false;
    if (!sameFile) this.scroller.scrollTo({ x: 0, y: 0 });
  }

  /** Returns false when this exact message is already showing. */
  private showMessage(title: string, detail: string): boolean {
    const key = `${title}\0${detail}`;
    if (key === this.messageKey && this.patch === undefined) return false;
    this.messageKey = key;
    this.shownPath = undefined;
    this.patch = undefined;
    this.messageTitle.content = styled([{ text: title, fg: theme.text, bold: true }]);
    this.messageDetail.content = styled([{ text: detail, fg: theme.muted }]);
    this.messageDetail.visible = detail !== "";
    this.message.visible = true;
    this.scroller.visible = false;
    return true;
  }

  /** Wrapped text is laid out against the viewport width; unwrapped lines may run past it and scroll sideways. */
  private applyWrap(): void {
    this.diff.wrapMode = this.wrap ? "word" : "none";
    this.diff.flexShrink = this.wrap ? 1 : 0;
    this.scroller.contentOptions = { flexDirection: "column", width: this.wrap ? "100%" : "auto" };
    this.scroller.scrollTo({ x: 0, y: this.scroller.scrollTop });
  }
}
