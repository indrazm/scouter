import type { KeyEvent } from "@opentui/core";
import { isPlain } from "../core/keys";
import type { ReaderMotionOptions } from "./types";

const MAX_COUNT = 99_999_999;

export class ReaderMotion {
  private count = 0;
  private zPending = false;
  private blankLines?: { text: string; lines: number[] };

  constructor(private readonly options: ReaderMotionOptions) {}

  consumeZ(): boolean {
    const afterZ = this.zPending;
    this.zPending = false;
    return afterZ;
  }

  absorbCount(key: KeyEvent): boolean {
    const digit = /^[0-9]$/.test(key.sequence) && isPlain(key) ? Number(key.sequence) : undefined;

    if (digit === undefined || !this.options.canAcceptCount()) return false;

    if (this.options.isPreviewing() || (!this.count && !digit)) return false;

    key.preventDefault();
    this.count = Math.min(this.count * 10 + digit, MAX_COUNT);
    this.options.setPending(this.count);
    return true;
  }

  takeCount(): number {
    const count = this.count;

    if (count) {
      this.count = 0;
      this.options.setPending(undefined);
    }

    return count;
  }

  handleKey(key: KeyEvent, afterZ: boolean): boolean {
    if (!isPlain(key)) return false;

    if (afterZ) {
      if (key.name !== "z" || key.shift) return false;

      key.preventDefault();
      this.centre();
      return true;
    }

    if (key.name === "z" && !key.shift) {
      key.preventDefault();
      this.zPending = true;
      return true;
    }

    if (key.sequence !== "{" && key.sequence !== "}") return false;

    key.preventDefault();
    this.moveByParagraph(key.sequence === "}" ? 1 : -1);
    return true;
  }

  private blankLinesOf(text: string): number[] {
    if (this.blankLines?.text === text) return this.blankLines.lines;

    const lines: number[] = [];
    let index = 0;
    let start = 0;
    while (start <= text.length) {
      const end = text.indexOf("\n", start);
      const stop = end < 0 ? text.length : end;
      let blank = true;
      for (let cursor = start; cursor < stop; cursor += 1) {
        const code = text.charCodeAt(cursor);

        if (code !== 32 && code !== 9 && code !== 13) {
          blank = false;
          break;
        }
      }

      if (blank) lines.push(index);

      if (end < 0) break;

      start = end + 1;
      index += 1;
    }
    this.blankLines = { text, lines };
    return lines;
  }

  private moveByParagraph(direction: 1 | -1): void {
    const text = this.options.documentText();

    if (text === undefined) return;

    if (this.options.isPreviewing()) {
      this.options.setMessage("Press m to move by paragraph in this Markdown file's source.");
      return;
    }

    const blanks = this.blankLinesOf(text);
    const top = Math.floor(this.options.scrollTop());
    const target = direction > 0 ? blanks.find((line) => line > top) : blanks.findLast((line) => line < top);
    this.options.scrollTo(target === undefined ? (direction > 0 ? Infinity : 0) : target);
  }

  private centre(): void {
    const match = this.options.isPreviewing() ? undefined : this.options.currentMatchLine();
    this.options.scrollToLine(match ?? Math.floor(this.options.scrollTop() + this.options.viewportHeight() / 2));
  }
}
