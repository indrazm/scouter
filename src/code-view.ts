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
import { extraLanguages, registerGrammars } from "./grammars";
import { MATCH_GROUP, PLAIN_FILETYPE, markMatches, matchStyle } from "./match-style";
import { theme } from "./theme";

const supportedLanguages = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "markdown",
  "markdown_inline",
  "zig",
  ...extraLanguages,
]);

/** The bundled grammar for a file, if there is one; anything else is shown as plain text. */
export function languageFor(path: string): string | undefined {
  const detected = pathToFiletype(path);
  return detected && supportedLanguages.has(detected) ? detected : undefined;
}

type StyleMap = Parameters<typeof SyntaxStyle.fromStyles>[0];

function syntaxStyles(): StyleMap {
  const { syntax, text } = theme;
  return {
    default: { fg: text },
    keyword: { fg: syntax.keyword, bold: true },
    string: { fg: syntax.string },
    comment: { fg: syntax.comment, italic: true },
    number: { fg: syntax.constant },
    boolean: { fg: syntax.constant },
    constant: { fg: syntax.constant },
    function: { fg: syntax.function },
    type: { fg: syntax.constant },
    constructor: { fg: syntax.constant },
    variable: { fg: text },
    property: { fg: syntax.function },
    operator: { fg: syntax.keyword },
    punctuation: { fg: syntax.punctuation },
    tag: { fg: syntax.keyword },
    attribute: { fg: syntax.function },
    escape: { fg: syntax.constant },
    label: { fg: syntax.constant },
    namespace: { fg: syntax.constant },
    "markup.heading": { fg: syntax.function, bold: true },
    ...Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`markup.heading.${index + 1}`, { fg: syntax.function, bold: true }]),
    ),
    "markup.bold": { bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: syntax.string },
    "markup.link": { fg: syntax.function, underline: true },
    [MATCH_GROUP]: matchStyle(),
  };
}

export class CodeView {
  /** Shared with the diff view so both highlight with the same colours and one parser worker. */
  readonly syntax: { style: SyntaxStyle; readonly client: TreeSitterClient };
  private readonly client: TreeSitterClient;
  private style: SyntaxStyle;
  private readonly code: CodeRenderable;
  private readonly lines: LineNumberRenderable;
  private readonly preview: MarkdownRenderable;
  private viewer?: ScrollBoxRenderable;
  private closing?: Promise<void>;
  private wrap = false;
  private document?: Document;
  /** Markdown shows rendered unless the reader asked for its source. */
  private source = false;
  private needle?: string;

  /** `onLayout` fires when the document's rendered size changes: a new file, toggled wrapping, a resize. */
  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: { onLayout?: () => void } = {},
  ) {
    this.style = SyntaxStyle.fromStyles(syntaxStyles(), renderer.nativeScene);
    this.client = new TreeSitterClient({
      dataPath: join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "scouter"),
    });
    registerGrammars(this.client);
    this.syntax = { style: this.style, client: this.client };
    this.code = new CodeRenderable(renderer, {
      id: "document",
      content: "",
      syntaxStyle: this.style,
      treeSitterClient: this.client,
      fg: theme.text,
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
      fg: theme.muted,
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
      fg: theme.text,
      width: "100%",
      flexShrink: 0,
      paddingLeft: 2,
      paddingRight: 2,
      onSizeChange: () => this.options.onLayout?.(),
    });
    this.preview.visible = false;
  }

  /** Returns the style that was replaced; destroy it once the diff and the preview have moved to `syntax.style`. */
  restyle(): SyntaxStyle {
    const previous = this.style;
    this.style = SyntaxStyle.fromStyles(syntaxStyles(), this.renderer.nativeScene);
    this.syntax.style = this.style;
    this.code.syntaxStyle = this.style;
    this.preview.syntaxStyle = this.style;
    this.code.fg = theme.text;
    this.preview.fg = theme.text;
    this.lines.fg = theme.muted;
    return previous;
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

  /** Rendered Markdown is never marked. */
  setHighlight(query: string | undefined): void {
    if (this.needle === query) return;
    this.needle = query;
    this.present();
  }

  get isMarkdown(): boolean {
    return this.document !== undefined && languageFor(this.document.path) === "markdown";
  }

  get previewing(): boolean {
    return this.isMarkdown && !this.source && (this.document?.lineCount ?? 0) > 0;
  }

  /** Returns whether the file is now rendered. */
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
    this.code.filetype =
      document.lineCount === 0 ? undefined : (language ?? (this.needle ? PLAIN_FILETYPE : undefined));
    this.code.onHighlight = markMatches(this.needle);
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
