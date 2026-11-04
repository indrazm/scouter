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
  GitError, closeRepository, listChanges, openRepository, readPatch, type Change, type Patch, type Repository,
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
  /** The diff's rendered size changed, so the scroll position readout may be stale. */
  onLayout: () => void;
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
    const keep = this.selected?.path;
    const previous = this.repository;
    const repository = previous && directory === this.directory ? previous : await openRepository(directory);
    let result;
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
    this.changes = result.changes;
    this.truncated = result.truncated;
    this.request += 1;
    this.selected = undefined;
    this.patch = undefined;
    this.pending = false;
    this.activateWhenReady = false;
    if (!result.changes.length) {
      this.list.show([]);
      this.showMessage("No changes", this.repository ? `The working tree matches ${this.baseLabel()}.` : "");
      this.options.onChange();
      return;
    }
    this.list.show(result.changes, keep);
  }

  private directory = "";

  async close(): Promise<void> {
    const repository = this.repository;
    this.repository = undefined;
    this.directory = "";
    this.request += 1;
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

  private baseLabel(): string {
    return this.repository?.base === "HEAD" ? "HEAD" : "an empty repository";
  }

  private async select(change: Change | undefined): Promise<void> {
    const request = ++this.request;
    this.selected = change;
    this.activateWhenReady = false;
    this.pending = change !== undefined;
    if (!change || !this.repository) return;
    let patch: Patch;
    try {
      patch = await readPatch(this.repository, change);
    } catch (error) {
      patch = { kind: "notice", message: error instanceof GitError ? error.message : describeError(error) };
    }
    if (request !== this.request) return;
    this.pending = false;
    if (patch.kind === "text") this.showPatch(change, patch);
    else this.showMessage(change.path, patch.message);
    this.options.onChange();
    if (this.activateWhenReady) {
      this.activateWhenReady = false;
      if (this.patch) this.options.onActivate();
    }
  }

  /** Enter or a click on the highlighted file: hand focus to its diff, now or as soon as it has loaded. */
  openSelected(): void {
    if (this.pending) this.activateWhenReady = true;
    else if (this.patch) this.options.onActivate();
  }

  private showPatch(change: Change, patch: Extract<Patch, { kind: "text" }>): void {
    this.patch = patch;
    this.diff.filetype = languageFor(change.path);
    this.diff.diff = patch.text;
    this.applyWrap();
    this.scroller.visible = true;
    this.message.visible = false;
    this.scroller.scrollTo({ x: 0, y: 0 });
  }

  private showMessage(title: string, detail: string): void {
    this.patch = undefined;
    this.messageTitle.content = styled([{ text: title, fg: theme.text, bold: true }]);
    this.messageDetail.content = styled([{ text: detail, fg: theme.muted }]);
    this.messageDetail.visible = detail !== "";
    this.message.visible = true;
    this.scroller.visible = false;
  }

  /** Wrapped text is laid out against the viewport width; unwrapped lines may run past it and scroll sideways. */
  private applyWrap(): void {
    this.diff.wrapMode = this.wrap ? "word" : "none";
    this.diff.flexShrink = this.wrap ? 1 : 0;
    this.scroller.contentOptions = { flexDirection: "column", width: this.wrap ? "100%" : "auto" };
    this.scroller.scrollTo({ x: 0, y: this.scroller.scrollTop });
  }
}
