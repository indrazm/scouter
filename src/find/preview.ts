import { CodeRenderable, LineNumberRenderable, ScrollBoxRenderable, type CliRenderer } from "@opentui/core";
import type { CodeView } from "../reader/code-view";
import { languageFor } from "../reader/code-view";
import { readDocument, type Document } from "../core/files";
import { PLAIN_FILETYPE, markMatches } from "../reader/match-style";
import { scrollbarStyle } from "../ui/styled";
import { theme } from "../ui/theme";

function targetLine(): { gutter: string; content: string } {
  return { gutter: theme.targetGutter, content: theme.targetBg };
}

export class HitPreview {
  readonly root: ScrollBoxRenderable;
  private readonly code: CodeRenderable;
  private readonly lines: LineNumberRenderable;
  private document?: Document;
  private needle = "";
  private line?: number;
  private request = 0;

  constructor(
    renderer: CliRenderer,
    private readonly syntax: CodeView["syntax"],
  ) {
    this.root = new ScrollBoxRenderable(renderer, {
      id: "preview",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: true,
      scrollY: true,
      contentOptions: { flexDirection: "column", width: "auto" },
      scrollbarOptions: scrollbarStyle(),
      horizontalScrollbarOptions: { visible: false },
      onSizeChange: () => this.scrollToLine(),
    });
    this.code = new CodeRenderable(renderer, {
      content: "",
      syntaxStyle: syntax.style,
      treeSitterClient: syntax.client,
      fg: theme.text,
      selectionBg: theme.selectionBg,
      wrapMode: "none",
      flexShrink: 0,
      conceal: false,
      drawUnstyledText: true,
    });
    this.lines = new LineNumberRenderable(renderer, {
      target: this.code,
      minWidth: 3,
      paddingRight: 2,
      fg: theme.dim,
      bg: "transparent",
      flexShrink: 0,
      onSizeChange: () => this.scrollToLine(),
    });
    this.root.add(this.lines);
    this.root.visible = false;
  }

  restyle(): void {
    this.code.syntaxStyle = this.syntax.style;
    this.code.fg = theme.text;
    this.code.selectionBg = theme.selectionBg;
    this.lines.fg = theme.dim;
    this.root.scrollbarOptions = scrollbarStyle();

    if (this.line !== undefined) this.lines.setLineColors(new Map([[this.line - 1, targetLine()]]));
  }

  get active(): boolean {
    return this.root.visible;
  }

  async show(path: string, line: number, query: string): Promise<boolean> {
    const request = ++this.request;
    let document = this.document?.path === path ? this.document : undefined;

    if (!document) {
      try {
        document = await readDocument(path);
      } catch {
        return false;
      }
    }

    if (request !== this.request) return false;

    if (document !== this.document || query !== this.needle) this.present(document, query);

    this.line = line;
    this.lines.setLineColors(new Map([[line - 1, targetLine()]]));
    this.root.visible = true;
    this.scrollToLine();
    return true;
  }

  hide(): void {
    this.request += 1;
    this.root.visible = false;
  }

  private present(document: Document, query: string): void {
    this.document = document;
    this.needle = query;
    this.code.filetype = languageFor(document.path) ?? (query ? PLAIN_FILETYPE : undefined);
    this.code.onHighlight = markMatches(query);
    this.code.content = document.text.replace(/\n$/, "");
    this.lines.showLineNumbers = true;
  }

  private scrollToLine(): void {
    if (this.line === undefined) return;

    const top = Math.max(0, this.line - 1 - Math.floor(this.root.viewport.height / 3));
    this.root.scrollTo({ x: 0, y: top });
  }
}
