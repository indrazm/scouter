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
import { scrollbarStyle, styled, type Segment } from "./styled";
import { theme, transparent } from "./theme";

interface ExplorerOptions {
  onActivate: () => void;
}

export interface RowStyle {
  letter?: string;
  color?: string;
  ignored?: boolean;
}

interface ExplorerRow {
  index: number;
  entry: TreeEntry;
  box: BoxRenderable;
  text: TextRenderable;
  mark: TextRenderable;
  style: RowStyle;
}

const plainRow = (): RowStyle => ({});

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

function iconColor(entry: TreeEntry, folder: boolean): string {
  if (folder) return theme.folder;

  if (entry.kind === "link") return theme.accentSoft;

  switch (extname(entry.name).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
    case ".tsx":
    case ".jsx":
    case ".go":
    case ".css":
      return theme.syntax.function;
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".json":
    case ".yaml":
    case ".yml":
    case ".toml":
    case ".zig":
      return theme.syntax.constant;
    case ".md":
    case ".mdx":
      return theme.accentSoft;
    case ".py":
    case ".sh":
      return theme.syntax.string;
    case ".rs":
    case ".html":
      return theme.syntax.keyword;
    default:
      return theme.muted;
  }
}

function matchContent(entry: TreeEntry, match: NonNullable<TreeEntry["match"]>, icon: string, selected: boolean) {
  const end = match.at + match.length;
  const folder = posix.dirname(entry.name);
  const segments: Segment[] = [
    { text: selected ? "▎" : " ", fg: theme.accent },
    {
      text: `${icon} ${displayLabel(posix.basename(entry.name))}`,
      fg: selected ? theme.accent : theme.text,
      bold: selected,
    },
    { text: `:${match.line}  `, fg: theme.dim },
    { text: displayLabel(match.text.slice(0, match.at)), fg: theme.muted },
    { text: displayLabel(match.text.slice(match.at, end)), fg: theme.accentSoft, bold: true },
    { text: displayLabel(match.text.slice(end)), fg: theme.muted },
  ];

  if (folder !== ".") segments.push({ text: `  ${displayLabel(folder)}/`, fg: theme.dim });

  return styled(segments);
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
    const reuse = Math.min(this.rows.length, entries.length);
    for (let index = 0; index < reuse; index += 1) {
      const row = this.rows[index]!;
      const entry = entries[index]!;
      row.index = index;
      row.entry = entry;
      row.style = style(entry);
    }
    for (let index = reuse; index < entries.length; index += 1) {
      const entry = entries[index]!;
      this.rows.push(this.createRow(entry, index, style(entry)));
    }
    for (let index = entries.length; index < this.rows.length; index += 1) {
      this.rows[index]!.box.destroyRecursively();
    }
    this.rows.length = entries.length;
    this.selectedIndex = entries.length
      ? Math.max(
          0,
          entries.findIndex((entry) => entry.path === selectedPath),
        )
      : -1;
    this.rows.forEach((row, index) => this.paintRow(row, index));
    const selectedRow = this.rows[this.selectedIndex];

    if (selectedRow) this.scrollChildIntoView(selectedRow.box);
  }

  selectPath(path: string): boolean {
    const index = this.rows.findIndex((row) => row.entry.path === path);

    if (index < 0) return false;

    this.selectIndex(index);
    return true;
  }

  private createRow(entry: TreeEntry, index: number, style: RowStyle): ExplorerRow {
    const row: ExplorerRow = {
      index,
      entry,
      style,
      box: new BoxRenderable(this.ctx, {
        id: `tree-row-${index}`,
        height: 1,
        width: "100%",
        flexShrink: 0,
        flexDirection: "row",
        onMouseDown: (event) => {
          if (event.button !== MouseButton.LEFT) return;

          event.preventDefault();
          this.selectIndex(row.index);
          this.onActivate();
        },
      }),
      text: new TextRenderable(this.ctx, {
        height: 1,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        wrapMode: "none",
        selectable: false,
        bg: "transparent",
      }),
      mark: new TextRenderable(this.ctx, {
        height: 1,
        flexShrink: 0,
        marginLeft: 1,
        wrapMode: "none",
        selectable: false,
        bg: "transparent",
      }),
    };
    row.box.add(row.text);
    row.box.add(row.mark);
    this.add(row.box);
    return row;
  }

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
    row.box.backgroundColor = selected ? theme.rowActiveBg : transparent;
    const nameFg = selected ? theme.accent : row.style.ignored ? theme.ignored : theme.text;
    const glyphFg = selected ? theme.accent : row.style.ignored ? theme.ignored : iconColor(entry, folder);

    if (entry.match) {
      row.text.content = matchContent(entry, entry.match, icon, selected);
    } else {
      const segments: Segment[] = [{ text: selected ? "▎" : " ", fg: theme.accent }];

      if (entry.depth > 0) segments.push({ text: "│ ".repeat(entry.depth), fg: theme.ignored });

      segments.push(
        { text: marker, fg: selected ? theme.accent : theme.dim },
        { text: `${icon} `, fg: glyphFg },
        { text: `${displayLabel(entry.name)}${folder ? "/" : ""}`, fg: nameFg, bold: selected },
      );
      row.text.content = styled(segments);
    }

    row.mark.content = row.style.letter
      ? styled([{ text: row.style.letter, fg: row.style.color ?? theme.text, bold: true }])
      : "";
  }
}
