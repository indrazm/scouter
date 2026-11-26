import type { KeyEvent } from "@opentui/core";
import { displayText } from "../core/files";
import { isPlain, isTyped } from "../core/keys";
import type { Footer } from "../ui/footer";
import type { CommentTarget } from "./types";

interface CommentPromptHost {
  footer: Footer;
  draw(target: CommentTarget, text: string, cursor: number): void;
  hide(): void;
  save(target: CommentTarget, text: string): void;
}

interface Draft {
  target: CommentTarget;
  text: string;
  cursor: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function prevCodePoint(text: string, index: number): number {
  if (index <= 0) return 0;

  if (index >= 2 && isLowSurrogate(text.charCodeAt(index - 1)) && isHighSurrogate(text.charCodeAt(index - 2))) {
    return index - 2;
  }

  return index - 1;
}

function nextCodePoint(text: string, index: number): number {
  if (index >= text.length) return text.length;

  if (
    index + 1 < text.length &&
    isHighSurrogate(text.charCodeAt(index)) &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return index + 2;
  }

  return index + 1;
}

function codePointCount(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = from; at < to; at = nextCodePoint(text, at)) count += 1;
  return count;
}

function advanceCodePoints(text: string, from: number, limit: number, count: number): number {
  let at = from;
  for (let step = 0; step < count && at < limit; step += 1) at = nextCodePoint(text, at);
  return Math.min(at, limit);
}

function previousWordStart(text: string, cursor: number): number {
  let at = cursor;
  while (at > 0 && /[^\S\n]/.test(text[at - 1] ?? "")) at = prevCodePoint(text, at);

  if (at > 0 && text[at - 1] === "\n") return at - 1;

  while (at > 0 && !/\s/.test(text[at - 1] ?? "")) at = prevCodePoint(text, at);
  return at;
}

function lineStartOf(text: string, cursor: number): number {
  if (cursor <= 0) return 0;

  const newline = text.lastIndexOf("\n", cursor - 1);
  return newline < 0 ? 0 : newline + 1;
}

function lineEndOf(text: string, cursor: number): number {
  const newline = text.indexOf("\n", cursor);
  return newline < 0 ? text.length : newline;
}

function moveVertical(text: string, cursor: number, direction: -1 | 1): number {
  const start = lineStartOf(text, cursor);
  const column = codePointCount(text, start, cursor);

  if (direction < 0) {
    if (start === 0) return 0;

    const prevEnd = start - 1;
    const prevStart = lineStartOf(text, prevEnd);
    return advanceCodePoints(text, prevStart, prevEnd, column);
  }

  const end = lineEndOf(text, cursor);

  if (end >= text.length) return text.length;

  const nextStart = end + 1;
  const nextEnd = lineEndOf(text, nextStart);
  return advanceCodePoints(text, nextStart, nextEnd, column);
}

function isReturnKey(name: string): boolean {
  return name === "return" || name === "kpenter";
}

export class CommentPrompt {
  private draft?: Draft;

  constructor(private readonly host: CommentPromptHost) {}

  get prompting(): boolean {
    return this.draft !== undefined;
  }

  start(target: CommentTarget, text: string): void {
    this.draft = { target, text, cursor: text.length };
    this.host.footer.clearMessage();
    this.host.footer.setPrompt("comment");
    this.show();
  }

  cancel(): void {
    if (this.draft) this.close(false);
  }

  handlePaste(raw: string): boolean {
    const draft = this.draft;

    if (!draft) return false;

    const clean = displayText(raw).replace(/\t/g, "    ");

    if (!clean) return true;

    this.insert(draft, clean);
    this.show();
    return true;
  }

  handleKey(key: KeyEvent): boolean {
    const draft = this.draft;

    if (!draft) return false;

    if (key.ctrl && !key.meta && key.name === "c") return false;

    key.preventDefault();

    if (key.ctrl && !key.meta) this.handleCtrl(draft, key);
    else if (key.meta && !key.ctrl) this.handleMeta(draft, key);
    else if (isPlain(key)) this.handlePlain(draft, key);

    if (this.draft) this.show();

    return true;
  }

  private insert(draft: Draft, text: string): void {
    draft.text = `${draft.text.slice(0, draft.cursor)}${text}${draft.text.slice(draft.cursor)}`;
    draft.cursor += text.length;
  }

  private deleteBackward(draft: Draft): void {
    if (draft.cursor <= 0) return;

    const prev = prevCodePoint(draft.text, draft.cursor);
    draft.text = `${draft.text.slice(0, prev)}${draft.text.slice(draft.cursor)}`;
    draft.cursor = prev;
  }

  private deleteForward(draft: Draft): void {
    if (draft.cursor >= draft.text.length) return;

    const next = nextCodePoint(draft.text, draft.cursor);
    draft.text = `${draft.text.slice(0, draft.cursor)}${draft.text.slice(next)}`;
  }

  private handlePlain(draft: Draft, key: KeyEvent): void {
    if (key.name === "escape") {
      this.close(false);
    } else if (key.name === "linefeed" || (isReturnKey(key.name) && key.shift)) {
      this.insert(draft, "\n");
    } else if (isReturnKey(key.name)) {
      this.close(true);
    } else if (key.name === "left") {
      draft.cursor = prevCodePoint(draft.text, draft.cursor);
    } else if (key.name === "right") {
      draft.cursor = nextCodePoint(draft.text, draft.cursor);
    } else if (key.name === "up") {
      draft.cursor = moveVertical(draft.text, draft.cursor, -1);
    } else if (key.name === "down") {
      draft.cursor = moveVertical(draft.text, draft.cursor, 1);
    } else if (key.name === "home") {
      draft.cursor = lineStartOf(draft.text, draft.cursor);
    } else if (key.name === "end") {
      draft.cursor = lineEndOf(draft.text, draft.cursor);
    } else if (key.name === "backspace") {
      this.deleteBackward(draft);
    } else if (key.name === "delete") {
      this.deleteForward(draft);
    } else if (isTyped(key)) {
      this.insert(draft, key.sequence);
    }
  }

  private handleCtrl(draft: Draft, key: KeyEvent): void {
    if (key.name === "j") {
      this.insert(draft, "\n");
    } else if (key.name === "a") {
      draft.cursor = lineStartOf(draft.text, draft.cursor);
    } else if (key.name === "e") {
      draft.cursor = lineEndOf(draft.text, draft.cursor);
    } else if (key.name === "u") {
      const start = lineStartOf(draft.text, draft.cursor);
      const cut = start === draft.cursor && start > 0 ? start - 1 : start;
      draft.text = `${draft.text.slice(0, cut)}${draft.text.slice(draft.cursor)}`;
      draft.cursor = cut;
    } else if (key.name === "k") {
      const end = lineEndOf(draft.text, draft.cursor);
      const cut = end === draft.cursor && end < draft.text.length ? end + 1 : end;
      draft.text = `${draft.text.slice(0, draft.cursor)}${draft.text.slice(cut)}`;
    } else if (key.name === "w") {
      const start = previousWordStart(draft.text, draft.cursor);
      draft.text = `${draft.text.slice(0, start)}${draft.text.slice(draft.cursor)}`;
      draft.cursor = start;
    } else if (key.name === "d") {
      this.deleteForward(draft);
    }
  }

  private handleMeta(draft: Draft, key: KeyEvent): void {
    if (isReturnKey(key.name)) {
      this.insert(draft, "\n");
    } else if (key.name === "backspace") {
      const start = previousWordStart(draft.text, draft.cursor);
      draft.text = `${draft.text.slice(0, start)}${draft.text.slice(draft.cursor)}`;
      draft.cursor = start;
    }
  }

  private close(save: boolean): void {
    const draft = this.draft;
    this.draft = undefined;
    this.host.footer.setPrompt(undefined);
    this.host.hide();

    if (draft && save) this.host.save(draft.target, draft.text.trim());
  }

  private show(): void {
    if (this.draft) this.host.draw(this.draft.target, this.draft.text, this.draft.cursor);
  }
}
