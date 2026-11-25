import {
  BoxRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
  type TextOptions,
} from "@opentui/core";
import { posix } from "node:path";
import { displayLabel } from "../core/files";
import { handleListKey } from "../core/keys";
import { scrollbarStyle, styled } from "../ui/styled";
import { theme, transparent } from "../ui/theme";
import type { Segment } from "../ui/types";
import type { Change, ChangeKind } from "./types";

interface ChangeListOptions {
  onSelect: (change: Change | undefined) => void;
  onActivate: () => void;
}

interface ChangeRow {
  index: number;
  change: Change;
  box: BoxRenderable;
  status: TextRenderable;
  name: TextRenderable;
  counts: TextRenderable;
}

const kindStyles: Record<
  ChangeKind,
  { letter: string; color: "modified" | "added" | "removed" | "accentSoft" | "muted" }
> = {
  modified: { letter: "M", color: "modified" },
  added: { letter: "A", color: "added" },
  deleted: { letter: "D", color: "removed" },
  renamed: { letter: "R", color: "accentSoft" },
  typechange: { letter: "T", color: "muted" },
  conflict: { letter: "U", color: "removed" },
  untracked: { letter: "?", color: "muted" },
};

export function statusOf(kind: ChangeKind): { letter: string; color: string } {
  const { letter, color } = kindStyles[kind];
  return { letter, color: theme[color] };
}

export class ChangeList extends ScrollBoxRenderable {
  private rows: ChangeRow[] = [];
  private pathIndex = new Map<string, number>();
  private selectedIndex = -1;
  private note?: TextRenderable;
  private noteText = "";
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
      scrollbarOptions: scrollbarStyle(),
    });
    this.options = options;
  }

  show(changes: Change[], selectedPath?: string, truncated = false): void {
    const previous = this.selectedIndex;

    if (!truncated && this.note) {
      this.note.destroyRecursively();
      this.note = undefined;
      this.noteText = "";
    }

    const reuse = Math.min(this.rows.length, changes.length);
    for (let index = 0; index < reuse; index += 1) {
      const row = this.rows[index]!;
      row.index = index;
      row.change = changes[index]!;
    }
    for (let index = reuse; index < changes.length; index += 1) {
      this.rows.push(this.createRow(changes[index]!, index));
    }
    for (let index = changes.length; index < this.rows.length; index += 1) {
      this.rows[index]!.box.destroyRecursively();
    }
    this.rows.length = changes.length;
    this.pathIndex.clear();
    for (let index = 0; index < changes.length; index += 1) this.pathIndex.set(changes[index]!.path, index);

    const keep = selectedPath === undefined ? -1 : (this.pathIndex.get(selectedPath) ?? -1);
    const nearby = Math.min(Math.max(previous, 0), changes.length - 1);
    this.selectedIndex = changes.length ? (keep >= 0 ? keep : nearby) : -1;
    this.rows.forEach((row, index) => this.paintRow(row, index === this.selectedIndex));

    if (truncated) this.showNote(`Only the first ${changes.length.toLocaleString("en-US")} changes are listed.`);

    const selectedRow = this.rows[this.selectedIndex];

    if (selectedRow) {
      this.scrollChildIntoView(selectedRow.box);
      this.options.onSelect(selectedRow.change);
    }
  }

  repaint(): void {
    this.rows.forEach((row, index) => this.paintRow(row, index === this.selectedIndex));

    if (this.note) this.note.content = styled([{ text: this.noteText, fg: theme.modified }]);

    this.scrollbarOptions = scrollbarStyle();
  }

  private showNote(text: string): void {
    this.noteText = text;
    const content = styled([{ text, fg: theme.modified }]);

    if (this.note) {
      this.note.content = content;
      return;
    }

    this.note = new TextRenderable(this.ctx, {
      height: 1,
      width: "100%",
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      content,
    });
    this.add(this.note, 0);
  }

  highlight(path: string): void {
    const index = this.pathIndex.get(path) ?? -1;

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
    return handleListKey(this, key);
  }

  private createRow(change: Change, index: number): ChangeRow {
    const text = (options: TextOptions): TextRenderable =>
      new TextRenderable(this.ctx, { height: 1, wrapMode: "none", selectable: false, ...options });
    const row: ChangeRow = {
      index,
      change,
      box: new BoxRenderable(this.ctx, {
        id: `change-row-${index}`,
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        onMouseDown: (event) => {
          if (event.button !== MouseButton.LEFT) return;

          event.preventDefault();
          this.selectIndex(row.index);
          this.options.onActivate();
        },
      }),
      status: text({ width: 5, flexShrink: 0 }),
      name: text({ flexGrow: 1, flexShrink: 1, minWidth: 0 }),
      counts: text({ flexShrink: 0, marginLeft: 1 }),
    };
    row.box.add(row.status);
    row.box.add(row.name);
    row.box.add(row.counts);
    this.add(row.box);
    return row;
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
    const { letter, color } = statusOf(change.kind);
    const name = displayLabel(posix.basename(change.path));
    const folder = posix.dirname(change.path);
    const origin = change.oldPath ? `  ← ${displayLabel(posix.basename(change.oldPath))}` : "";
    const mark = indexMark(change);
    row.box.backgroundColor = selected ? theme.rowActiveBg : transparent;
    const statusParts: Segment[] = [
      { text: selected ? "▎" : " ", fg: theme.accent },
      { text: letter, fg: color, bold: true },
      { text: " " },
    ];

    if (mark) statusParts.push(mark);

    row.status.content = styled(statusParts);

    const nameParts: Segment[] = [
      { text: name, fg: selected ? theme.accent : theme.text, bold: selected },
      { text: origin, fg: theme.dim },
    ];

    if (folder !== ".") nameParts.push({ text: `  ${displayLabel(folder)}/`, fg: theme.dim });

    row.name.content = styled(nameParts);
    row.counts.content = styled(countSegments(change));
  }
}

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
