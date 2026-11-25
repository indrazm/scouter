import { BoxRenderable, ScrollBoxRenderable, type CliRenderer, type SyntaxStyle } from "@opentui/core";
import { basename } from "node:path";
import { displayLabel, fileStamp, readDocument } from "../core/files";
import type { Document, ImageFile } from "../core/types";
import type { TreeEntry } from "../explorer/types";
import { HitPreview } from "../find/preview";
import { BinaryView } from "../reader/binary-view";
import { CodeView } from "../reader/code-view";
import { ImageView } from "../reader/image-view";
import type { Jump } from "../reader/types";
import { scrollbarStyle } from "../ui/styled";
import type { DocumentInfo } from "../ui/types";
import { createWelcome } from "../ui/welcome";
import type { ReaderPaneOptions, Shown } from "./types";

export class ReaderPane {
  readonly viewer: ScrollBoxRenderable;
  readonly codeView: CodeView;
  private readonly imageView: ImageView;
  private readonly binaryView: BinaryView;
  private readonly preview: HitPreview;
  private welcome: BoxRenderable;
  private panel?: BoxRenderable;
  private current: Shown = { kind: "none" };
  private activePreviewPath?: string;

  constructor(
    private readonly renderer: CliRenderer,
    options: ReaderPaneOptions,
  ) {
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
      verticalScrollbarOptions: { onChange: () => options.onPositionChange() },
      onSizeChange: () => {
        this.imageView.resize();
        options.onPositionChange();
      },
    });
    this.viewer.visible = false;
    this.welcome = createWelcome(renderer);
    this.binaryView = new BinaryView(renderer);
    this.codeView = new CodeView(renderer, { onLayout: () => options.onPositionChange() });
    this.imageView = new ImageView(renderer, options.imageProtocol);
    this.preview = new HitPreview(renderer, this.codeView.syntax);
    this.codeView.mount(this.viewer);
    this.imageView.mount(this.viewer);
  }

  mount(panel: BoxRenderable): void {
    this.panel = panel;
    panel.add(this.welcome);
    panel.add(this.binaryView.root);
    panel.add(this.viewer);
    panel.add(this.preview.root);
  }

  get shown(): Shown {
    return this.current;
  }

  get previewPath(): string | undefined {
    return this.activePreviewPath;
  }

  get document(): Document | undefined {
    return this.current.kind === "text" ? this.current.document : undefined;
  }

  get hasDocument(): boolean {
    return this.current.kind === "text" || this.current.kind === "image";
  }

  get isBinary(): boolean {
    return this.current.kind === "binary";
  }

  get previewing(): boolean {
    return this.codeView.previewing;
  }

  get syntax(): CodeView["syntax"] {
    return this.codeView.syntax;
  }

  here(): Jump | undefined {
    if (this.current.kind === "none") return undefined;

    if (this.current.kind === "image" || this.current.kind === "binary") return { path: this.current.path, top: 0 };

    return { path: this.current.document.path, top: Math.floor(this.viewer.scrollTop) };
  }

  showImage(file: ImageFile, browseMode: boolean): void {
    this.codeView.hide();
    this.current = { kind: "image", title: displayLabel(basename(file.path)), path: file.path };
    this.revealViewer(browseMode);
    this.imageView.show(file);
  }

  showDocument(document: Document, stamp: string, browseMode: boolean): string | undefined {
    this.imageView.hide();
    const language = this.codeView.show(document);
    this.current = { kind: "text", document, stamp, title: displayLabel(basename(document.path)) };
    this.revealViewer(browseMode);
    return language;
  }

  showBinary(path: string, size: number, browseMode: boolean): void {
    this.codeView.hide();
    this.imageView.hide();
    const title = displayLabel(basename(path));
    this.current = { kind: "binary", title, path, size };
    this.welcome.visible = false;
    this.viewer.visible = false;
    this.binaryView.root.visible = browseMode;
    this.binaryView.show(title, size);
  }

  documentInfo(document: Document, language: string | undefined): DocumentInfo {
    return {
      lines: document.lineCount,
      language: language ?? "plain text",
      rendered: this.codeView.isMarkdown ? this.codeView.previewing : undefined,
      truncated: document.truncated ? true : undefined,
    };
  }

  toggleMarkdownSource(): Document | undefined {
    const document = this.document;

    if (!document || !this.codeView.isMarkdown) return undefined;

    this.codeView.toggleSource();
    this.viewer.scrollTo({ x: 0, y: 0 });
    return document;
  }

  setBrowseVisible(visible: boolean): void {
    if (!visible) {
      this.viewer.visible = false;
      this.welcome.visible = false;
      this.binaryView.root.visible = false;
      return;
    }

    this.welcome.visible = this.current.kind === "none";
    this.binaryView.root.visible = this.isBinary;
    this.viewer.visible = this.hasDocument;
  }

  setWrap(wrap: boolean): void {
    this.codeView.setWrap(wrap);
  }

  scrollToTop(top: number): void {
    this.viewer.scrollTo({ x: 0, y: top });
  }

  scrollToLine(line: number): void {
    this.viewer.scrollTo({ x: 0, y: Math.max(0, line - Math.floor(this.viewer.viewport.height / 2)) });
  }

  async refreshDocument(onMissing: (path: string) => void, onChanged: (document: Document) => void): Promise<void> {
    const shown = this.current;

    if (shown.kind !== "text" || shown.stamp === undefined) return;

    const path = shown.document.path;
    let stamp: string;
    try {
      stamp = await fileStamp(path);
    } catch {
      shown.stamp = undefined;
      onMissing(path);
      return;
    }

    if (stamp === shown.stamp) return;

    const next = await readDocument(path);

    if (this.renderer.isDestroyed || this.current !== shown) return;

    shown.stamp = stamp;

    if (next.text === shown.document.text && next.truncated === shown.document.truncated) return;

    shown.document = next;
    this.codeView.show(next);
    onChanged(next);
  }

  async previewHit(entry: TreeEntry | undefined, query: string): Promise<boolean> {
    const match = entry?.match;

    if (!entry || !match) return this.endPreview();

    if (!(await this.preview.show(entry.path, match.line, query)) || this.renderer.isDestroyed) return false;

    this.viewer.visible = false;
    this.welcome.visible = false;
    this.binaryView.root.visible = false;
    this.activePreviewPath = entry.path;
    return true;
  }

  private endPreview(): boolean {
    if (!this.preview.active) {
      this.preview.hide();
      return false;
    }

    this.preview.hide();
    this.activePreviewPath = undefined;
    this.welcome.visible = this.current.kind === "none";
    this.binaryView.root.visible = this.isBinary;
    this.viewer.visible = this.hasDocument;
    return true;
  }

  restyle(): SyntaxStyle {
    const replacedStyle = this.codeView.restyle();
    this.preview.restyle();
    this.viewer.scrollbarOptions = scrollbarStyle();
    this.rebuildWelcome();
    this.binaryView.restyle();
    return replacedStyle;
  }

  destroy(): Promise<void> {
    return this.codeView.destroy();
  }

  private revealViewer(browseMode: boolean): void {
    this.welcome.visible = false;
    this.binaryView.root.visible = false;
    this.binaryView.clear();
    this.viewer.visible = browseMode;
    this.viewer.scrollTo({ x: 0, y: 0 });
  }

  private rebuildWelcome(): void {
    const visible = this.welcome.visible;
    this.welcome.destroyRecursively();
    this.welcome = createWelcome(this.renderer);
    this.welcome.visible = visible;
    this.panel?.add(this.welcome, 1);
  }
}
