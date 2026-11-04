import {
  CodeRenderable,
  LineNumberRenderable,
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
  private viewer?: ScrollBoxRenderable;
  private closing?: Promise<void>;

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
  }

  mount(viewer: ScrollBoxRenderable): void {
    this.viewer = viewer;
    viewer.add(this.lines);
  }

  /** Wrapped text must be laid out against the viewport width, so the scroll content stops growing with the text. */
  setWrap(wrap: boolean): void {
    this.code.wrapMode = wrap ? "word" : "none";
    this.code.flexShrink = wrap ? 1 : 0;
    this.lines.flexShrink = wrap ? 1 : 0;
    this.lines.width = wrap ? "100%" : "auto";
    if (this.viewer)
      this.viewer.contentOptions = wrap
        ? { flexDirection: "column", width: "100%" }
        : { flexDirection: "column", width: "auto" };
    this.viewer?.scrollTo({ x: 0, y: this.viewer.scrollTop });
  }

  show(document: Document): string | undefined {
    const language = languageFor(document.path);
    this.code.filetype = document.lineCount === 0 ? undefined : language;
    this.code.content = document.lineCount === 0 ? "(empty file)" : document.text.replace(/\n$/, "");
    this.lines.showLineNumbers = document.lineCount > 0;
    return language;
  }

  destroy(): Promise<void> {
    if (this.closing) return this.closing;
    this.lines.destroyRecursively();
    this.style.destroy();
    this.closing = this.client.destroy();
    return this.closing;
  }
}
