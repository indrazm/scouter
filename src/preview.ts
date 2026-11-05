import { CodeRenderable, LineNumberRenderable, ScrollBoxRenderable, type CliRenderer } from "@opentui/core";
import type { CodeView } from "./code-view";
import { languageFor } from "./code-view";
import { readDocument, type Document } from "./files";
import { PLAIN_FILETYPE, markMatches } from "./match-style";
import { theme } from "./theme";

/** The line a result points at is tinted so it stands out from the lines around it. */
const MATCH_LINE = { gutter: "#343b66", content: "#262b46" };

/**
 * A read-only look at the file behind the highlighted text search result, scrolled so its line sits a third of the way
 * down and tinted. It is its own pane, not the open file: hiding it leaves the reader exactly as it was.
 */
export class HitPreview {
  readonly root: ScrollBoxRenderable;
  private readonly code: CodeRenderable;
  private readonly lines: LineNumberRenderable;
  private document?: Document;
  /** The words marked in the file wherever they occur. */
  private needle = "";
  /** The line (counted from one) the preview is scrolled to. */
  private line?: number;
  /** Bumped when a newer result is asked for or the preview is hidden, so a slow read cannot show a stale file. */
  private request = 0;

  constructor(renderer: CliRenderer, syntax: CodeView["syntax"]) {
    this.root = new ScrollBoxRenderable(renderer, {
      id: "preview",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: true,
      scrollY: true,
      contentOptions: { flexDirection: "column", width: "auto" },
      scrollbarOptions: { trackOptions: { backgroundColor: "transparent", foregroundColor: theme.muted } },
      horizontalScrollbarOptions: { visible: false },
      // Hidden panes have no size, so the scroll waits until the pane has one.
      onSizeChange: () => this.scrollToLine(),
    });
    this.code = new CodeRenderable(renderer, {
      content: "",
      syntaxStyle: syntax.style,
      treeSitterClient: syntax.client,
      fg: theme.text,
      wrapMode: "none",
      flexShrink: 0,
      conceal: false,
      drawUnstyledText: true,
    });
    this.lines = new LineNumberRenderable(renderer, {
      target: this.code,
      minWidth: 3,
      paddingRight: 2,
      fg: theme.muted,
      bg: "transparent",
      flexShrink: 0,
      onSizeChange: () => this.scrollToLine(),
    });
    this.root.add(this.lines);
    this.root.visible = false;
  }

  get active(): boolean {
    return this.root.visible;
  }

  /**
   * Shows `path` with `line` (counted from one) marked. False when the file cannot be read as text, or when a newer
   * request or `hide` came first; the caller then shows nothing for this one.
   */
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
    this.lines.setLineColors(new Map([[line - 1, MATCH_LINE]]));
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
