import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  RGBA,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { CodeView, languageFor } from "./code-view";
import { DiffScreen } from "./diff-screen";
import { FileExplorer } from "./explorer";
import { FileTree } from "./file-tree";
import { Footer } from "./footer";
import { PaneHeader, type HeaderBadge } from "./header";
import { theme } from "./theme";
import { createWelcome } from "./welcome";
import { describeError, displayLabel, readDocument, type Document } from "./files";
import { GitError } from "./git";

const FALLBACK_SIDEBAR_BACKGROUND = "#131519";
const SIDEBAR_TINT = 0.025;
/** How visible the pane without focus stays: 1 is untouched, 0 is invisible. */
const INACTIVE_OPACITY = 0.5;
const transparent = RGBA.fromValues(0, 0, 0, 0);
/** How often the diff screen re-reads git while it is open. */
const DIFF_POLL_MS = 2000;
const MIN_SIDEBAR_COLUMNS = 24;
const MIN_READER_COLUMNS = 28;

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
  private operation: "idle" | "loading" = "idle";
  private readonly browserPanel: BoxRenderable;
  private readonly browser: FileExplorer;
  private readonly viewerPanel: BoxRenderable;
  private readonly viewerHeader: PaneHeader;
  private readonly sidebarResizer: BoxRenderable;
  private readonly viewer: ScrollBoxRenderable;
  private readonly codeView: CodeView;
  private readonly footer: Footer;
  private readonly welcome: BoxRenderable;
  private readonly diffScreen: DiffScreen;
  private mode: "browse" | "diff" = "browse";
  /** Which pane had focus when the diff screen opened, so closing it puts the user back where they were. */
  private paneBeforeDiff: "list" | "reader" = "list";
  private hasDocument = false;
  private documentTitle = "Reader";
  private document?: Document;
  private wrap = false;
  private workerClosed = Promise.resolve();
  private preferredSidebarWidth?: number;
  private sidebarDrag?: { startX: number; startWidth: number };

  constructor(
    private readonly renderer: CliRenderer,
    options: { diffPollMs?: number } = {},
  ) {
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
    });
    this.browser = new FileExplorer(renderer, { onActivate: this.onExplorerActivate });
    this.viewerPanel = new BoxRenderable(renderer, {
      id: "viewer-panel",
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      flexDirection: "column",
      paddingLeft: 1,
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
      onSizeChange: () => this.updatePosition(),
    });
    this.viewer.visible = false;
    this.welcome = createWelcome(renderer);
    this.codeView = new CodeView(renderer, { onLayout: () => this.updatePosition() });
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
    this.browserPanel.add(this.browser);
    this.browserPanel.add(this.diffScreen.list);
    this.codeView.mount(this.viewer);
    this.viewerPanel.add(this.viewerHeader.root);
    this.viewerPanel.add(this.welcome);
    this.viewerPanel.add(this.viewer);
    this.viewerPanel.add(this.diffScreen.body);
    panes.add(this.browserPanel);
    panes.add(this.sidebarResizer);
    panes.add(this.viewerPanel);
    layout.add(panes);
    layout.add(this.footer.root);
    renderer.root.add(layout);
    renderer.keyInput.on("keypress", this.onKeyPress);
    renderer.on("focused_renderable", this.updateFocus);
    renderer.on("resize", this.resizeSidebar);
    renderer.once("destroy", this.dispose);
    this.resizeSidebar();
    this.focusBrowser();
    void this.tintSidebar();
  }

  private async tintSidebar(): Promise<void> {
    const palette = await this.renderer.getPalette({ timeout: 500 }).catch(() => undefined);
    if (this.renderer.isDestroyed) return;
    const tint = tintedBackground(palette?.defaultBackground ?? null);
    this.browserPanel.backgroundColor = tint;
    this.footer.setBackground(tint);
    this.diffScreen.setTint(tint);
    this.renderer.requestRender();
  }

  async open(path: string): Promise<void> {
    if (this.operation === "loading" || this.renderer.isDestroyed) return;
    this.operation = "loading";
    this.footer.setMessage("Loading…");
    try {
      await this.openPath(resolve(path));
    } catch (error) {
      if (!this.renderer.isDestroyed) {
        this.footer.setMessage(describeError(error), true);
        // Nothing opened, so the click that led here belongs to the sidebar.
        this.focusBrowser();
      }
    } finally {
      this.operation = "idle";
    }
  }

  private async openPath(path: string): Promise<void> {
    if ((await stat(path)).isDirectory()) return this.openDirectory(path);
    const document = await readDocument(path);
    if (this.renderer.isDestroyed) return;
    if (!this.tree.has(path)) await this.openDirectory(dirname(path));
    if (this.renderer.isDestroyed) return;
    this.tree.reveal(path);
    this.renderTree(path);
    this.showDocument(document);
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
    this.browser.show(entries, selectedPath);
  }

  private showDocument(document: Document): void {
    const language = this.codeView.show(document);
    this.document = document;
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

  private async toggleDiff(): Promise<void> {
    if (this.mode === "diff") return this.leaveDiff();
    await this.loadDiff(() => this.enterDiff());
  }

  /** Reads the repository, then runs `then`. Failures such as "Not a git repository." land in the footer. */
  private async loadDiff(then: () => void): Promise<void> {
    if (this.operation === "loading" || this.renderer.isDestroyed) return;
    this.operation = "loading";
    this.footer.setMessage("Loading changes…");
    try {
      await this.diffScreen.load(this.rootPath());
      if (!this.renderer.isDestroyed) {
        this.footer.clearMessage();
        then();
      }
    } catch (error) {
      if (!this.renderer.isDestroyed)
        this.footer.setMessage(error instanceof GitError ? error.message : describeError(error), true);
    } finally {
      this.operation = "idle";
    }
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
    if (this.wrap && !rendered) badges.push({ text: "wrap", kind: "pill" });
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

  private focusBrowser(): void {
    this.list.focus();
    this.updateFocus();
  }

  private readonly updateFocus = (): void => {
    this.viewerHeader.setFocused(this.reader.focused);
    this.browserPanel.opacity = this.list.focused ? 1 : INACTIVE_OPACITY;
    // The welcome screen and the empty "No changes" message are not panes to read, so they keep full brightness.
    // Whether the highlighted file has a text diff must not matter: moving down the list would flicker the reader.
    const dimmable = this.mode === "diff" ? this.diffScreen.hasChanges : this.hasDocument;
    this.viewerPanel.opacity = this.reader.focused || !dimmable ? 1 : INACTIVE_OPACITY;
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
    if (this.operation === "loading" || this.renderer.isDestroyed) return;
    // Opening a file ends with the reader focused, so focusing the sidebar on the way would flash both panes
    // (sidebar bright, reader dim, then back). Only a collapse, which stays in the sidebar, needs focus now;
    // expanding a folder takes it when its contents have loaded.
    if (this.browser.selected()?.state === "expanded") this.focusBrowser();
    this.openSelected("toggle");
  };

  private readonly onKeyPress = (key: KeyEvent): void => {
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
    if (this.operation === "loading") {
      key.preventDefault();
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
    if (key.name === "s") this.diffScreen.toggleView();
    else if (key.name === "a") this.diffScreen.toggleScope();
    else if (key.name === "r") void this.loadDiff(() => this.onDiffChange());
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
    if (["g", "home", "end"].includes(key.name)) {
      key.preventDefault();
      this.reader.scrollTo(key.shift || key.name === "end" ? Infinity : 0);
    }
  }

  private readonly dispose = (): void => {
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.off("focused_renderable", this.updateFocus);
    this.renderer.off("resize", this.resizeSidebar);
    this.workerClosed = Promise.all([this.codeView.destroy(), this.diffScreen.close()]).then(() => undefined);
  };

  async [Symbol.asyncDispose](): Promise<void> {
    this.renderer.destroy();
    await this.renderer.closed;
    await this.workerClosed;
  }
}
