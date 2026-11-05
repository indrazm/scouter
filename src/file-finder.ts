import { TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core";
import type { FileExplorer, RowStyle } from "./explorer";
import type { TreeEntry } from "./file-tree";
import type { Footer } from "./footer";
import { isPlain, isTyped } from "./keys";
import { treeRelative } from "./marks";
import {
  MAX_TEXT_HITS,
  indexTree,
  matchEntries,
  searchText,
  type IndexedEntry,
  type TextHit,
  type TextProgress,
} from "./search";
import { styled } from "./styled";
import { theme } from "./theme";

/** Fewer characters than this would match most lines of most files, so the search waits for more. */
const MIN_TEXT_QUERY = 2;
/** Typing keeps going without a scan starting after every key; it starts once the keys pause. */
const SCAN_DELAY_MS = 150;

interface FileFinderHost {
  browser: FileExplorer;
  footer: Footer;
  /** The browsed folder, or undefined before one is open. */
  rootPath(): string | undefined;
  /** Whether git ignores this path, given relative to the browsed folder, so the index can leave it out. */
  isIgnored(relativePath: string): boolean;
  styleOf(entry: TreeEntry): RowStyle;
  /** Shows the whole tree again with `selectedPath` highlighted. */
  showTree(selectedPath: string): void;
  /** The user chose a row. `typed` is what was typed, empty when Enter was pressed with nothing typed. */
  pick(picked: TreeEntry, typed: string): void;
  /** The highlighted row is a text search result to look at, or, with undefined, there is none to look at. */
  preview(entry: TreeEntry | undefined, query: string): void;
  isDestroyed(): boolean;
}

/** `files` narrows by name; `text` lists the lines inside files that contain what is typed. */
type FindMode = "files" | "text";

/** What is typed, the files it can match once they are indexed, and the row to return to. */
interface Finding {
  mode: FindMode;
  query: string;
  entries?: IndexedEntry[];
  truncated: boolean;
  returnTo?: string;
  /** What the text search has found for the current query so far. */
  text?: TextProgress;
  /** Identifies the current text search, so a stale one stops and cannot overwrite a newer one. */
  scan: number;
  /** Waits for typing to pause before the text search starts. */
  timer?: ReturnType<typeof setTimeout>;
}

function toTreeEntry(entry: IndexedEntry): TreeEntry {
  return { name: entry.relative, path: entry.path, kind: entry.kind, depth: 0, state: "collapsed" };
}

function toHitEntry({ path, relative, line, text, at, length }: TextHit): TreeEntry {
  return { name: relative, path, kind: "file", depth: 0, state: "collapsed", match: { line, text, at, length } };
}

/** The prompt's line at the top of the file list: what is typed, then what it matches. */
function promptLine(query: string, status: string) {
  return styled([
    { text: "/ ", fg: theme.accent, bold: true },
    { text: query, fg: theme.text },
    { text: `   ${status}`, fg: theme.dim },
  ]);
}

function countText(total: number, noun: string, plural: string): string {
  return `${total.toLocaleString("en-US")} ${total === 1 ? noun : plural}`;
}

/** How a text search is going. Short, because the list it sits above is narrow. */
function textStatus(progress: TextProgress): string {
  if (!progress.done)
    return `searching ${progress.scanned.toLocaleString("en-US")}/${progress.total.toLocaleString("en-US")}`;
  if (!progress.hits.length) return "no matches";
  const count = countText(progress.hits.length, "match", "matches");
  if (!progress.truncated) return count;
  return progress.hits.length >= MAX_TEXT_HITS ? `first ${MAX_TEXT_HITS} matches` : `${count}+`;
}

/**
 * `/` over the file list: type to narrow the files under the folder, Enter to open one, Esc to go back. Tab switches
 * between matching file names and searching the text inside the files, keeping what is typed.
 */
export class FileFinder {
  readonly bar: TextRenderable;
  private finding?: Finding;

  constructor(
    context: RenderContext,
    private readonly host: FileFinderHost,
  ) {
    this.bar = new TextRenderable(context, {
      id: "find-bar",
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.bar.visible = false;
  }

  /** Whether the prompt is open, with its matches on screen in place of the tree. */
  get active(): boolean {
    return this.finding !== undefined;
  }

  async start(): Promise<void> {
    const root = this.host.rootPath();
    if (!root || this.finding) return;
    const finding: Finding = {
      mode: "files",
      query: "",
      truncated: false,
      returnTo: this.host.browser.selected()?.path,
      scan: 0,
    };
    this.finding = finding;
    this.host.footer.setPrompt("files");
    this.update();
    const { entries, truncated } = await indexTree(root, (path) => this.host.isIgnored(treeRelative(root, path)));
    if (this.host.isDestroyed() || this.finding !== finding) return;
    finding.entries = entries;
    finding.truncated = truncated;
    this.restartScan(finding);
    this.update();
  }

  /** Keys while the prompt is open. Ctrl and Alt chords are left alone, so Ctrl+C still quits. */
  handleKey(key: KeyEvent): boolean {
    const finding = this.finding;
    if (!finding || !isPlain(key)) return false;
    key.preventDefault();
    if (key.name === "escape") this.end();
    else if (key.name === "return") this.pick();
    else if (key.name === "tab") this.switchMode(finding);
    else if (key.name === "backspace") this.type(finding.query.slice(0, -1));
    else if (key.name === "up" || key.name === "down") this.moveHighlight(key.name === "up" ? -1 : 1);
    else if (isTyped(key)) this.type(finding.query + key.sequence);
    return true;
  }

  private moveHighlight(delta: number): void {
    this.host.browser.moveSelection(delta);
    if (this.finding?.mode === "text" && this.finding.text)
      this.host.preview(this.host.browser.selected(), this.finding.query);
  }

  private type(query: string): void {
    const finding = this.finding;
    if (!finding) return;
    finding.query = query;
    this.restartScan(finding);
    this.update();
  }

  private switchMode(finding: Finding): void {
    finding.mode = finding.mode === "files" ? "text" : "files";
    this.host.footer.setPrompt(finding.mode);
    this.restartScan(finding);
    this.update();
  }

  /** Drops any text search under way and, in text mode, starts a new one once typing pauses. */
  private restartScan(finding: Finding): void {
    finding.scan += 1;
    clearTimeout(finding.timer);
    finding.text = undefined;
    if (finding.mode !== "text" || !finding.entries || finding.query.length < MIN_TEXT_QUERY) return;
    finding.timer = setTimeout(() => void this.scan(finding), SCAN_DELAY_MS);
    finding.timer.unref?.();
  }

  private async scan(finding: Finding): Promise<void> {
    const { entries, query, scan } = finding;
    if (!entries) return;
    await searchText(entries, query, (progress) => {
      if (this.host.isDestroyed() || this.finding !== finding || finding.scan !== scan) return false;
      finding.text = progress;
      this.update();
      return true;
    });
  }

  /** Shows what is typed, and what it matches, or the whole tree while nothing is typed. */
  private update(): void {
    const finding = this.finding;
    if (!finding) return;
    this.bar.visible = true;
    if (!finding.query) this.showEmptyPrompt(finding);
    else if (!finding.entries) this.showIndexing(finding);
    else if (finding.mode === "files") this.showNames(finding, finding.entries);
    else this.showText(finding);
  }

  private showEmptyPrompt(finding: Finding): void {
    this.host.preview(undefined, "");
    const hint =
      finding.mode === "files" ? "type to find a file, Tab to search inside files" : "type to search inside files";
    this.bar.content = promptLine(finding.query, hint);
    this.host.showTree(this.host.browser.selected()?.path ?? finding.returnTo ?? this.host.rootPath() ?? "");
  }

  private showIndexing(finding: Finding): void {
    this.host.preview(undefined, "");
    this.bar.content = promptLine(finding.query, "indexing…");
    this.host.browser.show([], "");
  }

  private showNames(finding: Finding, entries: IndexedEntry[]): void {
    this.host.preview(undefined, "");
    const { matches, total } = matchEntries(entries, finding.query);
    const rows = matches.map(toTreeEntry);
    this.host.browser.show(rows, rows[0]?.path ?? "", (row) => this.host.styleOf(row));
    const count = total === 0 ? "no matches" : countText(total, "match", "matches");
    this.bar.content = promptLine(finding.query, finding.truncated ? `${count}, first 20,000 files` : count);
  }

  private showText(finding: Finding): void {
    const progress = finding.text;
    if (finding.query.length < MIN_TEXT_QUERY || !progress) {
      const short = finding.query.length < MIN_TEXT_QUERY;
      this.bar.content = promptLine(finding.query, short ? `type ${MIN_TEXT_QUERY}+ characters` : "searching…");
      this.host.browser.show([], "");
      // A short query matches nothing, but while the next results are on their way the last one stays in view.
      if (short) this.host.preview(undefined, "");
      return;
    }
    const rows = progress.hits.map(toHitEntry);
    // The highlight stays on the file it was on while results keep arriving.
    const kept = this.host.browser.selected()?.path;
    const selected = rows.some((row) => row.path === kept) ? kept : rows[0]?.path;
    this.host.browser.show(rows, selected ?? "", (row) => this.host.styleOf(row));
    this.bar.content = promptLine(finding.query, textStatus(progress));
    this.host.preview(this.host.browser.selected(), finding.query);
  }

  /** Closes the prompt, showing the tree with `select` (or the row it was opened from) highlighted. */
  private end(select?: string): void {
    const finding = this.finding;
    if (!finding) return;
    finding.scan += 1;
    clearTimeout(finding.timer);
    this.finding = undefined;
    this.bar.visible = false;
    this.host.preview(undefined, "");
    this.host.footer.setPrompt(undefined);
    this.host.showTree(select ?? finding.returnTo ?? this.host.rootPath() ?? "");
  }

  /** Enter, or a click on a row: hands the highlighted row to the host, which opens it. */
  pick(): void {
    const typed = this.finding?.query ?? "";
    const picked = this.host.browser.selected();
    this.end(picked?.path);
    if (picked) this.host.pick(picked, typed);
  }
}
