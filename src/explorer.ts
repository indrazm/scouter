import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { extname, posix } from "node:path";
import type { TreeEntry } from "./file-tree";
import { displayLabel } from "./files";
import { handleListKey } from "./keys";
import { scrollbarStyle, styled } from "./styled";
import { theme } from "./theme";

interface ExplorerOptions {
  onActivate: () => void;
}

/** How a row is marked: a status letter at its right edge, and whether its name is faded. */
export interface RowStyle {
  letter?: string;
  color?: string;
  dim?: boolean;
}

interface ExplorerRow {
  entry: TreeEntry;
  box: BoxRenderable;
  text: TextRenderable;
  mark: TextRenderable;
  style: RowStyle;
}

const plainRow = (): RowStyle => ({});

/** Private-use code points from the Nerd Fonts set, so they show as the icons only in a terminal using a Nerd Font. */
const fileIcons: Record<string, string> = {
  ".js": "\ue74e",
  ".mjs": "\ue74e",
  ".cjs": "\ue74e",
  ".ts": "\ue628",
  ".mts": "\ue628",
  ".cts": "\ue628",
  ".jsx": "\ue7ba",
  ".tsx": "\ue7ba",
  ".json": "\ue60b",
  ".md": "\uf48a",
  ".mdx": "\uf48a",
  ".py": "\ue73c",
  ".go": "\ue627",
  ".rs": "\ue7a8",
  ".zig": "\ue6a9",
  ".html": "\ue736",
  ".css": "\ue749",
  ".sh": "\uf489",
  ".yaml": "\uf013",
  ".yml": "\uf013",
  ".toml": "\uf013",
};

/**
 * A text search result: the file's name and line, then the line itself with the matching part picked out, then the
 * folder. The list is narrow, so what tells results apart comes first and the folder, which is cut off first, last.
 */
function matchContent(entry: TreeEntry, match: NonNullable<TreeEntry["match"]>, icon: string, selected: boolean) {
  const end = match.at + match.length;
  const folder = posix.dirname(entry.name);
  return styled([
    {
      text: `${icon} ${displayLabel(posix.basename(entry.name))}`,
      fg: selected ? theme.accent : theme.text,
      bold: selected,
    },
    { text: `:${match.line}  `, fg: theme.dim },
    { text: displayLabel(match.text.slice(0, match.at)), fg: theme.muted },
    { text: displayLabel(match.text.slice(match.at, end)), fg: theme.accentSoft, bold: true },
    { text: displayLabel(match.text.slice(end)), fg: theme.muted },
    ...(folder === "." ? [] : [{ text: `  ${displayLabel(folder)}/`, fg: theme.dim }]),
  ]);
}

export class FileExplorer extends ScrollBoxRenderable {
  private rows: ExplorerRow[] = [];
  private selectedIndex = 0;

  constructor(context: RenderContext, options: ExplorerOptions) {
    super(context, {
      id: "browser",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: false,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: scrollbarStyle(),
    });
    this.onActivate = options.onActivate;
  }

  private readonly onActivate: () => void;

  show(entries: TreeEntry[], selectedPath: string, style: (entry: TreeEntry) => RowStyle = plainRow): void {
    for (const row of this.rows) row.box.destroyRecursively();
    this.rows = entries.map((entry, index) => this.createRow(entry, index, style(entry)));
    this.selectedIndex = -1;
    this.selectIndex(
      Math.max(
        0,
        entries.findIndex((entry) => entry.path === selectedPath),
      ),
    );
    this.rows.forEach((row, index) => this.paintRow(row, index));
  }

  private createRow(entry: TreeEntry, index: number, style: RowStyle): ExplorerRow {
    const box = new BoxRenderable(this.ctx, {
      id: `tree-row-${index}`,
      height: 1,
      width: "100%",
      flexShrink: 0,
      flexDirection: "row",
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        event.preventDefault();
        // No focus change here: opening a file ends with the reader focused, and taking focus on the way would
        // flash both pane borders. The owner focuses whichever pane the click leads to.
        this.selectIndex(index);
        this.onActivate();
      },
    });
    const text = new TextRenderable(this.ctx, {
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: "none",
      selectable: false,
      bg: "transparent",
    });
    const mark = new TextRenderable(this.ctx, {
      height: 1,
      flexShrink: 0,
      marginLeft: 1,
      wrapMode: "none",
      selectable: false,
      bg: "transparent",
    });
    box.add(text);
    box.add(mark);
    this.add(box);
    return { entry, box, text, mark, style };
  }

  /** Paints every row again, for when the colours changed; `style` marks the rows afresh in the new colours. */
  repaint(style: (entry: TreeEntry) => RowStyle): void {
    for (const row of this.rows) row.style = style(row.entry);
    this.rows.forEach((row, index) => this.paintRow(row, index));
    this.scrollbarOptions = scrollbarStyle();
  }

  selected(): TreeEntry | undefined {
    return this.rows[this.selectedIndex]?.entry;
  }

  moveSelection(delta: number): void {
    this.selectIndex(this.selectedIndex + delta);
  }

  selectBoundary(edge: "start" | "end"): void {
    this.selectIndex(edge === "start" ? 0 : this.rows.length - 1);
  }

  override handleKeyPress(key: KeyEvent): boolean {
    return handleListKey(this, key);
  }

  private selectIndex(index: number): void {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.rows.length - 1));
    const previousRow = this.rows[previous];
    const selectedRow = this.rows[this.selectedIndex];
    if (previousRow) this.paintRow(previousRow, previous);
    if (!selectedRow) return;
    this.paintRow(selectedRow, this.selectedIndex);
    this.scrollChildIntoView(selectedRow.box);
  }

  private paintRow(row: ExplorerRow, index: number): void {
    const selected = index === this.selectedIndex;
    const entry = row.entry;
    const folder = entry.kind === "directory" || entry.children !== undefined;
    const expanded = entry.state === "expanded";
    const marker = folder ? (expanded ? "▾ " : "▸ ") : "  ";
    const icon = folder
      ? expanded
        ? "\uf07c"
        : "\uf07b"
      : entry.kind === "link"
        ? "\uf0c1"
        : (fileIcons[extname(entry.name).toLowerCase()] ?? "\uf016");
    row.text.content = entry.match
      ? matchContent(entry, entry.match, icon, selected)
      : `${"  ".repeat(entry.depth)}${marker}${icon} ${displayLabel(entry.name)}${folder ? "/" : ""}`;
    row.text.fg = selected ? theme.accent : row.style.dim ? theme.dim : theme.text;
    row.mark.content = row.style.letter
      ? styled([{ text: row.style.letter, fg: row.style.color ?? theme.text, bold: true }])
      : "";
  }
}
