import { BoxRenderable, ScrollBoxRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { BrowseWatcher } from "./browse-watcher";
import { CodeView, languageFor } from "./code-view";
import { DiffScreen, MIN_SPLIT_COLUMNS } from "./diff-screen";
import { DocumentSearch } from "./document-search";
import { FileExplorer, type RowStyle } from "./explorer";
import { FileFinder } from "./file-finder";
import { FileTree, type TreeEntry } from "./file-tree";
import { Footer } from "./footer";
import { PaneHeader, type HeaderBadge } from "./header";
import { boundaryOf, isPlain, isQuit, scrollByKey } from "./keys";
import { GitMarks, treeRelative } from "./marks";
import { HitPreview } from "./preview";
import { createHelp } from "./help";
import { SidebarResizer } from "./sidebar-resizer";
import { scrollbarStyle } from "./styled";
import { SystemThemeWatcher, type SystemTheme } from "./system-theme";
import { setThemeMode, theme, tintedBackground, transparent } from "./theme";
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
import { GitError } from "./git";

const DIFF_POLL_MS = 2000;
const BROWSE_POLL_MS = 2000;

export interface ScouterAppOptions {
  diffPollMs?: number;
  browsePollMs?: number;
  imageProtocol?: "auto" | "kitty" | "sixel" | "blocks";
}

type Shown =
  | { kind: "none" }
  | { kind: "image"; title: string }
  | {
      kind: "text";
      document: Document;
      title: string;
      /** Undefined once the file is gone, so that is reported once. */
      stamp?: string;
    };

async function fileStamp(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.mtimeMs}:${info.size}`;
}

export class ScouterApp {
  private readonly tree = new FileTree();
  /** Only one read at a time, so their results cannot interleave. */
  private loading?: "open" | "diff";
  /** Lets a diff read the user cancelled be ignored when git finally answers. */
  private diffToken = 0;
  private readonly browserPanel: BoxRenderable;
  private readonly browser: FileExplorer;
  private readonly viewerPanel: BoxRenderable;
  private readonly viewerHeader: PaneHeader;
  private readonly sidebar: SidebarResizer;
  private readonly viewer: ScrollBoxRenderable;
  private readonly codeView: CodeView;
  private readonly imageView: ImageView;
  private readonly footer: Footer;
  private welcome: BoxRenderable;
  private readonly layout: BoxRenderable;
  private help: BoxRenderable;
  private readonly diffScreen: DiffScreen;
  private readonly finder: FileFinder;
  private readonly search: DocumentSearch;
  private readonly preview: HitPreview;
  private previewTitle?: string;
  private readonly watcher: BrowseWatcher;
  private readonly systemTheme: SystemThemeWatcher;
  private readonly marks = new GitMarks();
  private mode: "browse" | "diff" = "browse";
  private paneBeforeDiff: "list" | "reader" = "list";
  /** Borders are rewritten only when focus actually moves, so nothing flickers. */
  private focusPane?: "list" | "reader";
  private shown: Shown = { kind: "none" };
  private wrap = false;

  private readonly letterCommands = new Map<string, () => void>([
    ["w", () => this.toggleWrap()],
    ["m", () => this.toggleMarkdownSource()],
    ["d", () => void this.toggleDiff()],
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
    this.sidebar = new SidebarResizer(renderer, this.browserPanel);
    this.viewer = new ScrollBoxRenderable(renderer, {
      id: "viewer",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: true,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: scrollbarStyle(),
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
    this.preview = new HitPreview(renderer, this.codeView.syntax);
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
      text: () => (this.shown.kind === "text" ? this.shown.document.text : undefined),
      topLine: () => Math.floor(this.viewer.scrollTop),
      scrollToLine: (line) => this.scrollToLine(line),
      highlight: (query) => this.codeView.setHighlight(query),
    });
    this.watcher = new BrowseWatcher({
      pollMs: options.browsePollMs ?? BROWSE_POLL_MS,
      isDestroyed: () => renderer.isDestroyed,
      refresh: () => this.refreshBrowse(),
    });
    this.browserPanel.add(this.finder.bar);
    this.browserPanel.add(this.browser);
    this.browserPanel.add(this.diffScreen.list);
    this.codeView.mount(this.viewer);
    this.imageView.mount(this.viewer);
    this.viewerPanel.add(this.viewerHeader.root);
    this.viewerPanel.add(this.welcome);
    this.viewerPanel.add(this.viewer);
    this.viewerPanel.add(this.preview.root);
    this.viewerPanel.add(this.diffScreen.body);
    panes.add(this.browserPanel);
    panes.add(this.sidebar.handle);
    panes.add(this.viewerPanel);
    layout.add(panes);
    layout.add(this.footer.root);
    this.help = createHelp(renderer, theme.fallbackBackground);
    this.help.visible = false;
    // Last in the layout, so it draws over the panes it covers.
    layout.add(this.help);
    renderer.root.add(layout);
    renderer.keyInput.on("keypress", this.onKeyPress);
    renderer.on("focused_renderable", this.updateFocus);
    renderer.once("destroy", this.dispose);
    this.sidebar.fit();
    this.focusBrowser();
    this.systemTheme = new SystemThemeWatcher(renderer, (system) => this.applyTheme(system));
    this.systemTheme.start();
    this.watcher.start();
  }

  private get document(): Document | undefined {
    return this.shown.kind === "text" ? this.shown.document : undefined;
  }

  private get hasDocument(): boolean {
    return this.shown.kind !== "none";
  }

  private get isImage(): boolean {
    return this.shown.kind === "image";
  }

  private applyTheme({ mode, background }: SystemTheme): void {
    if (this.renderer.isDestroyed) return;
    setThemeMode(mode);
    const tint = tintedBackground(background);
    this.browserPanel.backgroundColor = tint;
    this.footer.setBackground(tint);
    this.diffScreen.setTint(tint);
    const replacedStyle = this.codeView.restyle();
    this.diffScreen.restyle();
    this.preview.restyle();
    this.browser.repaint((entry) => this.styleOf(entry));
    this.finder.restyle();
    this.viewer.scrollbarOptions = scrollbarStyle();
    this.viewerHeader.restyle();
    this.footer.restyle();
    this.rebuildWelcome();
    this.rebuildHelp(tint);
    // Both borders are written once, so the one that is lit follows the new accent.
    this.focusPane = undefined;
    this.updateFocus();
    replacedStyle.destroy();
    this.renderer.requestRender();
  }

  /** The welcome screen and the key list build their text in the colours of the moment, so they are built again. */
  private rebuildWelcome(): void {
    const visible = this.welcome.visible;
    this.welcome.destroyRecursively();
    this.welcome = createWelcome(this.renderer);
    this.welcome.visible = visible;
    // Second in the pane, after the header, where it was first built.
    this.viewerPanel.add(this.welcome, 1);
  }

  private rebuildHelp(background: string): void {
    const visible = this.help.visible;
    this.help.destroyRecursively();
    this.help = createHelp(this.renderer, background);
    this.help.visible = visible;
    this.layout.add(this.help);
  }

  async open(path: string): Promise<void> {
    if (this.renderer.isDestroyed) return;
    await this.runLoading(
      async () => {
        this.viewerHeader.setNotice(undefined);
        this.footer.setMessage("Loading…");
        await this.openPath(resolve(path));
      },
      // Nothing opened, so the click that led here belongs to the sidebar.
      () => this.focusBrowser(),
    );
    void this.watcher.refresh();
  }

  /** Runs `task` as the one read in progress; a second one is refused. */
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

  /** False when the app was closed meanwhile. */
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

  private styleOf(entry: TreeEntry): RowStyle {
    const path = treeRelative(this.tree.rootPath ?? entry.path, entry.path);
    return { ...this.marks.styleOf(path), ignored: this.marks.isIgnored(path) };
  }

  private showImage(file: ImageFile, details: ImageDetails): void {
    this.codeView.hide();
    this.search.clear();
    this.shown = { kind: "image", title: displayLabel(basename(file.path)) };
    this.revealReader();
    this.imageView.show(file);
    this.footer.setLocation(file.path);
    this.footer.setDocument({ lines: 0, language: details.format, image: details });
    this.finishShowing();
  }

  private showDocument(document: Document, stamp: string): void {
    this.imageView.hide();
    const language = this.codeView.show(document);
    this.shown = { kind: "text", document, stamp, title: displayLabel(basename(document.path)) };
    this.revealReader();
    this.footer.setLocation(document.path);
    this.setDocumentInfo(document, language);
    this.search.refresh();
    this.finishShowing();
  }

  private revealReader(): void {
    this.welcome.visible = false;
    this.viewer.visible = this.mode === "browse";
    this.viewer.scrollTo({ x: 0, y: 0 });
  }

  private finishShowing(): void {
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

  private toggleMarkdownSource(): void {
    const document = this.document;
    if (!document || !this.codeView.isMarkdown || this.mode !== "browse") return;
    this.codeView.toggleSource();
    this.viewer.scrollTo({ x: 0, y: 0 });
    this.setDocumentInfo(document, languageFor(document.path));
    this.updateViewerBadges();
    this.updatePosition();
    this.renderer.requestRender();
  }

  private get list(): ScrollBoxRenderable {
    return this.mode === "diff" ? this.diffScreen.list : this.browser;
  }

  private get reader(): ScrollBoxRenderable {
    return this.mode === "diff" ? this.diffScreen.scroller : this.viewer;
  }

  private get readerReady(): boolean {
    return this.mode === "diff" ? this.diffScreen.showingDiff : this.hasDocument;
  }

  private updateChrome(): void {
    if (this.previewTitle !== undefined) {
      this.viewerHeader.setTitle(this.previewTitle);
      this.viewerHeader.setBadges([{ text: "preview", kind: "pill" }]);
      return;
    }
    if (this.mode === "browse") {
      this.viewerHeader.setTitle(this.shown.kind === "none" ? "Reader" : this.shown.title);
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
    void this.watcher.refresh();
  }

  /** The diff screen does its own polling, so this pauses there. */
  private async refreshBrowse(): Promise<void> {
    const root = this.tree.rootPath;
    if (this.renderer.isDestroyed || this.mode !== "browse" || this.loading === "open" || !root) return;
    try {
      const folders = await Promise.all(this.tree.expandedPaths().map((path) => this.tree.refresh(path)));
      const marks = await this.marks.refresh(root);
      await this.refreshDocument();
      if (this.renderer.isDestroyed || this.mode !== "browse") return;
      // While the find prompt is open its matches are on screen, so the tree waits until the prompt closes.
      if ((marks || folders.some(Boolean)) && !this.finder.active) {
        this.renderTree(this.browser.selected()?.path ?? root);
      }
    } catch {
      // A failed read, such as git being busy, keeps what is on screen; the next refresh tries again.
    }
  }

  private async refreshDocument(): Promise<void> {
    const shown = this.shown;
    if (shown.kind !== "text" || shown.stamp === undefined) return;
    const path = shown.document.path;
    let stamp: string;
    try {
      stamp = await fileStamp(path);
    } catch {
      shown.stamp = undefined;
      this.showError(`${displayLabel(basename(path))} is no longer on disk.`);
      return;
    }
    if (stamp === shown.stamp) return;
    const next = await readDocument(path);
    if (this.renderer.isDestroyed || this.shown !== shown) return;
    shown.stamp = stamp;
    if (next.text === shown.document.text && next.truncated === shown.document.truncated) return;
    shown.document = next;
    this.codeView.show(next);
    this.setDocumentInfo(next, languageFor(path));
    this.search.refresh();
    this.updateChrome();
    this.updatePosition();
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
    void this.watcher.refresh();
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
    if (this.mode === "browse" && this.isImage) badges.push({ text: "image", kind: "quiet" });
    if (this.mode === "browse" && this.document?.truncated) badges.push({ text: "first 1 MiB", kind: "pill" });
    if (this.wrap && !rendered && !this.isImage) badges.push({ text: "wrap", kind: "pill" });
    this.viewerHeader.setBadges(badges);
  }

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
    const pane = this.reader.focused ? "reader" : "list";
    if (pane !== this.focusPane) {
      this.focusPane = pane;
      this.browserPanel.borderColor = pane === "list" ? theme.accent : transparent;
      this.viewerPanel.borderColor = pane === "reader" ? theme.accent : transparent;
    }
    this.viewerHeader.setFocused(this.reader.focused);
    this.footer.setFocus(this.reader.focused ? "reader" : "files");
  };

  private readonly onExplorerActivate = (): void => {
    if (this.renderer.isDestroyed) return;
    if (this.finder.active) {
      this.finder.pick();
      return;
    }
    // Opening a file ends with the reader focused, so focusing the sidebar on the way would flash both pane
    // borders (indigo on the sidebar, then on the reader). Only a collapse, which stays in the sidebar, needs
    // focus now; expanding a folder takes it when its contents have loaded.
    if (this.browser.selected()?.state === "expanded") this.focusBrowser();
    this.openSelected("toggle");
  };

  private readonly onKeyPress = (key: KeyEvent): void => {
    this.viewerHeader.setNotice(undefined);
    // An open prompt takes every typed key first, so typing "q" or "d" searches instead of quitting or leaving.
    if (this.finder.handleKey(key) || this.search.handleKey(key)) return;
    if (isQuit(key)) {
      key.preventDefault();
      this.renderer.destroy();
      return;
    }
    if (this.help.visible) {
      key.preventDefault();
      this.help.visible = false;
      return;
    }
    const command = this.commandFor(key);
    if (command) {
      key.preventDefault();
      command();
      return;
    }
    if (this.mode === "diff" && this.handleDiffKey(key)) return;
    if (!this.list.focused) this.handleViewerKey(key);
    else if (this.mode === "diff") this.handleChangesKey(key);
    else this.handleBrowserKey(key);
  };

  private commandFor(key: KeyEvent): (() => void) | undefined {
    if (key.name === "tab") return () => this.switchPane();
    if (key.name === "escape") return () => this.escape();
    if (key.sequence === "?" && isPlain(key)) return () => void (this.help.visible = true);
    if (key.ctrl && !key.meta && (key.name === "left" || key.name === "right")) {
      return () => this.sidebar.nudge(key.name === "left" ? "left" : "right");
    }
    return isPlain(key) && !key.shift ? this.letterCommands.get(key.name) : undefined;
  }

  private escape(): void {
    if (!this.list.focused && this.search.dismiss()) return;
    this.focusBrowser();
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
    else if (key.name === "r") void this.loadDiff(() => this.onDiffChange());
    else if (key.name === "o") void this.openChanged();
    else if (key.name === "n" || key.sequence === "]") this.diffScreen.jumpHunk(1);
    else if (key.name === "p" || key.sequence === "[") this.diffScreen.jumpHunk(-1);
    else return false;
    key.preventDefault();
    return true;
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

  private handleViewerKey(key: KeyEvent): void {
    if (key.meta) return;
    if (scrollByKey(this.reader, key) || key.ctrl) return;
    if (this.mode === "browse" && this.handleSearchKeyInReader(key)) return;
    const edge = boundaryOf(key);
    if (!edge) return;
    key.preventDefault();
    this.reader.scrollTo(edge === "end" ? Infinity : 0);
  }

  private handleSearchKeyInReader(key: KeyEvent): boolean {
    if (key.name === "/") this.startSearch();
    else if (key.name === "n" || key.name === "p") this.search.step(key.name === "n" ? 1 : -1);
    else return false;
    key.preventDefault();
    return true;
  }

  private startFind(): void {
    if (!this.tree.rootPath || this.finder.active) return;
    if (this.loading) return this.refuseWhileLoading();
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
    const match = entry?.match;
    if (!entry || !match) {
      this.endPreview();
      return;
    }
    if (!(await this.preview.show(entry.path, match.line, query)) || this.renderer.isDestroyed) return;
    this.viewer.visible = false;
    this.welcome.visible = false;
    this.previewTitle = displayLabel(basename(entry.path));
    this.updateChrome();
  }

  private endPreview(): void {
    if (!this.preview.active) {
      this.preview.hide();
      return;
    }
    this.preview.hide();
    this.previewTitle = undefined;
    this.welcome.visible = !this.hasDocument;
    this.viewer.visible = this.hasDocument;
    this.updateChrome();
  }

  /** Rendered Markdown has no lines to find, so it asks for source. */
  private startSearch(): void {
    if (!this.document) return;
    if (this.codeView.previewing) {
      this.footer.setMessage("Press m to search this Markdown file's source.");
      return;
    }
    this.search.start();
  }

  private scrollToLine(line: number): void {
    this.viewer.scrollTo({ x: 0, y: Math.max(0, line - Math.floor(this.viewer.viewport.height / 3)) });
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

  /** `line` is counted from one. Rendered Markdown has no source lines to scroll to, so it is shown as source. */
  private async openAt(path: string, line: number, query?: string): Promise<void> {
    // Set before the file loads, so its first highlight already marks the words: changing them once that is under
    // way restarts it and the reader loses its place.
    if (query) this.codeView.setHighlight(query);
    await this.open(path);
    if (this.renderer.isDestroyed) return;
    if (this.document?.path !== path) {
      this.search.syncHighlight();
      return;
    }
    if (this.codeView.previewing) this.toggleMarkdownSource();
    this.scrollToLine(line - 1);
    if (query) this.search.seed(query, line - 1);
  }

  private workerClosed = Promise.resolve();

  private readonly dispose = (): void => {
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.off("focused_renderable", this.updateFocus);
    this.sidebar.dispose();
    this.systemTheme.stop();
    // Stopping waits for a refresh in progress, so the repository it opened is closed after it.
    this.workerClosed = Promise.all([
      this.codeView.destroy(),
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
