import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { homedir } from "node:os";
import { displayLabel } from "../core/files";
import { HINT_GAP, fitHintList, hintsFor, pillLabels, promptHints, promptLabels } from "./footer-hints";
import { fitEnd, fitStart, segmentsWidth, styled } from "./styled";
import { theme } from "./theme";
import type { DiffInfo, DocumentInfo, FooterFocus, FooterMode, FooterPrompt, Segment } from "./types";

interface Fact {
  key: string;
  segments: Segment[];
}

const MIN_LOCATION_COLUMNS = 16;

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export class Footer {
  readonly root: BoxRenderable;
  private readonly band: BoxRenderable;
  private readonly left: TextRenderable;
  private readonly right: TextRenderable;
  private readonly hintRow: TextRenderable;
  private mode: FooterMode = "browse";
  private focus: FooterFocus = "files";
  private message?: { text: string; error: boolean };
  private location = "";
  private document?: DocumentInfo;
  private diff?: DiffInfo;
  private readonly positions: Record<FooterMode, string | undefined> = { browse: undefined, diff: undefined };
  private wrap = false;
  private prompt?: FooterPrompt;
  private pending?: number;
  private batchDepth = 0;
  private dirty = false;

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, {
      id: "footer",
      width: "100%",
      height: 2,
      flexDirection: "column",
      flexShrink: 0,
    });
    this.band = new BoxRenderable(renderer, {
      id: "status",
      width: "100%",
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.left = new TextRenderable(renderer, {
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.right = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: "none", selectable: false });
    this.hintRow = new TextRenderable(renderer, {
      id: "hints",
      height: 1,
      width: "100%",
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
    });
    this.band.add(this.left);
    this.band.add(this.right);
    this.root.add(this.band);
    this.root.add(this.hintRow);
    renderer.on("resize", this.render);
    renderer.once("destroy", () => renderer.off("resize", this.render));
    this.render();
  }

  batch(update: () => void): void {
    this.batchDepth += 1;
    try {
      update();
    } finally {
      this.batchDepth -= 1;

      if (this.batchDepth === 0 && this.dirty) {
        this.dirty = false;
        this.render();
      }
    }
  }

  restyle(): void {
    this.scheduleRender();
  }

  setBackground(color: string): void {
    this.band.backgroundColor = color;
    this.renderer.requestRender();
  }

  setMode(mode: FooterMode): void {
    if (mode === this.mode) return;

    this.mode = mode;
    this.message = undefined;
    this.scheduleRender();
  }

  setFocus(focus: FooterFocus): void {
    if (focus === this.focus) return;

    this.focus = focus;
    this.scheduleRender();
  }

  setLocation(path: string): void {
    const next = tildify(displayLabel(path));

    if (next === this.location && this.message === undefined) return;

    this.location = next;
    this.message = undefined;
    this.scheduleRender();
  }

  setMessage(text: string, error = false): void {
    if (this.message?.text === text && this.message.error === error) return;

    this.message = { text, error };
    this.scheduleRender();
  }

  clearMessage(): void {
    if (this.message === undefined) return;

    this.message = undefined;
    this.scheduleRender();
  }

  setDocument(document: DocumentInfo | undefined): void {
    this.document = document;

    if (!document) this.positions.browse = undefined;

    this.scheduleRender();
  }

  setDiff(diff: DiffInfo | undefined): void {
    this.diff = diff && { ...diff, location: displayLabel(diff.location) };

    if (!diff) this.positions.diff = undefined;

    this.scheduleRender();
  }

  setPosition(position: string | undefined): void {
    if (position === this.positions[this.mode]) return;

    this.positions[this.mode] = position;
    this.scheduleRender();
  }

  setWrap(wrap: boolean): void {
    if (wrap === this.wrap) return;

    this.wrap = wrap;
    this.scheduleRender();
  }

  setPending(count: number | undefined): void {
    if (count === this.pending) return;

    this.pending = count;
    this.scheduleRender();
  }

  setPrompt(prompt: FooterPrompt | undefined): void {
    if (prompt === this.prompt) return;

    this.prompt = prompt;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.batchDepth > 0) {
      this.dirty = true;
      return;
    }

    this.render();
  }

  private readonly render = (): void => {
    if (this.renderer.isDestroyed) return;

    const inner = Math.max(0, this.renderer.width - 2);
    const pill: Segment = {
      text: ` ${this.prompt ? promptLabels[this.prompt] : pillLabels[this.mode][this.focus]} `,
      fg: theme.accentInk,
      bg: theme.accent,
      bold: true,
    };
    const facts = this.fitFacts(inner - segmentsWidth([pill]) - 1 - MIN_LOCATION_COLUMNS);
    const factsWidth = segmentsWidth(facts);
    const room = Math.max(0, inner - segmentsWidth([pill]) - 1 - (factsWidth ? factsWidth + 2 : 0));
    this.left.content = styled([pill, { text: " " }, ...this.describe(room)]);
    this.right.content = styled(facts);
    this.hintRow.content = styled([{ text: " " }, ...this.fitHints(Math.max(0, this.renderer.width - 2))]);
    this.renderer.requestRender();
  };

  private describe(columns: number): Segment[] {
    if (this.message) {
      return [{ text: fitStart(this.message.text, columns), fg: this.message.error ? theme.error : theme.accentSoft }];
    }

    const shown = fitEnd(this.mode === "diff" ? (this.diff?.location ?? "") : this.location, columns);
    const cut = shown.lastIndexOf("/", shown.length - 2) + 1;
    return [
      { text: shown.slice(0, cut), fg: theme.dim },
      { text: shown.slice(cut), fg: theme.text },
    ];
  }

  private candidateFacts(): Fact[] {
    const facts: Fact[] = [];

    if (this.mode === "diff") {
      const diff = this.diff;

      if (diff) {
        const files = `${diff.files}${diff.truncated ? "+" : ""} ${diff.files === 1 && !diff.truncated ? "file" : "files"}`;
        facts.push({ key: "files", segments: [{ text: files, fg: theme.muted }] });

        if (diff.hunks !== undefined) {
          const label =
            diff.hunks > 1 && diff.hunkIndex !== undefined
              ? `${diff.hunkIndex}/${diff.hunks} hunks`
              : `${diff.hunks} ${diff.hunks === 1 ? "hunk" : "hunks"}`;
          facts.push({
            key: "hunks",
            segments: [{ text: label, fg: theme.muted }],
          });
        }

        if (diff.added !== undefined && diff.removed !== undefined) {
          facts.push({
            key: "counts",
            segments: [
              { text: `+${diff.added}`, fg: theme.added },
              { text: " " },
              { text: `−${diff.removed}`, fg: theme.removed },
            ],
          });
        }
      }
    } else if (this.document?.image) {
      const { width, height, format } = this.document.image;
      facts.push({ key: "size", segments: [{ text: `${width}×${height}`, fg: theme.muted }] });
      facts.push({ key: "language", segments: [{ text: format, fg: theme.muted }] });
    } else if (this.document?.binary) {
      facts.push({ key: "size", segments: [{ text: this.document.binary.size, fg: theme.muted }] });
      facts.push({ key: "language", segments: [{ text: "binary", fg: theme.muted }] });
    } else if (this.document) {
      const plus = this.document.truncated ? "+" : "";
      facts.push({ key: "lines", segments: [{ text: `${this.document.lines}${plus} lines`, fg: theme.muted }] });
      facts.push({ key: "language", segments: [{ text: this.document.language, fg: theme.muted }] });
      facts.push({ key: "encoding", segments: [{ text: "UTF-8", fg: theme.muted }] });
    }

    const position = this.positions[this.mode];

    if (position) facts.push({ key: "position", segments: [{ text: position, fg: theme.text }] });

    if (this.pending) facts.push({ key: "count", segments: [{ text: `${this.pending}`, fg: theme.accentSoft }] });

    return facts;
  }

  private fitFacts(columns: number): Segment[] {
    const facts = this.candidateFacts();
    const width = (): number =>
      facts.reduce(
        (total, fact, index) => total + segmentsWidth(fact.segments) + (index ? (fact.key === "count" ? 2 : 3) : 0),
        0,
      );
    for (const key of ["encoding", "language", "files", "lines", "size", "hunks", "counts", "position", "count"]) {
      if (width() <= columns) break;

      const index = facts.findIndex((fact) => fact.key === key);

      if (index >= 0) facts.splice(index, 1);
    }

    if (width() > columns) return [];

    const segments: Segment[] = [];
    for (const [index, fact] of facts.entries()) {
      if (index) {
        segments.push(fact.key === "count" ? { text: "  " } : { text: " · ", fg: theme.ignored });
      }

      segments.push(...fact.segments);
    }
    return segments;
  }

  private fitHints(columns: number): Segment[] {
    const hints = this.prompt
      ? promptHints[this.prompt]
      : hintsFor(
          this.mode,
          this.focus,
          this.wrap,
          this.diff?.scope ?? "all",
          this.document?.rendered,
          this.document?.image !== undefined,
        );
    const tail = fitHintList(
      hints.filter(([key]) => key === "q"),
      columns,
    );
    const head = fitHintList(
      hints.filter(([key]) => key !== "q"),
      columns - (tail.length ? segmentsWidth(tail) + HINT_GAP.length : 0),
    );

    if (!tail.length) return head;

    return head.length ? [...head, { text: HINT_GAP }, ...tail] : tail;
  }
}
