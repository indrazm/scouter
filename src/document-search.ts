import type { KeyEvent } from "@opentui/core";
import type { Footer } from "./footer";
import { isPlain, isTyped } from "./keys";

interface DocumentSearchHost {
  footer: Footer;
  /** The open text file's text, or undefined when no text file is open. */
  text(): string | undefined;
  /** The first line (counted from zero) at the top of the reader. */
  topLine(): number;
  scrollToLine(line: number): void;
}

interface Search {
  query: string;
  /** Lines (counted from zero) that contain the query. */
  lines: number[];
  /** Which of `lines` the reader is on. */
  at: number;
}

/** `/` over the open text file: find lines as you type, keep the search for `n` and `p`, drop it with Esc. */
export class DocumentSearch {
  private editing = false;
  private search?: Search;
  /** The file's lines in lower case, rebuilt only when the file's text changes rather than on every key. */
  private index?: { text: string; lines: string[] };

  constructor(private readonly host: DocumentSearchHost) {}

  start(): void {
    this.search = { query: "", lines: [], at: -1 };
    this.editing = true;
    this.host.footer.setPrompt("reader");
    this.show();
  }

  /** Keys while the prompt is open. Enter keeps the search for n and p; Esc drops it. Other chords are left alone. */
  handleKey(key: KeyEvent): boolean {
    const search = this.search;
    if (!this.editing || !search || !isPlain(key)) return false;
    key.preventDefault();
    if (key.name === "escape") this.cancel();
    else if (key.name === "return") this.keep();
    else if (key.name === "backspace") this.type(search.query.slice(0, -1));
    else if (isTyped(key)) this.type(search.query + key.sequence);
    return true;
  }

  /** `n` and `p`: the next or previous line the search matched, wrapping at either end. */
  step(direction: 1 | -1): void {
    const search = this.search;
    if (!search) {
      this.host.footer.setMessage("Press / to search this file.");
      return;
    }
    const count = search.lines.length;
    if (count) this.moveTo(search, (search.at + direction + count) % count);
    this.show();
  }

  /** The file on screen changed: look for the same words in it, without moving the reader. */
  refresh(): void {
    const search = this.search;
    if (!search) return;
    search.lines = this.matchingLines(search.query);
    search.at = Math.min(Math.max(search.at, 0), Math.max(search.lines.length - 1, 0));
    this.show();
  }

  /** A file that cannot be searched is on screen: nothing is kept. */
  clear(): void {
    this.editing = false;
    this.search = undefined;
    this.host.footer.setPrompt(undefined);
  }

  private cancel(): void {
    this.clear();
    this.host.footer.clearMessage();
  }

  private keep(): void {
    this.editing = false;
    this.host.footer.setPrompt(undefined);
    this.show();
  }

  /** Recounts the lines matching what is typed, and jumps to the first one at or below the top of the reader. */
  private type(query: string): void {
    const search = this.search;
    if (!search) return;
    search.query = query;
    search.lines = this.matchingLines(query);
    const top = this.host.topLine();
    this.moveTo(
      search,
      Math.max(
        0,
        search.lines.findIndex((line) => line >= top),
      ),
    );
    this.show();
  }

  private moveTo(search: Search, at: number): void {
    search.at = at;
    const line = search.lines[at];
    if (line !== undefined) this.host.scrollToLine(line);
  }

  private matchingLines(query: string): number[] {
    const needle = query.toLowerCase();
    if (!needle) return [];
    return this.lowerLines().flatMap((line, index) => (line.includes(needle) ? [index] : []));
  }

  private lowerLines(): string[] {
    const text = this.host.text() ?? "";
    if (this.index?.text !== text) this.index = { text, lines: text.toLowerCase().split("\n") };
    return this.index.lines;
  }

  private show(): void {
    const search = this.search;
    if (!search) return;
    const count = !search.query
      ? ""
      : search.lines.length
        ? `  ${search.at + 1} of ${search.lines.length}`
        : "  no matches";
    this.host.footer.setMessage(`/${search.query}${count}`);
  }
}
