import {
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { extname } from "node:path";
import type { TreeEntry } from "./file-tree";
import { displayLabel } from "./files";
import { theme } from "./theme";

interface ExplorerOptions {
  onActivate: () => void;
}

interface ExplorerRow {
  entry: TreeEntry;
  text: TextRenderable;
}

const fileIcons: Record<string, string> = {
  ".js": "\ue74e", ".mjs": "\ue74e", ".cjs": "\ue74e",
  ".ts": "\ue628", ".mts": "\ue628", ".cts": "\ue628",
  ".jsx": "\ue7ba", ".tsx": "\ue7ba", ".json": "\ue60b",
  ".md": "\uf48a", ".mdx": "\uf48a", ".py": "\ue73c",
  ".go": "\ue627", ".rs": "\ue7a8", ".zig": "\ue6a9",
  ".html": "\ue736", ".css": "\ue749", ".sh": "\uf489",
  ".yaml": "\uf013", ".yml": "\uf013", ".toml": "\uf013",
};

export class FileExplorer extends ScrollBoxRenderable {
  private rows: ExplorerRow[] = [];
  private selectedIndex = 0;

  constructor(context: RenderContext, options: ExplorerOptions) {
    super(context, {
      id: "browser", width: "100%", flexGrow: 1, flexBasis: 0, minHeight: 0, scrollX: false, scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: { trackOptions: { backgroundColor: "transparent", foregroundColor: theme.muted } },
    });
    this.onActivate = options.onActivate;
  }

  private readonly onActivate: () => void;

  show(entries: TreeEntry[], selectedPath: string): void {
    for (const row of this.rows) row.text.destroy();
    this.rows = entries.map((entry, index) => {
      const text = new TextRenderable(this.ctx, {
        id: `tree-row-${index}`, height: 1, width: "100%", flexShrink: 0,
        wrapMode: "none", selectable: false, bg: "transparent",
        onMouseDown: (event) => {
          if (event.button !== MouseButton.LEFT) return;
          event.preventDefault();
          this.selectIndex(index);
          this.onActivate();
        },
      });
      this.add(text);
      return { entry, text };
    });
    this.selectedIndex = -1;
    this.selectIndex(Math.max(0, entries.findIndex((entry) => entry.path === selectedPath)));
    this.rows.forEach((row, index) => this.paintRow(row, index));
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
    if (key.ctrl || key.meta) return false;
    if (["j", "down", "k", "up"].includes(key.name)) {
      this.moveSelection((["k", "up"].includes(key.name) ? -1 : 1) * (key.shift ? 5 : 1));
      return true;
    }
    if (["pageup", "pagedown"].includes(key.name)) {
      this.moveSelection((key.name === "pageup" ? -1 : 1) * Math.max(1, this.viewport.height - 1));
      return true;
    }
    return false;
  }

  private selectIndex(index: number): void {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.rows.length - 1));
    const previousRow = this.rows[previous];
    const selectedRow = this.rows[this.selectedIndex];
    if (previousRow) this.paintRow(previousRow, previous);
    if (!selectedRow) return;
    this.paintRow(selectedRow, this.selectedIndex);
    this.scrollChildIntoView(selectedRow.text);
  }

  private paintRow(row: ExplorerRow, index: number): void {
    const selected = index === this.selectedIndex;
    const entry = row.entry;
    const folder = entry.kind === "directory" || entry.children !== undefined;
    const expanded = entry.state === "expanded";
    const marker = folder ? (expanded ? "▾ " : "▸ ") : "  ";
    const icon = folder ? (expanded ? "\uf07c" : "\uf07b")
      : entry.kind === "link" ? "\uf0c1" : fileIcons[extname(entry.name).toLowerCase()] ?? "\uf016";
    row.text.content = `${"  ".repeat(entry.depth)}${marker}${icon} ${displayLabel(entry.name)}${folder ? "/" : ""}`;
    row.text.fg = selected ? theme.accent : theme.text;
  }
}
