import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { posix } from "node:path";
import { displayLabel } from "./files";
import type { Change, ChangeKind } from "./git";
import { styled, type Segment } from "./styled";
import { theme } from "./theme";

interface ChangeListOptions {
  /** The highlighted change moved (or the list emptied). */
  onSelect: (change: Change | undefined) => void;
  /** The user asked to open the highlighted change: Enter or a click. */
  onActivate: () => void;
}

interface ChangeRow {
  change: Change;
  box: BoxRenderable;
  status: TextRenderable;
  name: TextRenderable;
  counts: TextRenderable;
}

export const statusLetters: Record<ChangeKind, { letter: string; color: string }> = {
  modified: { letter: "M", color: theme.modified },
  added: { letter: "A", color: theme.added },
  deleted: { letter: "D", color: theme.removed },
  renamed: { letter: "R", color: theme.accentSoft },
  typechange: { letter: "T", color: theme.muted },
  conflict: { letter: "U", color: theme.removed },
  untracked: { letter: "?", color: theme.muted },
};

/** Files that differ from the last commit: one row each, with its kind, name, folder and line counts. */
export class ChangeList extends ScrollBoxRenderable {
  private rows: ChangeRow[] = [];
  private selectedIndex = -1;
  private note?: TextRenderable;
  private readonly options: ChangeListOptions;

  constructor(context: RenderContext, options: ChangeListOptions) {
    super(context, {
      id: "changes",
      width: "100%",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      scrollX: false,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
      scrollbarOptions: { trackOptions: { backgroundColor: "transparent", foregroundColor: theme.muted } },
    });
    this.options = options;
  }

  /**
   * Replaces the rows. The highlight stays on `selectedPath`; if that file is gone (committed, say), it stays near
   * where it was so the user is not thrown back to the top of the list. `truncated` puts a note above the rows.
   */
  show(changes: Change[], selectedPath?: string, truncated = false): void {
    const previous = this.selectedIndex;
    for (const row of this.rows) row.box.destroyRecursively();
    this.note?.destroyRecursively();
    this.note = undefined;
    this.rows = changes.map((change, index) => this.createRow(change, index));
    this.selectedIndex = -1;
    const keep = changes.findIndex((change) => change.path === selectedPath);
    const nearby = Math.min(Math.max(previous, 0), changes.length - 1);
    this.selectIndex(changes.length ? (keep >= 0 ? keep : nearby) : -1);
    this.rows.forEach((row, index) => this.paintRow(row, index === this.selectedIndex));
    if (truncated) this.showNote(`Only the first ${changes.length.toLocaleString("en-US")} changes are listed.`);
  }

  private showNote(text: string): void {
    this.note = new TextRenderable(this.ctx, {
      height: 1,
      width: "100%",
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      content: styled([{ text, fg: theme.modified }]),
    });
    this.add(this.note, 0);
  }

  /** Moves the highlight to `path` without announcing it, for when the reader's scrolling is what moved. */
  highlight(path: string): void {
    const index = this.rows.findIndex((row) => row.change.path === path);
    if (index < 0 || index === this.selectedIndex) return;
    const previousRow = this.rows[this.selectedIndex];
    if (previousRow) this.paintRow(previousRow, false);
    this.selectedIndex = index;
    const row = this.rows[index];
    if (row) {
      this.paintRow(row, true);
      this.scrollChildIntoView(row.box);
    }
  }

  selected(): Change | undefined {
    return this.rows[this.selectedIndex]?.change;
  }

  moveSelection(delta: number): void {
    if (this.rows.length) this.selectIndex(this.selectedIndex + delta);
  }

  selectBoundary(edge: "start" | "end"): void {
    if (this.rows.length) this.selectIndex(edge === "start" ? 0 : this.rows.length - 1);
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

  private createRow(change: Change, index: number): ChangeRow {
    const box = new BoxRenderable(this.ctx, {
      id: `change-row-${index}`,
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      onMouseDown: (event) => {
        if (event.button !== MouseButton.LEFT) return;
        event.preventDefault();
        // No focus change here: opening a diff ends with the reader focused, and taking focus on the way would
        // flash both pane borders. The owner focuses whichever pane the click leads to.
        this.selectIndex(index);
        this.options.onActivate();
      },
    });
    const text = (options: Record<string, unknown>): TextRenderable =>
      new TextRenderable(this.ctx, { height: 1, wrapMode: "none", selectable: false, ...options });
    const status = text({ width: 4, flexShrink: 0 });
    const name = text({ flexGrow: 1, flexShrink: 1, minWidth: 0 });
    const counts = text({ flexShrink: 0, marginLeft: 1 });
    box.add(status);
    box.add(name);
    box.add(counts);
    this.add(box);
    return { change, box, status, name, counts };
  }

  private selectIndex(index: number): void {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.rows.length - 1));
    if (!this.rows.length) this.selectedIndex = -1;
    const previousRow = this.rows[previous];
    const selectedRow = this.rows[this.selectedIndex];
    if (previousRow && previous !== this.selectedIndex) this.paintRow(previousRow, false);
    if (selectedRow) {
      this.paintRow(selectedRow, true);
      this.scrollChildIntoView(selectedRow.box);
    }
    if (previous !== this.selectedIndex) this.options.onSelect(selectedRow?.change);
  }

  private paintRow(row: ChangeRow, selected: boolean): void {
    const { change } = row;
    const { letter, color } = statusLetters[change.kind];
    const name = displayLabel(posix.basename(change.path));
    const folder = posix.dirname(change.path);
    const origin = change.oldPath ? `  ← ${displayLabel(posix.basename(change.oldPath))}` : "";
    const mark = indexMark(change);
    row.status.content = styled([{ text: letter, fg: color, bold: true }, { text: " " }, ...(mark ? [mark] : [])]);
    row.name.content = styled([
      { text: name, fg: selected ? theme.accent : theme.text, bold: selected },
      { text: origin, fg: theme.dim },
      ...(folder === "." ? [] : [{ text: `  ${displayLabel(folder)}/`, fg: theme.dim }]),
    ]);
    row.counts.content = styled(countSegments(change));
  }
}

/**
 * Whether the change is in the index: ● staged, ◐ partly staged, ○ not staged. Untracked files have no mark.
 */
export function indexMark(change: Change): Segment | undefined {
  if (change.staged && change.unstaged) return { text: "◐", fg: theme.modified };
  if (change.staged) return { text: "●", fg: theme.added };
  if (change.unstaged) return { text: "○", fg: theme.dim };
  return undefined;
}

export function countSegments(change: Change): Segment[] {
  if (change.binary) return [{ text: "bin", fg: theme.dim }];
  if (change.added === undefined || change.removed === undefined) return [{ text: "new", fg: theme.dim }];
  const segments: Segment[] = [];
  if (change.added) segments.push({ text: `+${change.added}`, fg: theme.added });
  if (change.removed) segments.push({ text: `${segments.length ? " " : ""}−${change.removed}`, fg: theme.removed });
  return segments;
}
