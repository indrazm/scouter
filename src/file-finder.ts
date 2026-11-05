import { TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core";
import type { FileExplorer, RowStyle } from "./explorer";
import type { TreeEntry } from "./file-tree";
import type { Footer } from "./footer";
import { isPlain, isTyped } from "./keys";
import { treeRelative } from "./marks";
import { indexTree, matchEntries, type IndexedEntry } from "./search";
import { styled } from "./styled";
import { theme } from "./theme";

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
  isDestroyed(): boolean;
}

/** What is typed, the files it can match once they are indexed, and the row to return to. */
interface Finding {
  query: string;
  entries?: IndexedEntry[];
  truncated: boolean;
  returnTo?: string;
}

function toTreeEntry(entry: IndexedEntry): TreeEntry {
  return { name: entry.relative, path: entry.path, kind: entry.kind, depth: 0, state: "collapsed" };
}

/** The prompt's line at the top of the file list: what is typed, then what it matches. */
function promptLine(query: string, status: string) {
  return styled([
    { text: "/ ", fg: theme.accent, bold: true },
    { text: query, fg: theme.text },
    { text: `   ${status}`, fg: theme.dim },
  ]);
}

/** `/` over the file list: type to narrow the files under the folder, Enter to open one, Esc to go back. */
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
    const finding: Finding = { query: "", truncated: false, returnTo: this.host.browser.selected()?.path };
    this.finding = finding;
    this.host.footer.setPrompt("files");
    this.update();
    const { entries, truncated } = await indexTree(root, (path) => this.host.isIgnored(treeRelative(root, path)));
    if (this.host.isDestroyed() || this.finding !== finding) return;
    finding.entries = entries;
    finding.truncated = truncated;
    this.update();
  }

  /** Keys while the prompt is open. Ctrl and Alt chords are left alone, so Ctrl+C still quits. */
  handleKey(key: KeyEvent): boolean {
    const finding = this.finding;
    if (!finding || !isPlain(key)) return false;
    key.preventDefault();
    if (key.name === "escape") this.end();
    else if (key.name === "return") this.pick();
    else if (key.name === "backspace") this.type(finding.query.slice(0, -1));
    else if (key.name === "up" || key.name === "down") this.host.browser.moveSelection(key.name === "up" ? -1 : 1);
    else if (isTyped(key)) this.type(finding.query + key.sequence);
    return true;
  }

  private type(query: string): void {
    if (!this.finding) return;
    this.finding.query = query;
    this.update();
  }

  /** Shows what is typed, and the files it matches, or the whole tree while nothing is typed. */
  private update(): void {
    const finding = this.finding;
    if (!finding) return;
    this.bar.visible = true;
    if (!finding.query) {
      this.bar.content = promptLine(finding.query, "type to find a file");
      this.host.showTree(this.host.browser.selected()?.path ?? finding.returnTo ?? this.host.rootPath() ?? "");
      return;
    }
    if (!finding.entries) {
      this.bar.content = promptLine(finding.query, "indexing…");
      this.host.browser.show([], "");
      return;
    }
    const { matches, total } = matchEntries(finding.entries, finding.query);
    const rows = matches.map(toTreeEntry);
    this.host.browser.show(rows, rows[0]?.path ?? "", (row) => this.host.styleOf(row));
    const count = total === 0 ? "no matches" : `${total.toLocaleString("en-US")} ${total === 1 ? "match" : "matches"}`;
    this.bar.content = promptLine(finding.query, finding.truncated ? `${count}, first 20,000 files` : count);
  }

  /** Closes the prompt, showing the tree with `select` (or the row it was opened from) highlighted. */
  private end(select?: string): void {
    const finding = this.finding;
    if (!finding) return;
    this.finding = undefined;
    this.bar.visible = false;
    this.host.footer.setPrompt(undefined);
    this.host.showTree(select ?? finding.returnTo ?? this.host.rootPath() ?? "");
  }

  private pick(): void {
    const typed = this.finding?.query ?? "";
    const picked = this.host.browser.selected();
    this.end(picked?.path);
    if (picked) this.host.pick(picked, typed);
  }
}
