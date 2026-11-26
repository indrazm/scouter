import {
  BoxRenderable,
  TextRenderable,
  type RenderContext,
  type ScrollBoxRenderable,
  type SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core";
import { basename, join } from "node:path";
import { describeError } from "../core/files";
import type { ReviewComments } from "../review/comments";
import type { CommentTarget, ReviewComment } from "../review/types";
import { styled } from "../ui/styled";
import { theme } from "../ui/theme";
import type { DiffScope } from "../ui/types";
import { ChangeList } from "./changes";
import { DiffBlocks, MIN_SPLIT_COLUMNS } from "./diff-blocks";
import { GitError, changesStamp, closeRepository, listChanges, openRepository } from "./git";
import { readAllPatches, readPatch } from "./patch";
import type { Change, ChangeSet, DiffState, FilePatch, HunkJumpResult, Patch, Repository } from "./types";

export { MIN_SPLIT_COLUMNS };

const NORMAL_CONTEXT_LINES = 3;
const WIDE_CONTEXT_LINES = 12;
const MAX_POLL_MS = 30_000;

interface DiffScreenOptions {
  syntax: { style: SyntaxStyle; client: TreeSitterClient };
  comments: ReviewComments;
  onChange: () => void;
  onComment: (target: CommentTarget | undefined) => void;
  onCommentMissing: () => void;
  onActivate: () => void;
  onFocusList: () => void;
  onLayout: () => void;
  pollMs: number;
}

function signature(result: ChangeSet): string {
  const rows = result.changes.map((change) =>
    [
      change.path,
      change.oldPath,
      change.kind,
      change.added,
      change.removed,
      change.binary,
      change.staged,
      change.unstaged,
    ].join("\0"),
  );
  return `${result.truncated}\n${rows.join("\n")}`;
}

function contentKey(files: FilePatch[]): string {
  return files
    .map(({ change, patch }) =>
      [
        change.path,
        change.kind,
        change.oldPath,
        change.staged,
        change.unstaged,
        change.added,
        change.removed,
        change.binary,
        patch.kind === "text" ? patch.text : patch.message,
      ].join("\0"),
    )
    .join("\u0001");
}

export class DiffScreen {
  readonly list: ChangeList;
  readonly body: BoxRenderable;
  readonly scroller: ScrollBoxRenderable;
  private readonly blocks: DiffBlocks;
  private readonly message: BoxRenderable;
  private readonly messageTitle: TextRenderable;
  private readonly messageDetail: TextRenderable;
  private repository?: Repository;
  private directory = "";
  private changes: Change[] = [];
  private truncated = false;
  private selected?: Change;
  private scope: DiffScope = "all";
  private expandedContext = false;
  private empty?: { title: string; detail: string };
  private signature = "";
  private patchStamp = "";
  private shownKey = "";
  private request = 0;
  private pending = false;
  private activateWhenReady = false;
  private holdScroll = false;
  private jumpAfterLayout?: Change;
  private jumpCommentAfterLayout?: CommentTarget;
  private watching = false;
  private watchSession = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    context: RenderContext,
    private readonly options: DiffScreenOptions,
  ) {
    this.list = new ChangeList(context, {
      onSelect: (change) => void this.select(change),
      onActivate: () => this.openSelected(),
      commentCount: (path) => options.comments.countForPath(path),
    });
    this.body = new BoxRenderable(context, {
      id: "diff-body",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
    });
    this.blocks = new DiffBlocks(context, {
      syntax: options.syntax,
      comments: options.comments,
      isOutdated: (target) => this.isOutdated(target),
      onToggleCollapse: (path) => this.toggleCollapse(path),
      onLayout: () => this.layoutChanged(),
      onComment: options.onComment,
    });
    this.scroller = this.blocks.scroller;
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
  }

  get showingDiff(): boolean {
    return this.blocks.hasBlocks;
  }

  get hasChanges(): boolean {
    return this.changes.length > 0;
  }

  state(): DiffState {
    const patch = this.blocks.totals();
    const state: DiffState = {
      repository: this.repository ? basename(this.repository.root) : "",
      files: this.changes.length,
      truncated: this.truncated,
      view: this.blocks.currentView,
      scope: this.scope,
      expandedContext: this.expandedContext,
      showingDiff: this.showingDiff,
    };

    if (this.selected) state.selected = this.selected;

    if (patch) state.patch = patch;

    return state;
  }

  restyle(): void {
    this.list.repaint();
    this.blocks.restyle(this.activeHeaderPath());

    if (!this.blocks.hasBlocks && this.empty) this.showEmpty(this.empty.title, this.empty.detail);
  }

  setTint(color: string): void {
    this.blocks.setTint(color);
  }

  async load(directory: string): Promise<void> {
    const previous = this.repository;
    let repository = previous && directory === this.directory ? previous : await openRepository(directory);
    let result: ChangeSet;
    try {
      result = await listChanges(repository);
    } catch (error) {
      if (repository === previous) {
        this.repository = undefined;
        this.directory = "";
        await closeRepository(repository);
        repository = await openRepository(directory);
        try {
          result = await listChanges(repository);
        } catch (retryError) {
          await closeRepository(repository);
          throw retryError;
        }
      } else {
        await closeRepository(repository);
        throw error;
      }
    }

    if (repository !== previous) {
      if (previous && this.repository === previous) await closeRepository(previous);

      this.repository = repository;
      this.directory = directory;
    }

    this.apply(result);
  }

  watch(): void {
    if (this.watching) return;

    this.watching = true;
    const session = ++this.watchSession;
    this.schedule(this.options.pollMs, session);
  }

  unwatch(): void {
    this.watching = false;
    this.watchSession += 1;
    clearTimeout(this.timer);
  }

  leave(): void {
    this.unwatch();
    this.request += 1;
    this.changes = [];
    this.selected = undefined;
    this.blocks.reset();
    this.signature = "";
    this.patchStamp = "";
    this.shownKey = "";
    this.pending = false;
    this.activateWhenReady = false;
    this.jumpAfterLayout = undefined;
    this.jumpCommentAfterLayout = undefined;
  }

  async close(): Promise<void> {
    this.leave();
    const repository = this.repository;
    this.repository = undefined;
    this.directory = "";

    if (repository) await closeRepository(repository);
  }

  toggleContext(): void {
    this.expandedContext = !this.expandedContext;
    this.shownKey = "";
    this.patchStamp = "";
    this.request += 1;
    this.activateWhenReady = false;
    this.jumpCommentAfterLayout = undefined;

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

    this.blocks.toggleCollapse(target, this.activeHeaderPath());
    this.options.onChange();
  }

  toggleView(): boolean {
    if (!this.blocks.toggleView(this.body.width)) return false;

    this.options.onChange();
    return true;
  }

  setWrap(wrap: boolean): void {
    this.blocks.setWrap(wrap);
    this.options.onChange();
  }

  toggleScope(): void {
    this.scope = this.scope === "all" ? "one" : "all";
    this.shownKey = "";
    this.patchStamp = "";
    this.request += 1;
    this.activateWhenReady = false;
    this.jumpCommentAfterLayout = undefined;

    if (this.scope === "all") {
      this.jumpAfterLayout = this.selected;
      void this.loadAll();
    } else if (this.selected) {
      void this.select(this.selected);
    }

    this.options.onChange();
  }

  showCommentComposer(target: CommentTarget, text: string, cursor: number): void {
    this.blocks.showCommentComposer(target, text, cursor);
  }

  hideCommentComposer(): void {
    this.blocks.hideCommentComposer();
  }

  repaintComments(): void {
    this.blocks.repaintComments();
    this.list.repaint();
  }

  isOutdated(comment: CommentTarget): boolean {
    if (!this.changes.some((change) => change.path === comment.path)) return true;

    if (this.blocks.hasTextBlock(comment.path)) return !this.blocks.hasMatchingRow(comment);

    return false;
  }

  jumpToComment(comment: ReviewComment): boolean {
    const change = this.changes.find((candidate) => candidate.path === comment.path);

    if (!change) return false;

    if (this.scope === "one" && !this.blocks.isSingleFile(comment.path)) {
      this.jumpCommentAfterLayout = comment;
      this.list.highlight(change.path);
      void this.select(change, true);
      return true;
    }

    this.jumpCommentAfterLayout = undefined;
    this.selected = change;
    this.list.highlight(change.path);
    this.blocks.updateActiveHeader(this.activeHeaderPath());
    const found = this.blocks.jumpToComment(comment);
    this.options.onChange();
    return found;
  }

  jumpHunk(direction: 1 | -1): HunkJumpResult {
    return this.blocks.jumpHunk(direction);
  }

  changedFile(): { path: string; line: number } | undefined {
    const change = this.selected;

    if (!change || !this.repository || change.kind === "deleted") return undefined;

    return { path: join(this.repository.root, change.path), line: this.blocks.activeLineFor(change.path) };
  }

  openSelected(): void {
    if (this.pending) this.activateWhenReady = true;
    else if (this.blocks.hasBlocks) this.options.onActivate();
    else this.options.onFocusList();
  }

  private contextLines(): number {
    return this.expandedContext ? WIDE_CONTEXT_LINES : NORMAL_CONTEXT_LINES;
  }

  private activeHeaderPath(): string | undefined {
    return this.scope === "all" ? this.selected?.path : undefined;
  }

  private schedule(delay: number, session: number): void {
    this.timer = setTimeout(() => void this.poll(session), delay);
    this.timer.unref?.();
  }

  private async poll(session: number): Promise<void> {
    if (!this.watching || session !== this.watchSession) return;

    const started = performance.now();
    try {
      await this.refresh(session);
    } catch {}

    if (this.watching && session === this.watchSession) {
      const elapsed = performance.now() - started;
      const next = Math.min(Math.max(MAX_POLL_MS, this.options.pollMs), Math.max(this.options.pollMs, elapsed * 3));
      this.schedule(next, session);
    }
  }

  private async refresh(session: number): Promise<void> {
    const repository = this.repository;

    if (!repository || !this.watching || session !== this.watchSession) return;

    const result = await listChanges(repository);

    if (!this.watching || session !== this.watchSession || repository !== this.repository) return;

    if (signature(result) !== this.signature) {
      this.apply(result);
      return;
    }

    const targets = this.scope === "all" ? this.changes : this.selected ? [this.selected] : [];

    if (!targets.length) return;

    const stamp = await changesStamp(repository, targets);

    if (!this.watching || session !== this.watchSession || repository !== this.repository || stamp === this.patchStamp)
      return;

    if (this.scope === "all") await this.loadAll(stamp);
    else if (this.selected) await this.reread(this.selected, stamp);
  }

  private apply(result: ChangeSet): void {
    const keep = this.selected?.path;
    this.changes = result.changes;
    this.truncated = result.truncated;
    this.signature = signature(result);
    this.patchStamp = "";

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

  private async select(change: Change | undefined, keepCommentJump = false): Promise<void> {
    if (!keepCommentJump) this.jumpCommentAfterLayout = undefined;

    this.selected = change;

    if (!change || !this.repository) return;

    if (this.scope === "all") {
      if (!this.holdScroll) this.blocks.jumpTo(change.path);

      this.blocks.updateActiveHeader(this.activeHeaderPath());
      this.options.onChange();
      return;
    }

    const repository = this.repository;
    const request = ++this.request;
    this.activateWhenReady = false;
    this.pending = true;
    const stamp = await changesStamp(repository, [change]);

    if (request !== this.request || repository !== this.repository) return;

    const patch = await this.read(repository, change);

    if (request !== this.request || repository !== this.repository) return;

    this.pending = false;
    this.patchStamp = stamp;
    this.presentOne(change, patch);
    this.finishPending();
  }

  private async reread(change: Change, stamp?: string): Promise<void> {
    const repository = this.repository;

    if (!repository) return;

    const nextStamp = stamp ?? (await changesStamp(repository, [change]));

    if (repository !== this.repository || this.scope !== "one" || this.selected !== change || this.pending) return;

    const patch = await this.read(repository, change);

    if (repository !== this.repository || this.scope !== "one" || this.selected !== change || this.pending) return;

    this.patchStamp = nextStamp;
    this.presentOne(change, patch);
  }

  private async loadAll(stamp?: string): Promise<void> {
    const repository = this.repository;

    if (!repository || this.scope !== "all" || !this.changes.length) return;

    const request = ++this.request;
    this.pending = true;
    let nextStamp: string;
    let files: FilePatch[];
    try {
      nextStamp = stamp ?? (await changesStamp(repository, this.changes));

      if (request !== this.request || repository !== this.repository) {
        this.pending = false;
        return;
      }

      files = await readAllPatches(repository, this.changes, this.contextLines());
    } catch {
      this.pending = false;
      return;
    }

    if (request !== this.request || repository !== this.repository) return;

    this.pending = false;
    this.patchStamp = nextStamp;
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

    if (this.blocks.hasBlocks) this.options.onActivate();
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

    const sameFile = this.blocks.isSingleFile(change.path);
    this.shownKey = key;
    this.show([{ change, patch }], sameFile ? "keep" : "top");
    this.options.onChange();
  }

  private show(files: FilePatch[], scroll: "keep" | "top"): void {
    this.blocks.show(files, scroll, this.activeHeaderPath());
    this.message.visible = false;

    if (this.jumpCommentAfterLayout) {
      const target = this.jumpCommentAfterLayout;
      this.jumpCommentAfterLayout = undefined;
      queueMicrotask(() => {
        if (!this.blocks.jumpToComment(target)) this.options.onCommentMissing();
      });
    } else if (this.scope === "all" && this.jumpAfterLayout) {
      this.queueJump();
    }
  }

  private showEmpty(title: string, detail: string): void {
    this.empty = { title, detail };
    this.blocks.clear();
    this.shownKey = "";
    this.messageTitle.content = styled([{ text: title, fg: theme.text, bold: true }]);
    this.messageDetail.content = styled([{ text: detail, fg: theme.muted }]);
    this.messageDetail.visible = detail !== "";
    this.message.visible = true;
    this.scroller.visible = false;
  }

  private queueJump(): void {
    queueMicrotask(() => {
      const target = this.jumpAfterLayout;
      this.jumpAfterLayout = undefined;

      if (target && this.scope === "all") this.blocks.jumpTo(target.path);
    });
  }

  private layoutChanged(): void {
    const { selected, hunkChanged } = this.blocks.followScroll(this.scope, this.selected?.path);

    if (selected) {
      this.selected = selected;
      this.list.highlight(selected.path);
      this.blocks.updateActiveHeader(this.activeHeaderPath());
      this.options.onChange();
    } else if (hunkChanged) {
      this.options.onChange();
    }

    this.options.onLayout();
  }
}
