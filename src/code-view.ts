import {
  CodeRenderable,
  LineNumberRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TreeSitterClient,
  pathToFiletype,
  type CliRenderer,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Document } from "./files";

const supportedLanguages = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "markdown",
  "markdown_inline",
  "zig",
]);

/** The bundled grammar for a file, if there is one; anything else is shown as plain text. */
export function languageFor(path: string): string | undefined {
  const detected = pathToFiletype(path);
  return detected && supportedLanguages.has(detected) ? detected : undefined;
}

export class CodeView {
  /** Shared with the diff view so both highlight with the same colours and one parser worker. */
  readonly syntax: { style: SyntaxStyle; client: TreeSitterClient };
  private readonly client: TreeSitterClient;
  private readonly style: SyntaxStyle;
  private readonly code: CodeRenderable;
  private readonly lines: LineNumberRenderable;
  private readonly preview: MarkdownRenderable;
  private viewer?: ScrollBoxRenderable;
  private closing?: Promise<void>;
  private wrap = false;
  private document?: Document;
  /** Markdown shows rendered unless the reader asked for its source. */
  private source = false;

  /** `onLayout` fires when the document's rendered size changes: a new file, toggled wrapping, a resize. */
  constructor(
    renderer: CliRenderer,
    private readonly options: { onLayout?: () => void } = {},
  ) {
    this.style = SyntaxStyle.fromStyles(
      {
        default: { fg: "#d4d8de" },
        keyword: { fg: "#c792ea", bold: true },
        string: { fg: "#a7c7a1" },
        comment: { fg: "#8b929c", italic: true },
        number: { fg: "#e5b880" },
        boolean: { fg: "#e5b880" },
        constant: { fg: "#e5b880" },
        function: { fg: "#82aaff" },
        type: { fg: "#e5b880" },
        constructor: { fg: "#e5b880" },
        variable: { fg: "#d4d8de" },
        property: { fg: "#82aaff" },
        operator: { fg: "#c792ea" },
        punctuation: { fg: "#b2b9c3" },
        "markup.heading": { fg: "#82aaff", bold: true },
        ...Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [`markup.heading.${index + 1}`, { fg: "#82aaff", bold: true }]),
        ),
        "markup.bold": { bold: true },
        "markup.strong": { bold: true },
        "markup.italic": { italic: true },
        "markup.raw": { fg: "#a7c7a1" },
        "markup.link": { fg: "#82aaff", underline: true },
      },
      renderer.nativeScene,
    );
    this.client = new TreeSitterClient({
      dataPath: join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "scouter"),
    });
    this.syntax = { style: this.style, client: this.client };
    this.code = new CodeRenderable(renderer, {
      id: "document",
      content: "",
      syntaxStyle: this.style,
      treeSitterClient: this.client,
      fg: "#d4d8de",
      wrapMode: "none",
      flexShrink: 0,
      conceal: false,
      drawUnstyledText: true,
    });
    this.lines = new LineNumberRenderable(renderer, {
      id: "document-with-lines",
      target: this.code,
      minWidth: 3,
      paddingRight: 2,
      fg: "#8b929c",
      bg: "transparent",
      flexShrink: 0,
      showLineNumbers: false,
      onSizeChange: () => this.options.onLayout?.(),
    });
    this.preview = new MarkdownRenderable(renderer, {
      id: "document-preview",
      content: "",
      syntaxStyle: this.style,
      treeSitterClient: this.client,
      fg: "#d4d8de",
      width: "100%",
      flexShrink: 0,
      paddingLeft: 2,
      paddingRight: 2,
      onSizeChange: () => this.options.onLayout?.(),
    });
    this.preview.visible = false;
  }

  mount(viewer: ScrollBoxRenderable): void {
    this.viewer = viewer;
    viewer.add(this.lines);
    viewer.add(this.preview);
  }

  /** Wrapped text must be laid out against the viewport width, so the scroll content stops growing with the text. */
  setWrap(wrap: boolean): void {
    this.wrap = wrap;
    this.code.wrapMode = wrap ? "word" : "none";
    this.code.flexShrink = wrap ? 1 : 0;
    this.lines.flexShrink = wrap ? 1 : 0;
    this.lines.width = wrap ? "100%" : "auto";
    this.fitContent();
  }

  /** Rendered Markdown always wraps to the viewport; source and other files scroll sideways unless wrapping. */
  private fitContent(): void {
    if (!this.viewer) return;
    const fill = this.wrap || this.previewing;
    this.viewer.contentOptions = fill
      ? { flexDirection: "column", width: "100%" }
      : { flexDirection: "column", width: "auto" };
    this.viewer.scrollTo({ x: 0, y: this.viewer.scrollTop });
  }

  /** Whether the open file is Markdown, which can be shown rendered or as source. */
  get isMarkdown(): boolean {
    return this.document !== undefined && languageFor(this.document.path) === "markdown";
  }

  /** Whether the reader currently shows rendered Markdown. */
  get previewing(): boolean {
    return this.isMarkdown && !this.source && (this.document?.lineCount ?? 0) > 0;
  }

  /** Switches the open Markdown file between rendered and source. Returns whether it is now rendered. */
  toggleSource(): boolean {
    if (this.isMarkdown) this.source = !this.source;
    this.present();
    return this.previewing;
  }

  show(document: Document): string | undefined {
    const language = languageFor(document.path);
    if (document.path !== this.document?.path) this.source = false;
    this.document = document;
    this.present();
    return language;
  }

  /** Another kind of file is on screen: show neither the source nor the preview. */
  hide(): void {
    this.document = undefined;
    this.preview.visible = false;
    this.lines.visible = false;
  }

  private present(): void {
    const document = this.document;
    if (!document) return;
    const language = languageFor(document.path);
    this.preview.visible = this.previewing;
    this.lines.visible = !this.previewing;
    if (this.previewing) this.preview.content = document.text;
    this.code.filetype = document.lineCount === 0 ? undefined : language;
    this.code.content = document.lineCount === 0 ? "(empty file)" : document.text.replace(/\n$/, "");
    this.lines.showLineNumbers = document.lineCount > 0;
    this.fitContent();
  }

  destroy(): Promise<void> {
    if (this.closing) return this.closing;
    this.lines.destroyRecursively();
    this.preview.destroyRecursively();
    this.style.destroy();
    this.closing = this.client.destroy();
    return this.closing;
  }
}
