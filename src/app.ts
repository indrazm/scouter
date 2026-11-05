import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { CodeView, languageFor } from "./code-view";
import { DiffScreen, MIN_SPLIT_COLUMNS } from "./diff-screen";
import { FileExplorer, type RowStyle } from "./explorer";
import { FileTree, type TreeEntry } from "./file-tree";
import { Footer } from "./footer";
import { PaneHeader, type HeaderBadge } from "./header";
import { GitMarks } from "./marks";
import { createHelp } from "./help";
import { matchEntries, indexTree, type IndexedEntry } from "./search";
import { styled } from "./styled";
import { theme } from "./theme";
import { createWelcome } from "./welcome";
import {
  describeError,
  displayLabel,
  isImagePath,
  readDocument,
  readImage,
  type Document,
  type ImageFile,
} from "./files";
import { ImageView, describeImage, type ImageDetails } from "./image-view";
import { GitError, closeRepository, listChanges, listIgnored, openRepository, type Repository } from "./git";

const FALLBACK_SIDEBAR_BACKGROUND = "#131519";
const SIDEBAR_TINT = 0.025;
const transparent = RGBA.fromValues(0, 0, 0, 0);
/** How often the diff screen re-reads git while it is open. */
const DIFF_POLL_MS = 2000;
/** How often the file list, its git marks and the open file are re-read while browsing. */
const BROWSE_POLL_MS = 2000;
/** Stands in for the open file's stamp once it has been deleted, so the notice is shown once. */
const MISSING_FILE = "missing";
const MIN_SIDEBAR_COLUMNS = 24;
const MIN_READER_COLUMNS = 28;

/** `/` over the file list: what is typed, the files it can match once they are indexed, and the row to return to. */
interface Finder {
  query: string;
  entries?: IndexedEntry[];
  truncated: boolean;
  returnTo?: string;
}

/** Changes when a file is saved, so a changed file can be read again. */
async function fileStamp(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.mtimeMs}:${info.size}`;
}

/** A key that types a character: one printable character, without Ctrl or Alt. */
function isTyped(key: KeyEvent): boolean {
  const code = key.sequence.charCodeAt(0);
  return key.sequence.length === 1 && code >= 32 && code !== 127 && !key.ctrl && !key.meta;
}

/** The find prompt's line at the top of the file list: what is typed, then what it matches. */
function findBar(query: string, status: string) {
  return styled([
    { text: "/ ", fg: theme.accent, bold: true },
    { text: query, fg: theme.text },
    { text: `   ${status}`, fg: theme.dim },
  ]);
}

function toTreeEntry(entry: IndexedEntry): TreeEntry {
  return { name: entry.relative, path: entry.path, kind: entry.kind, depth: 0, state: "collapsed" };
}

/** `path` relative to the browsed folder, forward-slashed to match the marks' keys on every platform. */
function treeRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

/** Nudges the terminal's own background slightly toward white (dark themes) or black (light themes). */
function tintedBackground(hex: string | null): string {
  if (!hex) return FALLBACK_SIDEBAR_BACKGROUND;
  const base = RGBA.fromHex(hex);
  const target = base.r * 0.299 + base.g * 0.587 + base.b * 0.114 < 0.5 ? 1 : 0;
  const mix = (channel: number): number => Math.round((channel + (target - channel) * SIDEBAR_TINT) * 255);
  return `#${[mix(base.r), mix(base.g), mix(base.b)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export class ScouterApp {
  private readonly tree = new FileTree();
  /** What is being read from disk or git right now. Only one read at a time, so their results cannot interleave. */
  private loading?: "open" | "diff";
  /** Identifies the current diff read, so one the user cancelled is ignored when git finally answers. */
  private diffToken = 0;
  private readonly browserPanel: BoxRenderable;
  private readonly browser: FileExplorer;
  private readonly viewerPanel: BoxRenderable;
  private readonly viewerHeader: PaneHeader;
  private readonly sidebarResizer: BoxRenderable;
  private readonly viewer: ScrollBoxRenderable;
  private readonly codeView: CodeView;
  private readonly imageView: ImageView;
  private readonly footer: Footer;
  private readonly welcome: BoxRenderable;
  /** The `?` key list, covering the panes while it is open. */
  private readonly help: BoxRenderable;
  private readonly diffScreen: DiffScreen;
  private mode: "browse" | "diff" = "browse";
  /** Which pane had focus when the diff screen opened, so closing it puts the user back where they were. */
  private paneBeforeDiff: "list" | "reader" = "list";
  private hasDocument = false;
  private documentTitle = "Reader";
  private document?: Document;
  private isImage = false;
  private wrap = false;
  private workerClosed = Promise.resolve();
  private preferredSidebarWidth?: number;
  private sidebarDrag?: { startX: number; startWidth: number };
  private readonly marks = new GitMarks();
  private finder?: Finder;
  private readonly findBar: TextRenderable;
  /** `/` over the open file: whether the prompt is still taking keys, what was typed, and the lines it matches. */
  private searching = false;
  private search?: { query: string; lines: number[]; at: number };
  /** The git repository the file list is marked from: the browsed folder's, or none. */
  private browseSource?: { root: string; repository?: Repository };
  /** Refreshes run one after another, so a slow one never overlaps the next. */
  private browseQueue: Promise<void> = Promise.resolve();
  private browseTimer?: ReturnType<typeof setTimeout>;
  private readonly browsePollMs: number;
  /** The open text file's size and modification time when it was last read. */
  private documentStamp?: string;

  constructor(
    private readonly renderer: CliRenderer,
    options: {
      diffPollMs?: number;
      browsePollMs?: number;
      imageProtocol?: "auto" | "kitty" | "sixel" | "blocks";
    } = {},
  ) {
    this.browsePollMs = options.browsePollMs ?? BROWSE_POLL_MS;
    const layout = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
    const panes = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "row",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
    });
    this.browserPanel = new BoxRenderable(renderer, {
      id: "browser-panel",
      flexShrink: 0,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: transparent,
    });
    this.browser = new FileExplorer(renderer, { onActivate: this.onExplorerActivate });
    this.viewerPanel = new BoxRenderable(renderer, {
      id: "viewer-panel",
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      flexDirection: "column",
      paddingLeft: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: transparent,
    });
    this.viewerHeader = new PaneHeader(renderer, "viewer-header");
    this.viewerHeader.setTitle("Reader");
    this.updateViewerBadges();
    this.sidebarResizer = new BoxRenderable(renderer, {
      id: "sidebar-resizer",
      width: 1,
      height: "100%",
      flexShrink: 0,
      onMouseOver: () => {
        this.sidebarResizer.backgroundColor = theme.hover;
        this.setResizePointer("col-resize");
      },
      onMouseOut: () => {
        if (this.sidebarDrag) return;
        this.sidebarResizer.backgroundColor = transparent;
        this.setResizePointer("default");
      },
      onMouseDown: this.startSidebarDrag,
      onMouseDrag: this.dragSidebar,
      onMouseDragEnd: this.finishSidebarDrag,
      onMouseUp: this.finishSidebarDrag,
    });
    this.viewer = new ScrollBoxRenderable(renderer, {
      id: "viewer",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: true,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: { trackOptions: { backgroundColor: "transparent", foregroundColor: theme.muted } },
      horizontalScrollbarOptions: { visible: false },
      verticalScrollbarOptions: { onChange: () => this.updatePosition() },
      onSizeChange: () => {
        this.imageView.resize();
        this.updatePosition();
      },
    });
    this.viewer.visible = false;
    this.welcome = createWelcome(renderer);
    this.codeView = new CodeView(renderer, { onLayout: () => this.updatePosition() });
    this.imageView = new ImageView(renderer, options.imageProtocol);
    this.footer = new Footer(renderer);
    this.diffScreen = new DiffScreen(renderer, {
      syntax: this.codeView.syntax,
      onChange: this.onDiffChange,
      onActivate: this.onDiffActivate,
      onFocusList: this.onDiffFocusList,
      onLayout: () => this.updatePosition(),
      pollMs: options.diffPollMs ?? DIFF_POLL_MS,
    });
    this.diffScreen.list.visible = false;
    this.diffScreen.body.visible = false;
    this.findBar = new TextRenderable(renderer, {
      id: "find-bar",
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.findBar.visible = false;
    this.browserPanel.add(this.findBar);
    this.browserPanel.add(this.browser);
    this.browserPanel.add(this.diffScreen.list);
    this.codeView.mount(this.viewer);
    this.imageView.mount(this.viewer);
    this.viewerPanel.add(this.viewerHeader.root);
    this.viewerPanel.add(this.welcome);
    this.viewerPanel.add(this.viewer);
    this.viewerPanel.add(this.diffScreen.body);
    panes.add(this.browserPanel);
    panes.add(this.sidebarResizer);
    panes.add(this.viewerPanel);
    layout.add(panes);
    layout.add(this.footer.root);
    this.help = createHelp(renderer, FALLBACK_SIDEBAR_BACKGROUND);
    this.help.visible = false;
    // Last in the layout, so it draws over the panes it covers.
    layout.add(this.help);
    renderer.root.add(layout);
    renderer.keyInput.on("keypress", this.onKeyPress);
    renderer.on("focused_renderable", this.updateFocus);
    renderer.on("resize", this.resizeSidebar);
    renderer.once("destroy", this.dispose);
    this.resizeSidebar();
    this.focusBrowser();
    void this.tintSidebar();
    this.scheduleBrowse();
  }

  private async tintSidebar(): Promise<void> {
    const palette = await this.renderer.getPalette({ timeout: 500 }).catch(() => undefined);
    if (this.renderer.isDestroyed) return;
    const tint = tintedBackground(palette?.defaultBackground ?? null);
    this.browserPanel.backgroundColor = tint;
    this.footer.setBackground(tint);
    this.diffScreen.setTint(tint);
    this.help.backgroundColor = tint;
    this.renderer.requestRender();
  }

  async open(path: string): Promise<void> {
    if (this.renderer.isDestroyed) return;
    if (this.loading) return this.refuseWhileLoading();
    this.loading = "open";
    this.viewerHeader.setNotice(undefined);
    this.footer.setMessage("Loading…");
    try {
      await this.openPath(resolve(path));
    } catch (error) {
      if (!this.renderer.isDestroyed) {
        this.showError(describeError(error));
        // Nothing opened, so the click that led here belongs to the sidebar.
        this.focusBrowser();
      }
    } finally {
      this.loading = undefined;
      void this.browseRefresh();
    }
  }

  /** Only starting a read is refused while one is running; moving around and reading the screen keep working. */
  private refuseWhileLoading(): void {
    this.footer.setMessage("Still loading. Try again when it finishes.");
  }

  private async openPath(path: string): Promise<void> {
    if ((await stat(path)).isDirectory()) return this.openDirectory(path);
    if (isImagePath(path)) {
      const file = await readImage(path);
      const details = describeImage(file.bytes);
      if (await this.reveal(path)) this.showImage(file, details);
      return;
    }
    const stamp = await fileStamp(path);
    const document = await readDocument(path);
    if (await this.reveal(path)) this.showDocument(document, stamp);
  }

  /** Expands the tree to `path` and selects it. False when the app was closed meanwhile. */
  private async reveal(path: string): Promise<boolean> {
    if (this.renderer.isDestroyed) return false;
    // A file outside the tree starts a new tree at its folder; one inside it just opens the folders above it.
    if (!this.tree.has(path) && !(await this.tree.expandTo(path))) await this.openDirectory(dirname(path));
    if (this.renderer.isDestroyed) return false;
    this.tree.reveal(path);
    this.renderTree(path);
    return true;
  }

  private async openDirectory(path: string): Promise<void> {
    if (this.tree.has(path)) await this.tree.expand(path);
    else await this.tree.load(path);
    if (this.renderer.isDestroyed) return;
    this.renderTree(path);
    if (this.hasDocument) this.footer.clearMessage();
    else this.footer.setLocation(path);
    this.focusBrowser();
  }

  private renderTree(selectedPath: string): void {
    const entries = this.tree.rows();
    this.browser.show(entries, selectedPath, (entry) => this.styleOf(entry));
  }

  /** A changed file shows its status letter, a folder holding changes a dot, and ignored entries fade. */
  private styleOf(entry: TreeEntry): RowStyle {
    const path = treeRelative(this.tree.rootPath ?? entry.path, entry.path);
    return { ...this.marks.styleOf(path), dim: this.marks.isIgnored(path) };
  }

  private showImage(file: ImageFile, details: ImageDetails): void {
    this.codeView.hide();
    this.document = undefined;
    this.documentStamp = undefined;
    this.isImage = true;
    this.hasDocument = true;
    this.welcome.visible = false;
    this.viewer.visible = this.mode === "browse";
    this.viewer.scrollTo({ x: 0, y: 0 });
    this.imageView.show(file);
    this.documentTitle = displayLabel(basename(file.path));
    this.footer.setLocation(file.path);
    this.footer.setDocument({ lines: 0, language: details.format, image: details });
    this.updateChrome();
    this.updatePosition();
    if (this.mode === "browse") this.viewer.focus();
    this.updateFocus();
  }

  private showDocument(document: Document, stamp: string): void {
    this.imageView.hide();
    this.isImage = false;
    const language = this.codeView.show(document);
    this.document = document;
    this.documentStamp = stamp;
    this.hasDocument = true;
    this.welcome.visible = false;
    this.viewer.visible = this.mode === "browse";
    this.viewer.scrollTo({ x: 0, y: 0 });
    this.documentTitle = displayLabel(basename(document.path));
    this.footer.setLocation(document.path);
    this.setDocumentInfo(document, language);
    this.updateChrome();
    this.updatePosition();
    if (this.mode === "browse") this.viewer.focus();
    this.updateFocus();
  }

  private setDocumentInfo(document: Document, language: string | undefined): void {
    this.footer.setDocument({
      lines: document.lineCount,
      language: language ?? "plain text",
      rendered: this.codeView.isMarkdown ? this.codeView.previewing : undefined,
      ...(document.truncated ? { truncated: true } : {}),
    });
  }

  /** `m`: show the open Markdown file rendered or as source. */
  private toggleMarkdownSource(): void {
    if (!this.document || !this.codeView.isMarkdown || this.mode !== "browse") return;
    this.codeView.toggleSource();
    this.viewer.scrollTo({ x: 0, y: 0 });
    this.setDocumentInfo(this.document, languageFor(this.document.path));
    this.updateViewerBadges();
    this.updatePosition();
    this.renderer.requestRender();
  }

  /** The pane that lists things: files while browsing, changed files in the diff screen. */
  private get list(): ScrollBoxRenderable {
    return this.mode === "diff" ? this.diffScreen.list : this.browser;
  }

  /** The pane that shows the content: the open file, or the diff of the highlighted change. */
  private get reader(): ScrollBoxRenderable {
    return this.mode === "diff" ? this.diffScreen.scroller : this.viewer;
  }

  /** Whether the reader has something to scroll, as opposed to the welcome screen or a message. */
  private get readerReady(): boolean {
    return this.mode === "diff" ? this.diffScreen.showingDiff : this.hasDocument;
  }

  /** Brings the reader header and the footer in line with whatever the current mode shows. */
  private updateChrome(): void {
    if (this.mode === "browse") {
      this.viewerHeader.setTitle(this.hasDocument ? this.documentTitle : "Reader");
      this.updateViewerBadges();
      return;
    }
    const state = this.diffScreen.state();
    this.viewerHeader.setTitle(state.selected ? displayLabel(basename(state.selected.path)) : "Changes");
    this.updateViewerBadges();
    this.footer.setDiff({
      location: state.selected?.path ?? state.repository,
      files: state.files,
      truncated: state.truncated,
      scope: state.scope,
      ...state.patch,
    });
  }

  private readonly onDiffChange = (): void => {
    this.updateChrome();
    this.updatePosition();
    this.updateFocus();
    this.renderer.requestRender();
  };

  private readonly onDiffActivate = (): void => {
    this.diffScreen.scroller.focus();
    this.updateFocus();
  };

  private readonly onDiffFocusList = (): void => {
    this.diffScreen.list.focus();
    this.updateFocus();
  };

  private rootPath(): string {
    return this.tree.rows()[0]?.path ?? process.cwd();
  }

  /** `d` opens the changes, closes them, or, while they are still being read, gives up on that read. */
  private async toggleDiff(): Promise<void> {
    if (this.mode === "diff") return this.leaveDiff();
    if (this.loading === "diff") return this.cancelDiff();
    await this.loadDiff(() => this.enterDiff());
  }

  private cancelDiff(): void {
    this.loading = undefined;
    this.diffToken += 1;
    this.footer.setMessage("Cancelled.");
  }

  /** Reads the repository, then runs `then`. Failures such as "Not a git repository." land in the footer. */
  private async loadDiff(then: () => void): Promise<void> {
    if (this.renderer.isDestroyed) return;
    if (this.loading) return this.refuseWhileLoading();
    const token = ++this.diffToken;
    this.loading = "diff";
    this.viewerHeader.setNotice(undefined);
    this.footer.setMessage("Loading changes…");
    try {
      await this.diffScreen.load(this.rootPath());
      if (token === this.diffToken && !this.renderer.isDestroyed) {
        this.footer.clearMessage();
        then();
      }
    } catch (error) {
      if (token === this.diffToken && !this.renderer.isDestroyed) {
        this.showError(error instanceof GitError ? error.message : describeError(error));
      }
    } finally {
      if (token === this.diffToken) this.loading = undefined;
    }
  }

  /** Errors go to the footer and to the top of the reader, where the eye already is. */
  private showError(message: string): void {
    this.footer.setMessage(message, true);
    this.viewerHeader.setNotice(message);
  }

  private toggleSplit(): void {
    if (this.diffScreen.toggleView()) return;
    this.footer.setMessage(`Split needs ${MIN_SPLIT_COLUMNS}+ columns.`);
  }

  private enterDiff(): void {
    this.paneBeforeDiff = this.viewer.focused ? "reader" : "list";
    this.mode = "diff";
    this.browser.visible = false;
    this.viewer.visible = false;
    this.welcome.visible = false;
    this.diffScreen.list.visible = true;
    this.diffScreen.body.visible = true;
    this.footer.setMode("diff");
    this.footer.clearMessage();
    this.updateChrome();
    this.diffScreen.list.focus();
    this.updateFocus();
    this.diffScreen.watch();
  }

  private leaveDiff(): void {
    this.mode = "browse";
    this.diffScreen.list.visible = false;
    this.diffScreen.body.visible = false;
    this.browser.visible = true;
    this.welcome.visible = !this.hasDocument;
    this.viewer.visible = this.hasDocument;
    this.footer.setMode("browse");
    this.updateChrome();
    this.updatePosition();
    if (this.paneBeforeDiff === "reader" && this.hasDocument) this.viewer.focus();
    else this.browser.focus();
    this.updateFocus();
    // Closing also removes the private index copy; the next visit reads the repository afresh.
    void this.diffScreen.close();
    void this.browseRefresh();
  }

  /** Queues a refresh of the browser: folders, git marks, and the open file as it is on disk now. */
  private browseRefresh(): Promise<void> {
    this.browseQueue = this.browseQueue.then(() => this.refreshBrowse());
    return this.browseQueue;
  }

  private scheduleBrowse(): void {
    this.browseTimer = setTimeout(() => {
      void this.browseRefresh().then(() => {
        if (!this.renderer.isDestroyed) this.scheduleBrowse();
      });
    }, this.browsePollMs);
    this.browseTimer.unref?.();
  }

  /**
   * Picks up what changed on disk while browsing: folders that gained or lost entries, edits to git's view of the
   * tree, and the open file once it has been saved. The diff screen does its own polling, so this pauses there.
   */
  private async refreshBrowse(): Promise<void> {
    if (this.renderer.isDestroyed || this.mode !== "browse" || this.loading === "open" || !this.tree.rootPath) return;
    try {
      const folders = await Promise.all(this.tree.expandedPaths().map((path) => this.tree.refresh(path)));
      const marks = await this.refreshMarks();
      await this.refreshDocument();
      if (this.renderer.isDestroyed || this.mode !== "browse") return;
      // While the find prompt is open its matches are on screen, so the tree waits until the prompt closes.
      if ((marks || folders.some(Boolean)) && !this.finder) {
        this.renderTree(this.browser.selected()?.path ?? this.tree.rootPath);
      }
    } catch {
      // A failed read, such as git being busy, keeps what is on screen; the next refresh tries again.
    }
  }

  /** Asks git what changed under the browsed folder and what it ignores. True when that differs from last time. */
  private async refreshMarks(): Promise<boolean> {
    const root = this.tree.rootPath;
    if (!root) return false;
    const repository = await this.browseRepository(root);
    if (!repository) return this.marks.update("", [], []);
    // Git names the repository by its real path, which can differ from the one the tree was opened with (macOS /var).
    const [{ changes }, ignored, real] = await Promise.all([
      listChanges(repository),
      listIgnored(repository),
      realpath(root),
    ]);
    return this.marks.update(relative(repository.root, real), changes, ignored);
  }

  /** The repository holding the browsed folder, opened again only when the folder changes. Undefined outside git. */
  private async browseRepository(root: string): Promise<Repository | undefined> {
    if (this.browseSource?.root !== root) {
      const previous = this.browseSource?.repository;
      const repository = await openRepository(root).catch(() => undefined);
      if (previous) await closeRepository(previous);
      this.browseSource = { root, repository };
    }
    return this.browseSource.repository;
  }

  /** Reads the open text file again once it has been saved, keeping the reader where it is. */
  private async refreshDocument(): Promise<void> {
    const document = this.document;
    if (!document || this.isImage || this.documentStamp === MISSING_FILE) return;
    let stamp: string;
    try {
      stamp = await fileStamp(document.path);
    } catch {
      this.documentStamp = MISSING_FILE;
      this.showError(`${displayLabel(basename(document.path))} is no longer on disk.`);
      return;
    }
    if (stamp === this.documentStamp) return;
    const next = await readDocument(document.path);
    if (this.renderer.isDestroyed || this.document !== document) return;
    this.documentStamp = stamp;
    if (next.text === document.text && next.truncated === document.truncated) return;
    this.document = next;
    this.codeView.show(next);
    this.setDocumentInfo(next, languageFor(next.path));
    this.updateChrome();
    this.updatePosition();
  }

  /** `-`: the folder above becomes the root of the tree, with the folder you were in still open in it. */
  private async goUp(): Promise<void> {
    if (this.loading) return this.refuseWhileLoading();
    const root = this.tree.rootPath;
    if (!root) return;
    const parent = dirname(root);
    if (parent === root) {
      this.footer.setMessage("Already at the top of the file system.");
      return;
    }
    this.loading = "open";
    try {
      await this.tree.load(parent);
      await this.tree.expand(root);
    } catch (error) {
      this.showError(describeError(error));
      return;
    } finally {
      this.loading = undefined;
    }
    if (this.renderer.isDestroyed) return;
    this.renderTree(root);
    void this.browseRefresh();
  }

  private updateViewerBadges(): void {
    const badges: HeaderBadge[] = [];
    if (this.mode === "diff") {
      const state = this.diffScreen.state();
      if (state.selected) badges.push({ text: state.selected.kind, kind: "quiet" });
      badges.push({ text: state.scope === "all" ? "all files" : "one file", kind: "quiet" });
      if (state.view === "split") badges.push({ text: "split", kind: "pill" });
    } else {
      badges.push({ text: "read-only", kind: "quiet" });
    }
    // Rendered Markdown always wraps, so it shows `rendered` instead of `wrap`.
    const rendered = this.mode === "browse" && this.hasDocument && this.codeView.previewing;
    if (rendered) badges.push({ text: "rendered", kind: "quiet" });
    if (this.mode === "browse" && this.hasDocument && this.isImage) badges.push({ text: "image", kind: "quiet" });
    if (this.mode === "browse" && this.document?.truncated) badges.push({ text: "first 1 MiB", kind: "pill" });
    if (this.wrap && !rendered && !this.isImage) badges.push({ text: "wrap", kind: "pill" });
    this.viewerHeader.setBadges(badges);
  }

  /** Vim-style scroll readout: All, Top, Bot or a percentage of the scrollable distance. */
  private updatePosition(): void {
    if (!this.readerReady) return;
    const range = this.reader.scrollHeight - this.reader.viewport.height;
    const top = this.reader.scrollTop;
    this.footer.setPosition(
      range <= 0 ? "All" : top <= 0 ? "Top" : top >= range ? "Bot" : `${Math.round((top / range) * 100)}%`,
    );
  }

  private toggleWrap(): void {
    this.wrap = !this.wrap;
    this.codeView.setWrap(this.wrap);
    this.diffScreen.setWrap(this.wrap);
    this.footer.setWrap(this.wrap);
    this.updateViewerBadges();
    this.renderer.requestRender();
  }

  private openSelected(action: "toggle" | "expand"): void {
    const entry = this.browser.selected();
    if (!entry) return;
    if (entry.state !== "expanded") {
      void this.open(entry.path);
      return;
    }
    if (action === "expand") {
      if (entry.children?.length) this.browser.moveSelection(1);
      return;
    }
    this.tree.collapse(entry.path);
    this.renderTree(entry.path);
  }

  private collapseSelected(): void {
    const entry = this.browser.selected();
    if (!entry) return;
    if (entry.state === "expanded") {
      this.tree.collapse(entry.path);
      this.renderTree(entry.path);
      return;
    }
    if (entry.parentPath) this.renderTree(entry.parentPath);
  }

  /** The pane holding focus; the border colors are rewritten only when it actually moves, so nothing flickers. */
  private focusPane?: "list" | "reader";

  private focusBrowser(): void {
    this.list.focus();
    this.updateFocus();
  }

  private readonly updateFocus = (): void => {
    const pane = this.reader.focused ? "reader" : "list";
    if (pane !== this.focusPane) {
      this.focusPane = pane;
      this.browserPanel.borderColor = pane === "list" ? theme.accent : transparent;
      this.viewerPanel.borderColor = pane === "reader" ? theme.accent : transparent;
    }
    this.viewerHeader.setFocused(this.reader.focused);
    this.footer.setFocus(this.reader.focused ? "reader" : "files");
  };

  private readonly resizeSidebar = (): void => {
    const defaultWidth = Math.min(40, Math.max(28, Math.floor(this.renderer.width * 0.25)));
    this.browserPanel.width = this.constrainSidebarWidth(this.preferredSidebarWidth ?? defaultWidth);
  };

  private constrainSidebarWidth(width: number): number {
    const maximum = Math.max(1, this.renderer.width - MIN_READER_COLUMNS - 1);
    return Math.min(maximum, Math.max(Math.min(MIN_SIDEBAR_COLUMNS, maximum), Math.round(width)));
  }

  private setSidebarWidth(width: number): void {
    this.preferredSidebarWidth = this.constrainSidebarWidth(width);
    this.resizeSidebar();
  }

  private setResizePointer(style: "col-resize" | "default"): void {
    this.renderer.setMousePointer(style);
    this.renderer.requestRender();
  }

  private readonly startSidebarDrag = (event: MouseEvent): void => {
    if (event.button !== MouseButton.LEFT) return;
    event.preventDefault();
    event.stopPropagation();
    this.sidebarDrag = { startX: event.x, startWidth: this.browserPanel.width };
    this.sidebarResizer.backgroundColor = theme.accent;
    this.setResizePointer("col-resize");
  };

  private readonly dragSidebar = (event: MouseEvent): void => {
    if (!this.sidebarDrag) return;
    event.stopPropagation();
    this.setSidebarWidth(this.sidebarDrag.startWidth + event.x - this.sidebarDrag.startX);
  };

  private readonly finishSidebarDrag = (): void => {
    if (!this.sidebarDrag) return;
    this.sidebarDrag = undefined;
    this.sidebarResizer.backgroundColor = transparent;
    this.setResizePointer("default");
  };

  private readonly onExplorerActivate = (): void => {
    if (this.renderer.isDestroyed) return;
    // Opening a file ends with the reader focused, so focusing the sidebar on the way would flash both pane
    // borders (indigo on the sidebar, then on the reader). Only a collapse, which stays in the sidebar, needs
    // focus now; expanding a folder takes it when its contents have loaded.
    if (this.browser.selected()?.state === "expanded") this.focusBrowser();
    this.openSelected("toggle");
  };

  private readonly onKeyPress = (key: KeyEvent): void => {
    this.viewerHeader.setNotice(undefined);
    // An open prompt takes every typed key first, so typing "q" or "d" searches instead of quitting or leaving.
    if (this.finder && this.handleFindKey(key)) return;
    if (this.searching && this.handleSearchKey(key)) return;
    // While the key list is open, any key closes it; quitting still quits.
    if (this.help.visible && !((key.name === "q" && !key.ctrl && !key.meta) || (key.name === "c" && key.ctrl))) {
      key.preventDefault();
      this.help.visible = false;
      return;
    }
    if ((key.name === "q" && !key.ctrl && !key.meta) || (key.name === "c" && key.ctrl)) {
      key.preventDefault();
      this.renderer.destroy();
      return;
    }
    if (key.name === "w" && !key.ctrl && !key.meta && !key.shift) {
      key.preventDefault();
      this.toggleWrap();
      return;
    }
    if (key.name === "m" && !key.ctrl && !key.meta && !key.shift) {
      key.preventDefault();
      this.toggleMarkdownSource();
      return;
    }
    if (key.sequence === "?" && !key.ctrl && !key.meta) {
      key.preventDefault();
      this.help.visible = true;
      return;
    }
    if (key.name === "d" && !key.ctrl && !key.meta && !key.shift) {
      key.preventDefault();
      void this.toggleDiff();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      if (this.list.focused && this.readerReady) this.reader.focus();
      else this.focusBrowser();
      this.updateFocus();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      this.focusBrowser();
      return;
    }
    if (key.ctrl && !key.meta && ["left", "right"].includes(key.name)) {
      key.preventDefault();
      const width = this.constrainSidebarWidth(this.preferredSidebarWidth ?? this.browserPanel.width);
      this.setSidebarWidth(width + (key.name === "left" ? -2 : 2));
      return;
    }
    if (this.mode === "diff" && this.handleDiffKey(key)) return;
    if (!this.list.focused) this.handleViewerKey(key);
    else if (this.mode === "diff") this.handleChangesKey(key);
    else this.handleBrowserKey(key);
  };

  /** Keys that only mean something on the diff screen, whichever pane has focus. */
  private handleDiffKey(key: KeyEvent): boolean {
    if (key.ctrl || key.meta) return false;
    if (key.name === "s") this.toggleSplit();
    else if (key.name === "a") this.diffScreen.toggleScope();
    else if (key.name === "r") void this.loadDiff(() => this.onDiffChange());
    else if (key.name === "o") void this.openChanged();
    else if (key.name === "n" || key.sequence === "]") this.diffScreen.jumpHunk(1);
    else if (key.name === "p" || key.sequence === "[") this.diffScreen.jumpHunk(-1);
    else return false;
    key.preventDefault();
    return true;
  }

  private handleChangesKey(key: KeyEvent): void {
    if (key.ctrl || key.meta) return;
    if (["return", "l", "right"].includes(key.name)) {
      key.preventDefault();
      this.diffScreen.openSelected();
      return;
    }
    if (["g", "home", "end"].includes(key.name)) {
      key.preventDefault();
      this.diffScreen.list.selectBoundary(key.shift || key.name === "end" ? "end" : "start");
    }
  }

  private handleBrowserKey(key: KeyEvent): void {
    if (key.ctrl || key.meta) return;
    if (["return", "l", "right"].includes(key.name)) {
      key.preventDefault();
      this.openSelected(key.name === "return" ? "toggle" : "expand");
      return;
    }
    if (["h", "left", "backspace"].includes(key.name)) {
      key.preventDefault();
      this.collapseSelected();
      return;
    }
    if (key.name === "-") {
      key.preventDefault();
      void this.goUp();
      return;
    }
    if (key.name === "/") {
      key.preventDefault();
      void this.startFind();
    }
    if (["g", "home", "end"].includes(key.name)) {
      key.preventDefault();
      this.browser.selectBoundary(key.shift || key.name === "end" ? "end" : "start");
    }
  }

  private handleViewerKey(key: KeyEvent): void {
    if (key.meta) return;
    if (key.ctrl) {
      if (!["u", "d"].includes(key.name)) return;
      key.preventDefault();
      this.reader.scrollBy(key.name === "u" ? -0.5 : 0.5, "viewport");
      return;
    }
    const movement: Record<string, { x: number; y: number }> = {
      h: { x: -4, y: 0 },
      left: { x: -4, y: 0 },
      l: { x: 4, y: 0 },
      right: { x: 4, y: 0 },
      j: { x: 0, y: 1 },
      down: { x: 0, y: 1 },
      k: { x: 0, y: -1 },
      up: { x: 0, y: -1 },
    };
    const delta = movement[key.name];
    if (delta) {
      key.preventDefault();
      this.reader.scrollBy(delta);
      return;
    }
    const page: Record<string, number> = { pagedown: 0.9, space: 0.9, pageup: -0.9, b: -0.9 };
    const pageBy = page[key.name];
    if (pageBy !== undefined) {
      key.preventDefault();
      this.reader.scrollBy(pageBy, "viewport");
      return;
    }
    if (this.mode === "browse" && key.name === "/") {
      key.preventDefault();
      this.startSearch();
      return;
    }
    if (this.mode === "browse" && (key.name === "n" || key.name === "p")) {
      key.preventDefault();
      this.stepSearch(key.name === "n" ? 1 : -1);
      return;
    }
    if (["g", "home", "end"].includes(key.name)) {
      key.preventDefault();
      this.reader.scrollTo(key.shift || key.name === "end" ? Infinity : 0);
    }
  }

  /** `/` over the file list: type to narrow the files under the folder, Enter to open one, Esc to go back. */
  private async startFind(): Promise<void> {
    const root = this.tree.rootPath;
    if (!root || this.finder) return;
    if (this.loading) return this.refuseWhileLoading();
    const finder: Finder = { query: "", truncated: false, returnTo: this.browser.selected()?.path };
    this.finder = finder;
    this.footer.setPrompt("files");
    this.updateFind();
    const { entries, truncated } = await indexTree(root, (path) => this.marks.isIgnored(treeRelative(root, path)));
    if (this.renderer.isDestroyed || this.finder !== finder) return;
    finder.entries = entries;
    finder.truncated = truncated;
    this.updateFind();
  }

  /** Shows what is typed, and the files it matches, or the whole tree while nothing is typed. */
  private updateFind(): void {
    const finder = this.finder;
    if (!finder) return;
    this.findBar.visible = true;
    if (!finder.query) {
      this.findBar.content = findBar(finder.query, "type to find a file");
      this.renderTree(this.browser.selected()?.path ?? finder.returnTo ?? this.tree.rootPath ?? "");
      return;
    }
    if (!finder.entries) {
      this.findBar.content = findBar(finder.query, "indexing…");
      this.browser.show([], "");
      return;
    }
    const { matches, total } = matchEntries(finder.entries, finder.query);
    const rows = matches.map(toTreeEntry);
    this.browser.show(rows, rows[0]?.path ?? "", (row) => this.styleOf(row));
    const count = total === 0 ? "no matches" : `${total.toLocaleString("en-US")} ${total === 1 ? "match" : "matches"}`;
    this.findBar.content = findBar(finder.query, finder.truncated ? `${count}, first 20,000 files` : count);
  }

  /** Keys while the file find prompt is open. Ctrl and Alt chords are left alone, so Ctrl+C still quits. */
  private handleFindKey(key: KeyEvent): boolean {
    const finder = this.finder;
    if (!finder || key.ctrl || key.meta) return false;
    key.preventDefault();
    if (key.name === "escape") this.endFind();
    else if (key.name === "return") this.pickFound();
    else if (key.name === "backspace") {
      finder.query = finder.query.slice(0, -1);
      this.updateFind();
    } else if (key.name === "up" || key.name === "down") this.browser.moveSelection(key.name === "up" ? -1 : 1);
    else if (isTyped(key)) {
      finder.query += key.sequence;
      this.updateFind();
    }
    return true;
  }

  /** Closes the find prompt, showing the tree with `select` (or the row it was opened from) highlighted. */
  private endFind(select?: string): void {
    const finder = this.finder;
    if (!finder) return;
    this.finder = undefined;
    this.findBar.visible = false;
    this.footer.setPrompt(undefined);
    this.renderTree(select ?? finder.returnTo ?? this.tree.rootPath ?? "");
  }

  /** Enter in the find prompt. With nothing typed it acts on the tree row, as Enter does outside the prompt. */
  private pickFound(): void {
    const typed = this.finder?.query ?? "";
    const picked = this.browser.selected();
    this.endFind(picked?.path);
    if (!picked) return;
    if (!typed.trim()) return this.openSelected("toggle");
    if (picked.kind === "directory") void this.revealFolder(picked.path);
    else void this.open(picked.path);
  }

  /** Opens the folders above `path` and `path` itself, and selects it. */
  private async revealFolder(path: string): Promise<void> {
    if (this.loading) return this.refuseWhileLoading();
    this.loading = "open";
    try {
      await this.tree.expandTo(path);
      await this.tree.expand(path);
    } catch (error) {
      this.showError(describeError(error));
      return;
    } finally {
      this.loading = undefined;
    }
    if (this.renderer.isDestroyed) return;
    this.renderTree(path);
    void this.browseRefresh();
  }

  /** `/` over the open text file: find lines as you type. Rendered Markdown has no lines to find, so it asks for source. */
  private startSearch(): void {
    if (!this.document || this.isImage) return;
    if (this.codeView.previewing) {
      this.footer.setMessage("Press m to search this Markdown file's source.");
      return;
    }
    this.search = { query: "", lines: [], at: -1 };
    this.searching = true;
    this.footer.setPrompt("reader");
    this.showSearch();
  }

  /** Keys while the reader's search prompt is open. Enter keeps the search for n and p; Esc drops it. */
  private handleSearchKey(key: KeyEvent): boolean {
    const search = this.search;
    if (!this.searching || !search || key.ctrl || key.meta) return false;
    key.preventDefault();
    if (key.name === "escape") {
      this.searching = false;
      this.search = undefined;
      this.footer.setPrompt(undefined);
      this.footer.clearMessage();
    } else if (key.name === "return") {
      this.searching = false;
      this.footer.setPrompt(undefined);
      this.showSearch();
    } else if (key.name === "backspace") {
      search.query = search.query.slice(0, -1);
      this.findInDocument();
    } else if (isTyped(key)) {
      search.query += key.sequence;
      this.findInDocument();
    }
    return true;
  }

  /** Recounts the lines matching what is typed, and jumps to the first one at or below the top of the reader. */
  private findInDocument(): void {
    const search = this.search;
    if (!search || !this.document) return;
    const needle = search.query.toLowerCase();
    search.lines = needle
      ? this.document.text.split("\n").flatMap((line, index) => (line.toLowerCase().includes(needle) ? [index] : []))
      : [];
    const top = Math.floor(this.viewer.scrollTop);
    const first = search.lines.findIndex((line) => line >= top);
    search.at = Math.max(0, first);
    const line = search.lines[search.at];
    if (line !== undefined) this.scrollToLine(line);
    this.showSearch();
  }

  /** `n` and `p`: the next or previous line the search matched, wrapping at either end. */
  private stepSearch(direction: 1 | -1): void {
    const search = this.search;
    if (!search) {
      this.footer.setMessage("Press / to search this file.");
      return;
    }
    const count = search.lines.length;
    if (!count) return this.showSearch();
    search.at = (search.at + direction + count) % count;
    const line = search.lines[search.at];
    if (line !== undefined) this.scrollToLine(line);
    this.showSearch();
  }

  private showSearch(): void {
    const search = this.search;
    if (!search) return;
    const count = !search.query
      ? ""
      : search.lines.length
        ? `  ${search.at + 1} of ${search.lines.length}`
        : "  no matches";
    this.footer.setMessage(`/${search.query}${count}`);
  }

  /** Scrolls so `line` (counted from zero) sits a third of the way down the reader. */
  private scrollToLine(line: number): void {
    this.viewer.scrollTo({ x: 0, y: Math.max(0, line - Math.floor(this.viewer.viewport.height / 3)) });
    this.updatePosition();
  }

  /** `o` in the diff: open the highlighted file in the reader, at the first line it changes. */
  private async openChanged(): Promise<void> {
    const target = this.diffScreen.changedFile();
    if (!target) {
      this.footer.setMessage("This file was deleted, so there is nothing to open.");
      return;
    }
    this.leaveDiff();
    await this.open(target.path);
    if (this.renderer.isDestroyed || this.document?.path !== target.path) return;
    this.scrollToLine(target.line - 1);
  }

  private readonly dispose = (): void => {
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.off("focused_renderable", this.updateFocus);
    this.renderer.off("resize", this.resizeSidebar);
    clearTimeout(this.browseTimer);
    // The queue ends any refresh in progress first, so the repository it opened is closed too.
    this.workerClosed = Promise.all([
      this.codeView.destroy(),
      this.diffScreen.close(),
      this.browseQueue.then(() => this.closeBrowseSource()),
    ]).then(() => undefined);
  };

  private async closeBrowseSource(): Promise<void> {
    const repository = this.browseSource?.repository;
    this.browseSource = undefined;
    if (repository) await closeRepository(repository);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.renderer.destroy();
    await this.renderer.closed;
    await this.workerClosed;
  }
}
