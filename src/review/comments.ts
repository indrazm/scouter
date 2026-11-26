import type { CommentTarget, DiffRow, ReviewComment } from "./types";

function sideOf(mark: DiffRow["mark"]): "old" | "new" {
  return mark === "-" ? "old" : "new";
}

function keyOf({ path, mark, line, endMark, endLine }: Omit<CommentTarget, "rows">): string {
  return `${path}\0${sideOf(mark)}\0${line}\0${sideOf(endMark)}\0${endLine}`;
}

function rowsEqual(left: DiffRow[], right: DiffRow[]): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;

    if (a.mark !== b.mark || a.line !== b.line || a.text !== b.text) return false;
  }

  return true;
}

export function singleLineTarget(path: string, row: DiffRow): CommentTarget {
  return {
    path,
    mark: row.mark,
    line: row.line,
    endMark: row.mark,
    endLine: row.line,
    rows: [{ ...row }],
  };
}

export function rangeTarget(path: string, rows: DiffRow[]): CommentTarget | undefined {
  const first = rows[0];
  const last = rows.at(-1);

  if (!first || !last) return undefined;

  return {
    path,
    mark: first.mark,
    line: first.line,
    endMark: last.mark,
    endLine: last.line,
    rows: rows.map((row) => ({ ...row })),
  };
}

export function matchCommentSpan(
  target: CommentTarget,
  blockRows: DiffRow[],
): { start: number; end: number } | undefined {
  const count = target.rows.length;

  if (!count || count > blockRows.length) return undefined;

  const first = target.rows[0]!;
  for (let start = 0; start <= blockRows.length - count; start += 1) {
    const candidate = blockRows[start]!;

    if (candidate.mark !== first.mark || candidate.line !== first.line || candidate.text !== first.text) continue;

    let matched = true;
    for (let offset = 1; offset < count; offset += 1) {
      const a = blockRows[start + offset]!;
      const b = target.rows[offset]!;

      if (a.mark !== b.mark || a.line !== b.line || a.text !== b.text) {
        matched = false;
        break;
      }
    }

    if (matched) return { start, end: start + count - 1 };
  }

  return undefined;
}

export function formatLineRange(target: CommentTarget): { range: string; removed: boolean } {
  const allRemoved = target.rows.every((row) => row.mark === "-");

  if (target.rows.length <= 1) return { range: `${target.line}`, removed: allRemoved };

  if (allRemoved) {
    return {
      range: target.line === target.endLine ? `${target.line}` : `${target.line}-${target.endLine}`,
      removed: true,
    };
  }

  const kept = target.rows.filter((row) => row.mark !== "-");
  const start = kept[0]?.line ?? target.line;
  const end = kept.at(-1)?.line ?? target.endLine;
  return { range: start === end ? `${start}` : `${start}-${end}`, removed: false };
}

export class ReviewComments {
  private readonly items = new Map<string, ReviewComment>();

  get size(): number {
    return this.items.size;
  }

  get(target: Omit<CommentTarget, "rows">): ReviewComment | undefined {
    return this.items.get(keyOf(target));
  }

  getMatching(target: CommentTarget): ReviewComment | undefined {
    const current = this.items.get(keyOf(target));
    return current && rowsEqual(current.rows, target.rows) ? current : undefined;
  }

  findCovering(path: string, row: DiffRow, accept?: (comment: ReviewComment) => boolean): ReviewComment | undefined {
    for (const comment of this.items.values()) {
      if (comment.path !== path) continue;

      if (accept && !accept(comment)) continue;

      if (comment.rows.some((entry) => entry.mark === row.mark && entry.line === row.line && entry.text === row.text)) {
        return comment;
      }
    }

    return undefined;
  }

  set(target: CommentTarget, text: string): void {
    const key = keyOf(target);

    if (text) {
      this.items.set(key, {
        ...target,
        rows: target.rows.map((row) => ({ ...row })),
        text,
      });
    } else {
      const current = this.items.get(key);

      if (current && rowsEqual(current.rows, target.rows)) this.items.delete(key);
    }
  }

  delete(target: Omit<CommentTarget, "rows">): boolean {
    return this.items.delete(keyOf(target));
  }

  deleteMatching(snapshot: ReviewComment[]): number {
    let removed = 0;
    for (const comment of snapshot) {
      const key = keyOf(comment);
      const current = this.items.get(key);

      if (current && current.text === comment.text && rowsEqual(current.rows, comment.rows)) {
        this.items.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): number {
    const removed = this.items.size;
    this.items.clear();
    return removed;
  }

  countForPath(path: string): number {
    let count = 0;
    for (const comment of this.items.values()) {
      if (comment.path === path) count += 1;
    }
    return count;
  }

  list(): ReviewComment[] {
    return this.items
      .values()
      .toArray()
      .toSorted(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.line - b.line ||
          Number(b.mark === "-") - Number(a.mark === "-") ||
          a.endLine - b.endLine ||
          a.rows.length - b.rows.length,
      );
  }

  markedRows(path: string, rows: DiffRow[]): Map<number, ReviewComment> {
    const marked = new Map<number, ReviewComment>();

    for (const comment of this.items.values()) {
      if (comment.path !== path) continue;

      const span = matchCommentSpan(comment, rows);

      if (!span) continue;

      for (let index = span.start; index <= span.end; index += 1) marked.set(index, comment);
    }

    return marked;
  }

  exportText(items = this.list()): string {
    const entries = items.map((comment) => {
      const { range, removed } = formatLineRange(comment);
      const suffix = removed ? (comment.rows.length > 1 ? " (removed lines)" : " (removed line)") : "";
      const quote = comment.rows.map((row) => `> ${row.mark} ${row.text}`.trimEnd()).join("\n");
      return `${comment.path}:${range}${suffix}\n${quote}\n${comment.text}`;
    });
    return [`Review comments on the working tree changes (${items.length}):`, ...entries].join("\n\n");
  }
}
