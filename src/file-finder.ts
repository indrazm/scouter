import { BoxRenderable, TextRenderable, type KeyEvent, type RenderContext } from "@opentui/core";
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

const MIN_TEXT_QUERY = 2;
const SCAN_DELAY_MS = 150;

interface FileFinderHost {
  browser: FileExplorer;
  footer: Footer;
  rootPath(): string | undefined;
  isIgnored(relativePath: string): boolean;
  styleOf(entry: TreeEntry): RowStyle;
  showTree(selectedPath: string): void;
  pick(picked: TreeEntry, typed: string): void;
  preview(entry: TreeEntry | undefined, query: string): void;
  isDestroyed(): boolean;
}

type FindMode = "files" | "text";

interface Finding {
  mode: FindMode;
  query: string;
  entries?: IndexedEntry[];
  truncated: boolean;
  returnTo?: string;
  text?: TextProgress;
  shownText?: { scan: number; hits: number };
  scan: number;
  timer?: ReturnType<typeof setTimeout>;
}

function toTreeEntry(entry: IndexedEntry): TreeEntry {
  return { name: entry.relative, path: entry.path, kind: entry.kind, depth: 0, state: "collapsed" };
}

function toHitEntry({ path, relative, line, text, at, length }: TextHit): TreeEntry {
  return { name: relative, path, kind: "file", depth: 0, state: "collapsed", match: { line, text, at, length } };
}

function promptLine(mode: FindMode, query: string, status: string) {
  return styled([
    { text: mode === "files" ? "/ " : "≡ ", fg: theme.accent, bold: true },
    { text: query, fg: theme.text },
    { text: "▎", fg: theme.accent },
    { text: `  ${status}`, fg: theme.dim },
  ]);
}

function countText(total: number, noun: string, plural: string): string {
  return `${total.toLocaleString("en-US")} ${total === 1 ? noun : plural}`;
}

function textStatus(progress: TextProgress): string {
  if (!progress.done)
    return `searching ${progress.scanned.toLocaleString("en-US")}/${progress.total.toLocaleString("en-US")}`;

  if (!progress.hits.length) return "no matches";

  const count = countText(progress.hits.length, "match", "matches");

  if (!progress.truncated) return count;

  return progress.hits.length >= MAX_TEXT_HITS ? `first ${MAX_TEXT_HITS} matches` : `${count}+`;
}

export class FileFinder {
  readonly bar: BoxRenderable;
  private readonly text: TextRenderable;
  private finding?: Finding;
  private line: { mode: FindMode; query: string; status: string } = { mode: "files", query: "", status: "" };

  constructor(
    context: RenderContext,
    private readonly host: FileFinderHost,
  ) {
    this.bar = new BoxRenderable(context, {
      id: "find-bar",
      height: 2,
      width: "100%",
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      border: ["bottom"],
      borderColor: theme.border,
    });
    this.text = new TextRenderable(context, {
      height: 1,
      width: "100%",
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.bar.add(this.text);
    this.bar.visible = false;
  }

  restyle(): void {
    this.bar.borderColor = theme.border;
    this.text.content = promptLine(this.line.mode, this.line.query, this.line.status);
  }

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

  private restartScan(finding: Finding): void {
    finding.scan += 1;
    clearTimeout(finding.timer);
    finding.text = undefined;
    finding.shownText = undefined;

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

  private say(query: string, status: string): void {
    this.line = { mode: this.finding?.mode ?? "files", query, status };
    this.restyle();
  }

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
    this.say(finding.query, hint);
    this.host.showTree(this.host.browser.selected()?.path ?? finding.returnTo ?? this.host.rootPath() ?? "");
  }

  private showIndexing(finding: Finding): void {
    this.host.preview(undefined, "");
    this.say(finding.query, "indexing…");
    this.host.browser.show([], "");
  }

  private showNames(finding: Finding, entries: IndexedEntry[]): void {
    this.host.preview(undefined, "");
    const { matches, total } = matchEntries(entries, finding.query);
    const rows = matches.map(toTreeEntry);
    this.host.browser.show(rows, rows[0]?.path ?? "", (row) => this.host.styleOf(row));
    const count = total === 0 ? "no matches" : countText(total, "match", "matches");
    this.say(finding.query, finding.truncated ? `${count}, first 20,000 files` : count);
  }

  private showText(finding: Finding): void {
    const progress = finding.text;

    if (finding.query.length < MIN_TEXT_QUERY || !progress) {
      const short = finding.query.length < MIN_TEXT_QUERY;
      finding.shownText = undefined;
      this.say(finding.query, short ? `type ${MIN_TEXT_QUERY}+ characters` : "searching…");
      this.host.browser.show([], "");

      if (short) this.host.preview(undefined, "");

      return;
    }

    const unchangedHits = finding.shownText?.scan === finding.scan && finding.shownText.hits === progress.hits.length;
    this.say(finding.query, textStatus(progress));

    if (unchangedHits) return;

    finding.shownText = { scan: finding.scan, hits: progress.hits.length };
    const rows = progress.hits.map(toHitEntry);
    const kept = this.host.browser.selected()?.path;
    const selected = rows.some((row) => row.path === kept) ? kept : rows[0]?.path;
    this.host.browser.show(rows, selected ?? "", (row) => this.host.styleOf(row));
    this.host.preview(this.host.browser.selected(), finding.query);
  }

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

  pick(): void {
    const typed = this.finding?.query ?? "";
    const picked = this.host.browser.selected();
    this.end(picked?.path);

    if (picked) this.host.pick(picked, typed);
  }
}
