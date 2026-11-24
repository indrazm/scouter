import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Selection,
} from "@opentui/core";
import { stat } from "node:fs/promises";
import { basename, dirname, posix, resolve } from "node:path";
import { BrowseWatcher } from "./browse-watcher";
import { copiedSummary, copyToClipboard, type ClipboardWriter } from "./clipboard";
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
import { JumpHistory, type Jump } from "./jump-history";
import { createHelp } from "./help";
import { SidebarResizer } from "./sidebar-resizer";
import { scrollbarStyle, styled } from "./styled";
import { SystemThemeWatcher, type SystemTheme } from "./system-theme";
import { setThemeMode, theme, tintedBackground } from "./theme";
import { createWelcome } from "./welcome";
import {
  BinaryFileError,
  describeError,
  displayLabel,
  formatBytes,
  isImagePath,
  readDocument,
  readImage,
  type Document,
  type ImageFile,
} from "./files";
import { ImageView, describeImage, type ImageDetails } from "./image-view";
import { GitError } from "./git";

const DIFF_POLL_MS = 2000;
const MAX_COUNT = 99_999_999;
const BROWSE_POLL_MS = 2000;

export interface ScouterAppOptions {
  diffPollMs?: number;
  browsePollMs?: number;
  imageProtocol?: "auto" | "kitty" | "sixel" | "blocks";
  copy?: ClipboardWriter;
}

type Shown =
  | { kind: "none" }
  | { kind: "image"; title: string; path: string }
  | { kind: "binary"; title: string; path: string; size: number }
  | {
      kind: "text";
      document: Document;
      title: string;
      stamp?: string;
    };

async function fileStamp(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.mtimeMs}:${info.size}`;
}

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
  private readonly viewer: ScrollBoxRenderable;
  private readonly codeView: CodeView;
  private readonly imageView: ImageView;
  private readonly footer: Footer;
  private welcome: BoxRenderable;
  private readonly binaryView: BoxRenderable;
  private readonly binaryTitle: TextRenderable;
  private readonly binaryMeta: TextRenderable;
  private readonly binaryHint: TextRenderable;
  private readonly layout: BoxRenderable;
  private help: BoxRenderable;
  private readonly diffScreen: DiffScreen;
  private readonly finder: FileFinder;
  private readonly search: DocumentSearch;
  private readonly preview: HitPreview;
  private previewPath?: string;
  private readonly watcher: BrowseWatcher;
  private readonly systemTheme: SystemThemeWatcher;
  private readonly marks = new GitMarks();
  private readonly jumps = new JumpHistory();
  private mode: "browse" | "diff" = "browse";
  private paneBeforeDiff: "list" | "reader" = "list";
  private focusPane?: "list" | "reader";
  private shown: Shown = { kind: "none" };
  private wrap = false;
  private zPending = false;
  private copyNoticeTimer?: ReturnType<typeof setTimeout>;

  private count = 0;
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
    this.binaryView = new BoxRenderable(renderer, {
      id: "binary-view",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    });
    this.binaryTitle = new TextRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.binaryMeta = new TextRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      marginTop: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.binaryHint = new TextRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      marginTop: 1,
      wrapMode: "none",
      selectable: false,
    });
    this.binaryView.add(this.binaryTitle);
    this.binaryView.add(this.binaryMeta);
    this.binaryView.add(this.binaryHint);
    this.binaryView.visible = false;
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
      highlightLine: (line) => this.codeView.setActiveLine(line),
    });
    this.watcher = new BrowseWatcher({
      pollMs: options.browsePollMs ?? BROWSE_POLL_MS,
      isDestroyed: () => renderer.isDestroyed,
      refresh: () => this.refreshBrowse(),
    });
    this.browserPanel.add(this.browserHeader.root);
    this.browserPanel.add(this.finder.bar);
    this.browserPanel.add(this.browser);
    this.browserPanel.add(this.diffScreen.list);
    this.codeView.mount(this.viewer);
    this.imageView.mount(this.viewer);
    this.viewerPanel.add(this.viewerHeader.root);
    this.viewerPanel.add(this.welcome);
    this.viewerPanel.add(this.binaryView);
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
    layout.add(this.help);
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

  private get document(): Document | undefined {
    return this.shown.kind === "text" ? this.shown.document : undefined;
  }

  private get hasDocument(): boolean {
    return this.shown.kind === "text" || this.shown.kind === "image";
  }

  private get isImage(): boolean {
    return this.shown.kind === "image";
  }

  private get isBinary(): boolean {
    return this.shown.kind === "binary";
  }

  private applyTheme({ mode, background }: SystemTheme): void {
    if (this.renderer.isDestroyed) return;

    setThemeMode(mode);
    const tint = tintedBackground(background);
    this.footer.setBackground(tint);
    this.diffScreen.setTint(tint);
    const replacedStyle = this.codeView.restyle();
    this.diffScreen.restyle();
    this.preview.restyle();
    this.browser.repaint((entry) => this.styleOf(entry));
    this.finder.restyle();
    this.viewer.scrollbarOptions = scrollbarStyle();
    this.browserHeader.restyle();
    this.viewerHeader.restyle();
    this.footer.restyle();
    this.rebuildWelcome();
    this.paintBinaryView();
    this.rebuildHelp(tint);
    this.focusPane = undefined;
    this.updateFocus();
    replacedStyle.destroy();
    this.renderer.requestRender();
  }

  private rebuildWelcome(): void {
    const visible = this.welcome.visible;
    this.welcome.destroyRecursively();
    this.welcome = createWelcome(this.renderer);
    this.welcome.visible = visible;
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
    await this.show(path, () => this.jumps.leave(this.here()));
  }

  private async show(path: string, beforeOpen?: () => void, top = 0): Promise<void> {
    if (this.renderer.isDestroyed) return;

    await this.runLoading(
      async () => {
        this.viewerHeader.setNotice(undefined);
        this.footer.setMessage("Loading…");
        beforeOpen?.();
        await this.openPath(resolve(path));

        if (top > 0 && this.document && !this.renderer.isDestroyed) this.scrollToTop(top);
      },
      () => this.focusBrowser(),
    );
    void this.watcher.refresh();
  }

  private here(): Jump | undefined {
    if (this.shown.kind === "none") return undefined;

    if (this.shown.kind === "image" || this.shown.kind === "binary") return { path: this.shown.path, top: 0 };

    return { path: this.shown.document.path, top: Math.floor(this.viewer.scrollTop) };
  }

  private async jump(direction: "back" | "forward"): Promise<void> {
    if (this.renderer.isDestroyed) return;

    if (this.loading) return this.refuseWhileLoading();

    const here = this.here();
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
    this.viewer.scrollTo({ x: 0, y: top });
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

    const stamp = await fileStamp(path);
    try {
      const document = await readDocument(path);

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
    this.updateSidebarHeader();
  }

  private updateSidebarHeader(): void {
    this.browserHeader.root.visible = !this.finder.active;

    if (this.mode === "diff") {
      const state = this.diffScreen.state();
      const count = `${state.files}${state.truncated ? "+" : ""}`;
      this.browserHeader.setTitle("Changes");
      this.browserHeader.setBadges([{ text: count, kind: "quiet" }]);
      return;
    }

    const root = this.tree.rootPath;
    this.browserHeader.setTitle(root ? displayLabel(basename(root)) : "Files");
    this.browserHeader.setBadges([{ text: "files", kind: "quiet" }]);
  }

  private styleOf(entry: TreeEntry): RowStyle {
    const path = treeRelative(this.tree.rootPath ?? entry.path, entry.path);
    return { ...this.marks.styleOf(path), ignored: this.marks.isIgnored(path) };
  }

  private showImage(file: ImageFile, details: ImageDetails): void {
    this.codeView.hide();
    this.search.clear();
    this.shown = { kind: "image", title: displayLabel(basename(file.path)), path: file.path };
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

  private showBinary(path: string, size: number): void {
    this.codeView.hide();
    this.imageView.hide();
    this.search.clear();
    this.shown = { kind: "binary", title: displayLabel(basename(path)), path, size };
    this.welcome.visible = false;
    this.viewer.visible = false;
    this.binaryView.visible = this.mode === "browse";
    this.paintBinaryView();
    this.footer.setLocation(path);
    this.footer.setDocument({ lines: 0, language: "binary", binary: { size: formatBytes(size) } });
    this.updateChrome();
    this.focusBrowser();
    this.renderer.requestRender();
  }

  private paintBinaryView(): void {
    if (this.shown.kind !== "binary") return;

    this.binaryTitle.content = styled([{ text: "Binary files are not supported.", fg: theme.text, bold: true }]);
    this.binaryMeta.content = styled([
      { text: this.shown.title, fg: theme.accentSoft },
      { text: "  ·  ", fg: theme.ignored },
      { text: formatBytes(this.shown.size), fg: theme.muted },
    ]);
    this.binaryHint.content = styled([{ text: "Scouter only displays UTF-8 text and images.", fg: theme.dim }]);
  }

  private revealReader(): void {
    this.welcome.visible = false;
    this.binaryView.visible = false;
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
    const info = {
      lines: document.lineCount,
      language: language ?? "plain text",
      rendered: this.codeView.isMarkdown ? this.codeView.previewing : undefined,
      truncated: document.truncated ? true : undefined,
    };
    this.footer.setDocument(info);
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

  private titleParts(path: string): { title: string; parent?: string } {
    const title = displayLabel(basename(path));
    const root = this.tree.rootPath;

    if (!root) return { title };

    const relative = treeRelative(root, path);

    if (!relative || relative.startsWith("../")) return { title };

    const folder = posix.dirname(relative);
    return folder === "." ? { title } : { title, parent: `${displayLabel(folder)}/` };
  }

  private updateChrome(): void {
    this.updateSidebarHeader();

    if (this.previewPath !== undefined) {
      const { title, parent } = this.titleParts(this.previewPath);
      this.viewerHeader.setTitle(title, parent);
      this.viewerHeader.setBadges([{ text: "preview", kind: "pill" }]);
      return;
    }

    if (this.mode === "browse") {
      if (this.shown.kind === "none") {
        this.viewerHeader.setTitle("Reader");
      } else {
        const path = this.shown.kind === "text" ? this.shown.document.path : this.shown.path;
        const { title, parent } = this.titleParts(path);
        this.viewerHeader.setTitle(title, parent);
      }

      this.updateViewerBadges();
      return;
    }

    const state = this.diffScreen.state();

    if (state.selected) {
      const folder = posix.dirname(state.selected.path);
      this.viewerHeader.setTitle(
        displayLabel(basename(state.selected.path)),
        folder === "." ? undefined : `${displayLabel(folder)}/`,
      );
    } else {
      this.viewerHeader.setTitle("Changes");
    }

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
    this.binaryView.visible = false;
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
    this.welcome.visible = this.shown.kind === "none";
    this.binaryView.visible = this.isBinary;
    this.viewer.visible = this.hasDocument;
    this.footer.setMode("browse");
    this.updateChrome();
    this.updatePosition();

    if (this.paneBeforeDiff === "reader" && this.hasDocument) this.viewer.focus();
    else this.browser.focus();

    this.updateFocus();
    void this.diffScreen.close();
    void this.watcher.refresh();
  }

  private async refreshBrowse(): Promise<void> {
    const root = this.tree.rootPath;

    if (this.renderer.isDestroyed || this.mode !== "browse" || this.loading === "open" || !root) return;

    try {
      const folders = await Promise.all(this.tree.expandedPaths().map((path) => this.tree.refresh(path)));
      const marks = await this.marks.refresh(root);
      await this.refreshDocument();

      if (this.renderer.isDestroyed || this.mode !== "browse") return;

      if ((marks || folders.some(Boolean)) && !this.finder.active) {
        this.renderTree(this.browser.selected()?.path ?? root);
      }
    } catch {}
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

      if (state.expandedContext) badges.push({ text: "wide context", kind: "pill" });
    } else {
      badges.push({ text: "read-only", kind: "quiet" });
    }

    const rendered = this.mode === "browse" && this.hasDocument && this.codeView.previewing;

    if (rendered) badges.push({ text: "rendered", kind: "quiet" });

    if (this.mode === "browse" && this.isImage) badges.push({ text: "image", kind: "quiet" });

    if (this.mode === "browse" && this.isBinary) badges.push({ text: "binary", kind: "quiet" });

    if (this.mode === "browse" && this.document?.truncated) badges.push({ text: "first 1 MiB", kind: "pill" });

    if (this.wrap && !rendered && !this.isImage && !this.isBinary) badges.push({ text: "wrap", kind: "pill" });

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

    const afterZ = this.zPending;
    this.zPending = false;

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

    if (this.absorbCount(key)) return;

    const count = this.takeCount();
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

    if (key.sequence === "?" && isPlain(key)) return () => void (this.help.visible = true);

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

    if (this.shown.kind === "text") return this.shown.document.path;

    if (this.shown.kind === "image") return this.shown.path;

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

  private absorbCount(key: KeyEvent): boolean {
    const digit = /^[0-9]$/.test(key.sequence) && isPlain(key) ? Number(key.sequence) : undefined;

    if (digit === undefined || this.list.focused || this.mode !== "browse" || !this.readerReady) return false;

    if (this.codeView.previewing || (!this.count && !digit)) return false;

    key.preventDefault();
    this.count = Math.min(this.count * 10 + digit, MAX_COUNT);
    this.footer.setPending(this.count);
    return true;
  }

  private takeCount(): number {
    const count = this.count;

    if (count) {
      this.count = 0;
      this.footer.setPending(undefined);
    }

    return count;
  }

  private handleViewerKey(key: KeyEvent, count: number, afterZ: boolean): void {
    if (key.meta) return;

    if (scrollByKey(this.reader, key) || key.ctrl) return;

    if (this.mode === "browse" && this.handleSearchKeyInReader(key)) return;

    if (this.mode === "browse" && this.handleMotionInReader(key, afterZ)) return;

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

  private handleMotionInReader(key: KeyEvent, afterZ: boolean): boolean {
    if (!isPlain(key)) return false;

    if (afterZ) {
      if (key.name !== "z" || key.shift) return false;

      key.preventDefault();
      this.centreReader();
      return true;
    }

    if (key.name === "z" && !key.shift) {
      key.preventDefault();
      this.zPending = true;
      return true;
    }

    if (key.sequence !== "{" && key.sequence !== "}") return false;

    key.preventDefault();
    this.moveByParagraph(key.sequence === "}" ? 1 : -1);
    return true;
  }

  private moveByParagraph(direction: 1 | -1): void {
    if (!this.document) return;

    if (this.codeView.previewing) {
      this.footer.setMessage("Press m to move by paragraph in this Markdown file's source.");
      return;
    }

    const lines = this.document.text.split("\n");
    const top = Math.floor(this.viewer.scrollTop);
    const target =
      direction > 0
        ? lines.findIndex((line, index) => index > top && line.trim() === "")
        : lines.findLastIndex((line, index) => index < top && line.trim() === "");
    this.viewer.scrollTo(target < 0 ? (direction > 0 ? Infinity : 0) : target);
    this.updatePosition();
  }

  private centreReader(): void {
    const match = this.codeView.previewing ? undefined : this.search.currentLine();
    this.scrollToLine(match ?? Math.floor(this.viewer.scrollTop + this.viewer.viewport.height / 2));
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
    const match = entry?.match;

    if (!entry || !match) {
      this.endPreview();
      return;
    }

    if (!(await this.preview.show(entry.path, match.line, query)) || this.renderer.isDestroyed) return;

    this.viewer.visible = false;
    this.welcome.visible = false;
    this.binaryView.visible = false;
    this.previewPath = entry.path;
    this.updateChrome();
  }

  private endPreview(): void {
    if (!this.preview.active) {
      this.preview.hide();
      return;
    }

    this.preview.hide();
    this.previewPath = undefined;
    this.welcome.visible = this.shown.kind === "none";
    this.binaryView.visible = this.isBinary;
    this.viewer.visible = this.hasDocument;
    this.updateChrome();
  }

  private startSearch(): void {
    if (!this.document) return;

    if (this.codeView.previewing) {
      this.footer.setMessage("Press m to search this Markdown file's source.");
      return;
    }

    this.search.start();
  }

  private scrollToLine(line: number): void {
    this.viewer.scrollTo({ x: 0, y: Math.max(0, line - Math.floor(this.viewer.viewport.height / 2)) });
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
    clearTimeout(this.copyNoticeTimer);
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.off("focused_renderable", this.updateFocus);
    this.renderer.off("selection", this.onSelection);
    this.sidebar.dispose();
    this.systemTheme.stop();
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
