import { BoxRenderable, ScrollBoxRenderable, type CliRenderer, type KeyEvent, type Selection } from "@opentui/core";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { copiedSummary, copyToClipboard } from "../core/clipboard";
import {
  BinaryFileError,
  describeError,
  displayLabel,
  formatBytes,
  isImagePath,
  readDocumentWithStamp,
  readImage,
  treeRelative,
} from "../core/files";
import { boundaryOf, isPlain, isQuit, scrollByKey } from "../core/keys";
import type { ClipboardWriter, Document, ImageFile } from "../core/types";
import { DiffScreen, MIN_SPLIT_COLUMNS } from "../diff/diff-screen";
import { GitError } from "../diff/git";
import { GitMarks } from "../diff/marks";
import type { DiffState } from "../diff/types";
import { BrowseWatcher } from "../explorer/browse-watcher";
import { FileExplorer } from "../explorer/explorer";
import { FileTree } from "../explorer/file-tree";
import { SidebarResizer } from "../explorer/sidebar-resizer";
import type { RefreshOptions, RowStyle, TreeEntry } from "../explorer/types";
import { FileFinder } from "../find/file-finder";
import { languageFor } from "../reader/code-view";
import { DocumentSearch } from "../reader/document-search";
import { describeImage } from "../reader/image-view";
import { JumpHistory } from "../reader/jump-history";
import { ReaderMotion } from "../reader/reader-motion";
import type { ImageDetails } from "../reader/types";
import { Footer } from "../ui/footer";
import { PaneHeader } from "../ui/header";
import { createHelp } from "../ui/help";
import { SystemThemeWatcher } from "../ui/system-theme";
import { setThemeMode, theme, tintedBackground } from "../ui/theme";
import type { SystemTheme } from "../ui/types";
import { diffFooterFor, formatScrollPosition, sidebarHeaderFor, viewerBadgesFor, viewerHeaderFor } from "./chrome";
import { ReaderPane } from "./reader-pane";
import type { ScouterAppOptions } from "./types";

const DIFF_POLL_MS = 2000;
const BROWSE_POLL_MS = 2000;

export class ScouterApp {
  private readonly tree = new FileTree();
  private loading?: "open" | "diff";
  private diffToken = 0;
  private readonly browserPanel: BoxRenderable;
  private readonly browserHeader: PaneHeader;
  private readonly browser: FileExplorer;
  private readonly viewerPanel: BoxRenderable;
  private readonly viewerHeader: PaneHeader;
  private readonly copyWriter: ClipboardWriter;
  private readonly sidebar: SidebarResizer;
  private readonly readerPane: ReaderPane;
  private readonly footer: Footer;
  private readonly layout: BoxRenderable;
  private help?: BoxRenderable;
  private helpBackground: string = theme.fallbackBackground;
  private readonly diffScreen: DiffScreen;
  private readonly finder: FileFinder;
  private readonly search: DocumentSearch;
  private readonly motion: ReaderMotion;
  private readonly watcher: BrowseWatcher;
  private readonly systemTheme: SystemThemeWatcher;
  private readonly marks = new GitMarks();
  private readonly jumps = new JumpHistory();
  private mode: "browse" | "diff" = "browse";
  private paneBeforeDiff: "list" | "reader" = "list";
  private focusPane?: "list" | "reader";
  private wrap = false;
  private copyNoticeTimer?: ReturnType<typeof setTimeout>;
  private readonly letterCommands = new Map<string, () => void>([
    ["w", () => this.toggleWrap()],
    ["m", () => this.toggleMarkdownSource()],
    ["d", () => void this.toggleDiff()],
    ["y", () => void this.yank()],
  ]);

  constructor(
    private readonly renderer: CliRenderer,
    options: ScouterAppOptions = {},
  ) {
    const layout = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
    this.layout = layout;
    const panes = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "row",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
    });
    this.copyWriter = options.copy ?? ((text) => copyToClipboard(renderer, text));
    this.browserPanel = new BoxRenderable(renderer, {
      id: "browser-panel",
      flexShrink: 0,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
    });
    this.browserHeader = new PaneHeader(renderer, "browser-header");
    this.browserHeader.setTitle("Files");
    this.browser = new FileExplorer(renderer, { onActivate: this.onExplorerActivate });
    this.viewerPanel = new BoxRenderable(renderer, {
      id: "viewer-panel",
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
    });
    this.viewerHeader = new PaneHeader(renderer, "viewer-header");
    this.viewerHeader.setTitle("Reader");
    this.sidebar = new SidebarResizer(renderer, this.browserPanel);
    this.readerPane = new ReaderPane(renderer, {
      imageProtocol: options.imageProtocol,
      onPositionChange: () => this.updatePosition(),
    });
    this.updateViewerBadges();
    this.footer = new Footer(renderer);
    this.diffScreen = new DiffScreen(renderer, {
      syntax: this.readerPane.syntax,
      onChange: this.onDiffChange,
      onActivate: this.onDiffActivate,
      onFocusList: this.onDiffFocusList,
      onLayout: () => this.updatePosition(),
      pollMs: options.diffPollMs ?? DIFF_POLL_MS,
    });
    this.diffScreen.list.visible = false;
    this.diffScreen.body.visible = false;
    this.finder = new FileFinder(renderer, {
      browser: this.browser,
      footer: this.footer,
      rootPath: () => this.tree.rootPath,
      isIgnored: (relativePath) => this.marks.isIgnored(relativePath),
      styleOf: (entry) => this.styleOf(entry),
      showTree: (path) => this.renderTree(path),
      pick: (picked, typed) => this.pickFound(picked, typed),
      preview: (entry, query) => void this.previewHit(entry, query),
      isDestroyed: () => renderer.isDestroyed,
    });
    this.search = new DocumentSearch({
      footer: this.footer,
      text: () => this.readerPane.document?.text,
      topLine: () => Math.floor(this.readerPane.viewer.scrollTop),
      scrollToLine: (line) => this.scrollToLine(line),
      highlight: (query) => this.readerPane.codeView.setHighlight(query),
      highlightLine: (line) => this.readerPane.codeView.setActiveLine(line),
    });
    this.motion = new ReaderMotion({
      canAcceptCount: () => !this.list.focused && this.mode === "browse" && this.readerReady,
      isPreviewing: () => this.readerPane.previewing,
      documentText: () => this.readerPane.document?.text,
      currentMatchLine: () => this.search.currentLine(),
      scrollTop: () => this.readerPane.viewer.scrollTop,
      viewportHeight: () => this.readerPane.viewer.viewport.height,
      scrollTo: (position) => {
        this.readerPane.viewer.scrollTo(position);
        this.updatePosition();
      },
      scrollToLine: (line) => this.scrollToLine(line),
      setPending: (count) => this.footer.setPending(count),
      setMessage: (text) => this.footer.setMessage(text),
    });
    this.watcher = new BrowseWatcher({
      pollMs: options.browsePollMs ?? BROWSE_POLL_MS,
      isDestroyed: () => renderer.isDestroyed,
      refresh: (refreshOptions) => this.refreshBrowse(refreshOptions),
    });
    this.browserPanel.add(this.browserHeader.root);
    this.browserPanel.add(this.finder.bar);
    this.browserPanel.add(this.browser);
    this.browserPanel.add(this.diffScreen.list);
    this.viewerPanel.add(this.viewerHeader.root);
    this.readerPane.mount(this.viewerPanel);
    this.viewerPanel.add(this.diffScreen.body);
    panes.add(this.browserPanel);
    panes.add(this.sidebar.handle);
    panes.add(this.viewerPanel);
    layout.add(panes);
    layout.add(this.footer.root);
    renderer.root.add(layout);
    renderer.keyInput.on("keypress", this.onKeyPress);
    renderer.on("focused_renderable", this.updateFocus);
    renderer.on("selection", this.onSelection);
    renderer.once("destroy", this.dispose);
    this.sidebar.fit();
    this.focusBrowser();
    this.systemTheme = new SystemThemeWatcher(renderer, (system) => this.applyTheme(system));
    this.systemTheme.start();
    this.watcher.start();
  }

  private applyTheme({ mode, background }: SystemTheme): void {
    if (this.renderer.isDestroyed) return;

    setThemeMode(mode);
    const tint = tintedBackground(background);
    this.footer.setBackground(tint);
    this.diffScreen.setTint(tint);
    const replacedStyle = this.readerPane.restyle();
    this.diffScreen.restyle();
    this.browser.repaint((entry) => this.styleOf(entry));
    this.finder.restyle();
    this.browserHeader.restyle();
    this.viewerHeader.restyle();
    this.footer.restyle();
    this.rebuildHelp(tint);
    this.focusPane = undefined;
    this.updateFocus();
    replacedStyle.destroy();
    this.renderer.requestRender();
  }

  private ensureHelp(): BoxRenderable {
    if (!this.help) {
      this.help = createHelp(this.renderer, this.helpBackground);
      this.help.visible = false;
      this.layout.add(this.help);
    }

    return this.help;
  }

  private rebuildHelp(background: string): void {
    this.helpBackground = background;

    if (!this.help) return;

    const visible = this.help.visible;
    this.help.destroyRecursively();
    this.help = createHelp(this.renderer, background);
    this.help.visible = visible;
    this.layout.add(this.help);
  }

  async open(path: string): Promise<void> {
    await this.show(path, () => this.jumps.leave(this.readerPane.here()));
  }

  private async show(path: string, beforeOpen?: () => void, top = 0): Promise<void> {
    if (this.renderer.isDestroyed) return;

    const opened = await this.runLoading(
      async () => {
        this.viewerHeader.setNotice(undefined);
        this.footer.setMessage("Loading…");
        beforeOpen?.();
        await this.openPath(resolve(path));

        if (top > 0 && this.readerPane.document && !this.renderer.isDestroyed) this.scrollToTop(top);
      },
      () => this.focusBrowser(),
    );

    if (opened) void this.watcher.refresh({ marksOnly: true });
  }

  private async jump(direction: "back" | "forward"): Promise<void> {
    if (this.renderer.isDestroyed) return;

    if (this.loading) return this.refuseWhileLoading();

    const here = this.readerPane.here();
    const can = direction === "back" ? this.jumps.canGoBack : this.jumps.canGoForward;

    if (!can) {
      this.footer.setMessage(direction === "back" ? "No earlier place to go back to." : "No later place to go to.");
      return;
    }

    const target = direction === "back" ? this.jumps.back(here) : this.jumps.forward(here);

    if (!target) return;

    if (this.mode === "diff") this.leaveDiff();

    await this.show(target.path, undefined, target.top);
  }

  private scrollToTop(top: number): void {
    this.readerPane.scrollToTop(top);
    this.updatePosition();
  }

  private async runLoading(task: () => Promise<void>, onFailure?: () => void): Promise<boolean> {
    if (this.loading) {
      this.refuseWhileLoading();
      return false;
    }

    this.loading = "open";
    try {
      await task();
      return true;
    } catch (error) {
      if (!this.renderer.isDestroyed) {
        this.showError(describeError(error));
        onFailure?.();
      }

      return false;
    } finally {
      this.loading = undefined;
    }
  }

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

    try {
      const { document, stamp } = await readDocumentWithStamp(path);

      if (await this.reveal(path)) this.showDocument(document, stamp);
    } catch (error) {
      if (error instanceof BinaryFileError) {
        if (await this.reveal(path)) this.showBinary(path, error.size);

        return;
      }

      throw error;
    }
  }

  private async reveal(path: string): Promise<boolean> {
    if (this.renderer.isDestroyed) return false;

    if (this.tree.has(path) && !this.finder.active && this.browser.selectPath(path)) return true;

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

    if (this.readerPane.hasDocument) this.footer.clearMessage();
    else this.footer.setLocation(path);

    this.focusBrowser();
  }

  private renderTree(selectedPath: string, scrollIntoView = true): void {
    const entries = this.tree.rows();
    this.browser.show(entries, selectedPath, (entry) => this.styleOf(entry), scrollIntoView);
    this.updateSidebarHeader();
  }

  private updateSidebarHeader(diffState?: DiffState): void {
    this.browserHeader.root.visible = !this.finder.active;
    const state = this.mode === "diff" ? (diffState ?? this.diffScreen.state()) : undefined;
    const header = sidebarHeaderFor(this.tree.rootPath, state);
    this.browserHeader.setTitle(header.title);
    this.browserHeader.setBadges(header.badges);
  }

  private styleOf(entry: TreeEntry): RowStyle {
    const path = treeRelative(this.tree.rootPath ?? entry.path, entry.path);
    return { ...this.marks.styleOf(path), ignored: this.marks.isIgnored(path) };
  }

  private showImage(file: ImageFile, details: ImageDetails): void {
    this.footer.batch(() => {
      this.readerPane.showImage(file, this.mode === "browse");
      this.search.clear();
      this.footer.setLocation(file.path);
      this.footer.setDocument({ lines: 0, language: details.format, image: details });
      this.finishShowing();
    });
  }

  private showDocument(document: Document, stamp: string): void {
    this.footer.batch(() => {
      const language = this.readerPane.showDocument(document, stamp, this.mode === "browse");
      this.footer.setLocation(document.path);
      this.footer.setDocument(this.readerPane.documentInfo(document, language));
      this.search.refresh();
      this.finishShowing();
    });
  }

  private showBinary(path: string, size: number): void {
    this.readerPane.showBinary(path, size, this.mode === "browse");
    this.search.clear();
    this.footer.setLocation(path);
    this.footer.setDocument({ lines: 0, language: "binary", binary: { size: formatBytes(size) } });
    this.updateChrome();
    this.focusBrowser();
    this.renderer.requestRender();
  }

  private finishShowing(): void {
    this.updateChrome();
    this.updatePosition();

    if (this.mode === "browse") this.readerPane.viewer.focus();

    this.updateFocus();
  }

  private toggleMarkdownSource(): void {
    if (this.mode !== "browse") return;

    const document = this.readerPane.toggleMarkdownSource();

    if (!document) return;

    this.footer.setDocument(this.readerPane.documentInfo(document, languageFor(document.path)));
    this.updateViewerBadges();
    this.updatePosition();
    this.renderer.requestRender();
  }

  private get list(): ScrollBoxRenderable {
    return this.mode === "diff" ? this.diffScreen.list : this.browser;
  }

  private get reader(): ScrollBoxRenderable {
    return this.mode === "diff" ? this.diffScreen.scroller : this.readerPane.viewer;
  }

  private get readerReady(): boolean {
    return this.mode === "diff" ? this.diffScreen.showingDiff : this.readerPane.hasDocument;
  }

  private updateChrome(): void {
    const diffState = this.mode === "diff" ? this.diffScreen.state() : undefined;
    this.updateSidebarHeader(diffState);
    const header = viewerHeaderFor(this.readerPane.previewPath, this.tree.rootPath, this.readerPane.shown, diffState);
    this.viewerHeader.setTitle(header.title, header.parent);

    if (this.readerPane.previewPath !== undefined) {
      this.viewerHeader.setBadges([{ text: "preview", kind: "pill" }]);
      return;
    }

    this.updateViewerBadges(diffState);

    if (diffState) this.footer.setDiff(diffFooterFor(diffState));
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

    if (this.loading === "diff") return this.cancelDiff();

    await this.loadDiff(() => this.enterDiff());
  }

  private cancelDiff(): void {
    this.loading = undefined;
    this.diffToken += 1;
    this.footer.setMessage("Cancelled.");
  }

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

  private showError(message: string): void {
    this.footer.setMessage(message, true);
    this.viewerHeader.setNotice(message);
  }

  private toggleSplit(): void {
    if (this.diffScreen.toggleView()) return;

    this.footer.setMessage(`Split needs ${MIN_SPLIT_COLUMNS}+ columns.`);
  }

  private enterDiff(): void {
    this.paneBeforeDiff = this.readerPane.viewer.focused ? "reader" : "list";
    this.mode = "diff";
    this.browser.visible = false;
    this.readerPane.setBrowseVisible(false);
    this.diffScreen.list.visible = true;
    this.diffScreen.body.visible = true;
    this.footer.batch(() => {
      this.footer.setMode("diff");
      this.footer.clearMessage();
      this.updateChrome();
      this.diffScreen.list.focus();
      this.updateFocus();
    });
    this.diffScreen.watch();
  }

  private leaveDiff(): void {
    this.mode = "browse";
    this.diffScreen.list.visible = false;
    this.diffScreen.body.visible = false;
    this.browser.visible = true;
    this.readerPane.setBrowseVisible(true);
    this.footer.batch(() => {
      this.footer.setMode("browse");
      this.updateChrome();
      this.updatePosition();

      if (this.paneBeforeDiff === "reader" && this.readerPane.hasDocument) this.readerPane.viewer.focus();
      else this.browser.focus();

      this.updateFocus();
    });
    this.diffScreen.leave();
    void this.watcher.refresh();
  }

  private async refreshBrowse(options?: RefreshOptions): Promise<void> {
    const root = this.tree.rootPath;

    if (this.renderer.isDestroyed || this.mode !== "browse" || this.loading === "open" || !root) return;

    const marksOnly = options?.marksOnly ?? false;

    try {
      const folders = marksOnly
        ? []
        : await Promise.all(this.tree.expandedPaths().map((path) => this.tree.refresh(path)));
      const marks = await this.marks.refresh(root);

      if (!marksOnly) {
        await this.readerPane.refreshDocument(
          (path) => this.showError(`${displayLabel(basename(path))} is no longer on disk.`),
          (next) => {
            this.footer.setDocument(this.readerPane.documentInfo(next, languageFor(next.path)));
            this.search.refresh();
            this.updateChrome();
            this.updatePosition();
          },
        );
      }

      if (this.renderer.isDestroyed || this.mode !== "browse") return;

      if (this.finder.active) return;

      if (folders.some(Boolean)) this.renderTree(this.browser.selected()?.path ?? root, false);
      else if (marks) this.browser.repaint((entry) => this.styleOf(entry));
    } catch {}
  }

  private async goUp(): Promise<void> {
    const root = this.tree.rootPath;

    if (!root) return;

    const parent = dirname(root);

    if (parent === root) {
      this.footer.setMessage("Already at the top of the file system.");
      return;
    }

    await this.loadTree(root, async () => {
      await this.tree.load(parent);
      await this.tree.expand(root);
    });
  }

  private async revealFolder(path: string): Promise<void> {
    await this.loadTree(path, async () => {
      await this.tree.expandTo(path);
      await this.tree.expand(path);
    });
  }

  private async loadTree(selectedPath: string, change: () => Promise<void>): Promise<void> {
    if (!(await this.runLoading(change)) || this.renderer.isDestroyed) return;

    this.renderTree(selectedPath);
    void this.watcher.refresh({ marksOnly: true });
  }

  private updateViewerBadges(diffState?: DiffState): void {
    const state = this.mode === "diff" ? (diffState ?? this.diffScreen.state()) : undefined;
    this.viewerHeader.setBadges(viewerBadgesFor(this.readerPane.shown, this.wrap, this.readerPane.previewing, state));
  }

  private updatePosition(): void {
    if (!this.readerReady) return;

    this.footer.setPosition(
      formatScrollPosition(this.reader.scrollHeight, this.reader.viewport.height, this.reader.scrollTop),
    );
  }

  private toggleWrap(): void {
    this.wrap = !this.wrap;
    this.readerPane.setWrap(this.wrap);
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

    if (entry.parentPath && !this.browser.selectPath(entry.parentPath)) this.renderTree(entry.parentPath);
  }

  private focusBrowser(): void {
    this.list.focus();
    this.updateFocus();
  }

  private readonly updateFocus = (): void => {
    const pane = this.reader.focused ? "reader" : "list";

    if (pane !== this.focusPane) {
      this.focusPane = pane;
      this.browserPanel.borderColor = pane === "list" ? theme.accent : theme.border;
      this.viewerPanel.borderColor = pane === "reader" ? theme.accent : theme.border;
    }

    this.browserHeader.setFocused(pane === "list");
    this.viewerHeader.setFocused(this.reader.focused);
    this.footer.setFocus(this.reader.focused ? "reader" : "files");
  };

  private readonly onExplorerActivate = (): void => {
    if (this.renderer.isDestroyed) return;

    if (this.finder.active) {
      this.finder.pick();
      return;
    }

    if (this.browser.selected()?.state === "expanded") this.focusBrowser();

    this.openSelected("toggle");
  };

  private readonly onKeyPress = (key: KeyEvent): void => {
    this.viewerHeader.setNotice(undefined);

    if (this.finder.handleKey(key) || this.search.handleKey(key)) return;

    const afterZ = this.motion.consumeZ();

    if (isQuit(key)) {
      key.preventDefault();
      this.renderer.destroy();
      return;
    }

    if (this.help?.visible) {
      key.preventDefault();
      this.help.visible = false;
      return;
    }

    if (this.motion.absorbCount(key)) return;

    const count = this.motion.takeCount();
    const command = this.commandFor(key);

    if (command) {
      key.preventDefault();
      command();
      return;
    }

    if (this.mode === "diff" && this.handleDiffKey(key)) return;

    if (!this.list.focused) this.handleViewerKey(key, count, afterZ);
    else if (this.mode === "diff") this.handleChangesKey(key);
    else this.handleBrowserKey(key);
  };

  private commandFor(key: KeyEvent): (() => void) | undefined {
    if (key.name === "tab") return () => this.switchPane();

    if (key.name === "escape") return () => this.escape();

    if (key.sequence === "?" && isPlain(key)) return () => void (this.ensureHelp().visible = true);

    if (key.ctrl && !key.meta && (key.name === "left" || key.name === "right")) {
      return () => this.sidebar.nudge(key.name === "left" ? "left" : "right");
    }

    const typing = this.finder.active || this.search.prompting;

    if (!typing && key.ctrl && !key.meta && key.name === "o") return () => void this.jump("back");

    if (!typing && key.meta && !key.ctrl && key.name === "i") return () => void this.jump("forward");

    return isPlain(key) && !key.shift ? this.letterCommands.get(key.name) : undefined;
  }

  private escape(): void {
    if (this.renderer.hasSelection) {
      this.renderer.clearSelection();
      return;
    }

    if (!this.list.focused && this.search.dismiss()) return;

    this.focusBrowser();
  }

  private readonly onSelection = (selection: Selection): void => {
    if (selection.isDragging) return;

    const text = selection.getSelectedText();

    if (!text) return;

    queueMicrotask(() => {
      if (!this.renderer.isDestroyed) this.renderer.clearSelection();
    });
    void this.writeClipboard(text, copiedSummary(text));
  };

  private async yank(): Promise<void> {
    if (this.renderer.hasSelection) {
      const text = this.renderer.getSelection()?.getSelectedText();

      if (text) {
        this.renderer.clearSelection();
        await this.writeClipboard(text, copiedSummary(text));
        return;
      }
    }

    const path = this.currentPath();

    if (!path) return;

    await this.writeClipboard(path, "Copied path.");
  }

  private currentPath(): string | undefined {
    if (this.mode === "diff") return this.diffScreen.state().selected?.path;

    if (this.list.focused) return this.browser.selected()?.path;

    const shown = this.readerPane.shown;

    if (shown.kind === "text") return shown.document.path;

    if (shown.kind === "image") return shown.path;

    return this.browser.selected()?.path;
  }

  private async writeClipboard(text: string, summary: string): Promise<void> {
    const ok = await this.copyWriter(text);

    if (this.renderer.isDestroyed) return;

    clearTimeout(this.copyNoticeTimer);
    this.footer.setMessage(ok ? summary : "Could not copy to clipboard.", !ok);

    if (ok) {
      this.copyNoticeTimer = setTimeout(() => {
        if (!this.renderer.isDestroyed) this.footer.clearMessage();
      }, 2000);
      this.copyNoticeTimer.unref?.();
    }
  }

  private switchPane(): void {
    if (this.list.focused && this.readerReady) this.reader.focus();
    else this.focusBrowser();

    this.updateFocus();
  }

  private handleDiffKey(key: KeyEvent): boolean {
    if (!isPlain(key)) return false;

    if (key.name === "s") this.toggleSplit();
    else if (key.name === "a") this.diffScreen.toggleScope();
    else if (key.name === "c") this.diffScreen.toggleCollapse();
    else if (key.name === "x") this.diffScreen.toggleContext();
    else if (key.name === "r") void this.loadDiff(() => this.onDiffChange());
    else if (key.name === "o") void this.openChanged();
    else if ((key.name === "n" && !key.shift) || key.sequence === "]") this.stepHunk(1);
    else if (key.name === "n" || key.name === "p" || key.sequence === "[") this.stepHunk(-1);
    else return false;

    key.preventDefault();
    return true;
  }

  private stepHunk(direction: 1 | -1): void {
    const result = this.diffScreen.jumpHunk(direction);

    if (result === "first") this.footer.setMessage("First hunk.");
    else if (result === "last") this.footer.setMessage("Last hunk.");
  }

  private handleChangesKey(key: KeyEvent): void {
    if (!isPlain(key)) return;

    if (["return", "l", "right"].includes(key.name)) {
      key.preventDefault();
      this.diffScreen.openSelected();
      return;
    }

    const edge = boundaryOf(key);

    if (!edge) return;

    key.preventDefault();
    this.diffScreen.list.selectBoundary(edge);
  }

  private handleBrowserKey(key: KeyEvent): void {
    if (!isPlain(key)) return;

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
      this.startFind();
      return;
    }

    const edge = boundaryOf(key);

    if (!edge) return;

    key.preventDefault();
    this.browser.selectBoundary(edge);
  }

  private handleViewerKey(key: KeyEvent, count: number, afterZ: boolean): void {
    if (key.meta) return;

    if (scrollByKey(this.reader, key) || key.ctrl) return;

    if (this.mode === "browse" && this.handleSearchKeyInReader(key)) return;

    if (this.mode === "browse" && this.motion.handleKey(key, afterZ)) return;

    const edge = boundaryOf(key);

    if (!edge) return;

    key.preventDefault();

    if (edge === "end" && count) this.scrollToLine(count - 1);
    else this.reader.scrollTo(edge === "end" ? Infinity : 0);
  }

  private handleSearchKeyInReader(key: KeyEvent): boolean {
    if (key.name === "/") this.startSearch();
    else if (key.name === "n" && !key.shift) this.search.step(1);
    else if (key.name === "n" || key.name === "p") this.search.step(-1);
    else return false;

    key.preventDefault();
    return true;
  }

  private startFind(): void {
    if (!this.tree.rootPath || this.finder.active) return;

    if (this.loading) return this.refuseWhileLoading();

    this.browserHeader.root.visible = false;
    void this.finder.start();
  }

  private pickFound(picked: TreeEntry, typed: string): void {
    if (picked.match) {
      void this.openAt(picked.path, picked.match.line, typed);
      return;
    }

    if (!typed.trim()) return this.openSelected("toggle");

    if (picked.kind === "directory") void this.revealFolder(picked.path);
    else void this.open(picked.path);
  }

  private async previewHit(entry: TreeEntry | undefined, query: string): Promise<void> {
    if (await this.readerPane.previewHit(entry, query)) this.updateChrome();
  }

  private startSearch(): void {
    if (!this.readerPane.document) return;

    if (this.readerPane.previewing) {
      this.footer.setMessage("Press m to search this Markdown file's source.");
      return;
    }

    this.search.start();
  }

  private scrollToLine(line: number): void {
    this.readerPane.scrollToLine(line);
    this.updatePosition();
  }

  private async openChanged(): Promise<void> {
    const target = this.diffScreen.changedFile();

    if (!target) {
      this.footer.setMessage("This file was deleted, so there is nothing to open.");
      return;
    }

    this.leaveDiff();
    await this.openAt(target.path, target.line);
  }

  private async openAt(path: string, line: number, query?: string): Promise<void> {
    if (query) this.readerPane.codeView.setHighlight(query);

    await this.open(path);

    if (this.renderer.isDestroyed) return;

    if (this.readerPane.document?.path !== path) {
      this.search.syncHighlight();
      return;
    }

    if (this.readerPane.previewing) this.toggleMarkdownSource();

    this.scrollToLine(line - 1);

    if (query) this.search.seed(query, line - 1);
  }

  private workerClosed = Promise.resolve();

  private readonly dispose = (): void => {
    clearTimeout(this.copyNoticeTimer);
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.off("focused_renderable", this.updateFocus);
    this.renderer.off("selection", this.onSelection);
    this.sidebar.dispose();
    this.systemTheme.stop();
    this.workerClosed = Promise.all([
      this.readerPane.destroy(),
      this.diffScreen.close(),
      this.watcher.stop().then(() => this.marks.close()),
    ]).then(() => undefined);
  };

  async [Symbol.asyncDispose](): Promise<void> {
    this.renderer.destroy();
    await this.renderer.closed;
    await this.workerClosed;
  }
}
