import type { KeyEvent } from "@opentui/core";
import type { Footer } from "./footer";
import { isPlain, isTyped } from "./keys";

interface DocumentSearchHost {
  footer: Footer;
  text(): string | undefined;
  /** Lines are counted from zero throughout this file. */
  topLine(): number;
  scrollToLine(line: number): void;
  highlight(query: string | undefined): void;
}

interface Search {
  query: string;
  lines: number[];
  /** Index into `lines`. */
  at: number;
}

/** `/` over the open text file. Esc closes the prompt and keeps the matches for `n` and `N`; a second Esc clears them. */
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

  /** Keys while the prompt is open. Ctrl and Alt chords are left alone. */
  get prompting(): boolean {
    return this.editing;
  }

  handleKey(key: KeyEvent): boolean {
    const search = this.search;
    if (!this.editing || !search || !isPlain(key)) return false;
    key.preventDefault();
    if (key.name === "escape") this.close(search);
    else if (key.name === "return") this.step(key.shift ? -1 : 1);
    else if (key.name === "down") this.step(1);
    else if (key.name === "up") this.step(-1);
    else if (key.name === "backspace") this.type(search.query.slice(0, -1));
    else if (isTyped(key)) this.type(search.query + key.sequence);
    return true;
  }

  /** Starts a kept search, with no prompt, on the line where `query` was just found. */
  seed(query: string, line: number): void {
    const lines = this.matchingLines(query);
    this.search = { query, lines, at: Math.max(0, lines.indexOf(line)) };
    this.editing = false;
    this.host.footer.setPrompt(undefined);
    this.show();
  }

  /** Wraps at either end. */
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

  /** The line the kept search is on, for `zz` to centre. */
  currentLine(): number | undefined {
    const search = this.search;
    return search?.lines[search.at];
  }

  /** The file on screen changed: search it again without moving the reader. */
  refresh(): void {
    const search = this.search;
    if (!search) return;
    search.lines = this.matchingLines(search.query);
    search.at = Math.min(Math.max(search.at, 0), Math.max(search.lines.length - 1, 0));
    this.show();
  }

  syncHighlight(): void {
    this.host.highlight(this.search?.query || undefined);
  }

  /** A file that cannot be searched is on screen: nothing is kept. */
  clear(): void {
    this.editing = false;
    this.search = undefined;
    this.host.footer.setPrompt(undefined);
    this.host.highlight(undefined);
  }

  /** Esc in the prompt: nothing typed means nothing to keep. */
  private close(search: Search): void {
    if (!search.query) {
      this.clear();
      this.host.footer.clearMessage();
      return;
    }
    this.editing = false;
    this.host.footer.setPrompt(undefined);
    this.show();
  }

  /** Esc with the prompt closed. False when there were no kept matches, so Esc means what it always does. */
  dismiss(): boolean {
    if (!this.search || this.editing) return false;
    this.clear();
    this.host.footer.clearMessage();
    return true;
  }

  /** Jumps to the first match at or below the top of the reader. */
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
    this.host.highlight(search.query || undefined);
  }
}
