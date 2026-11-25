import type { KeyEvent } from "@opentui/core";
import type { Footer } from "../ui/footer";
import { isPlain, isTyped } from "../core/keys";

interface DocumentSearchHost {
  footer: Footer;
  text(): string | undefined;
  topLine(): number;
  scrollToLine(line: number): void;
  highlight(query: string | undefined): void;
  highlightLine(line: number | undefined): void;
}

interface Search {
  query: string;
  lines: number[];
  at: number;
}

export class DocumentSearch {
  private editing = false;
  private search?: Search;
  private index?: { text: string; lines: string[] };

  constructor(private readonly host: DocumentSearchHost) {}

  start(): void {
    this.search = { query: "", lines: [], at: -1 };
    this.editing = true;
    this.host.footer.setPrompt("reader");
    this.show();
  }

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

  seed(query: string, line: number): void {
    const lines = this.matchingLines(query);
    this.search = { query, lines, at: Math.max(0, lines.indexOf(line)) };
    this.editing = false;
    this.host.footer.setPrompt(undefined);
    this.show();
  }

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

  currentLine(): number | undefined {
    const search = this.search;
    return search?.lines[search.at];
  }

  refresh(): void {
    const search = this.search;

    if (!search) return;

    search.lines = this.matchingLines(search.query);
    search.at = Math.min(Math.max(search.at, 0), Math.max(search.lines.length - 1, 0));
    this.show();
  }

  syncHighlight(): void {
    this.host.highlight(this.search?.query || undefined);
    this.host.highlightLine(this.currentLine());
  }

  clear(): void {
    this.editing = false;
    this.search = undefined;
    this.host.footer.setPrompt(undefined);
    this.host.highlight(undefined);
    this.host.highlightLine(undefined);
  }

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

  dismiss(): boolean {
    if (!this.search || this.editing) return false;

    this.clear();
    this.host.footer.clearMessage();
    return true;
  }

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

    const lines = this.lowerLines();
    const matches: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.includes(needle)) matches.push(index);
    }
    return matches;
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
    this.host.highlightLine(this.currentLine());
  }
}
