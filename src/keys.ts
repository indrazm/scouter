import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";

export function isPlain(key: Pick<KeyEvent, "ctrl" | "meta">): boolean {
  return !key.ctrl && !key.meta;
}

export function isQuit(key: KeyEvent): boolean {
  return (key.name === "q" && isPlain(key)) || (key.name === "c" && key.ctrl);
}

/** An emoji counts as one printable character. */
export function isTyped(key: Pick<KeyEvent, "sequence" | "ctrl" | "meta">): boolean {
  const code = key.sequence.codePointAt(0) ?? 0;
  const length = code > 0xffff ? 2 : 1;
  return key.sequence.length === length && code >= 32 && code !== 127 && isPlain(key);
}

export function boundaryOf(key: KeyEvent): "start" | "end" | undefined {
  if (!["g", "home", "end"].includes(key.name)) return undefined;
  return key.shift || key.name === "end" ? "end" : "start";
}

interface MovableList {
  moveSelection(delta: number): void;
  readonly viewport: { height: number };
}

export function handleListKey(list: MovableList, key: KeyEvent): boolean {
  if (!isPlain(key)) return false;
  if (["j", "down", "k", "up"].includes(key.name)) {
    list.moveSelection((["k", "up"].includes(key.name) ? -1 : 1) * (key.shift ? 5 : 1));
    return true;
  }
  if (["pageup", "pagedown"].includes(key.name)) {
    list.moveSelection((key.name === "pageup" ? -1 : 1) * Math.max(1, list.viewport.height - 1));
    return true;
  }
  return false;
}

const PAN_COLUMNS = 4;
const PAN_KEYS = new Map([
  ["h", -PAN_COLUMNS],
  ["left", -PAN_COLUMNS],
  ["l", PAN_COLUMNS],
  ["right", PAN_COLUMNS],
]);
const SCROLL_KEYS = new Map([
  ["j", 1],
  ["down", 1],
  ["k", -1],
  ["up", -1],
]);
const PAGE_KEYS = new Map([
  ["pagedown", 0.9],
  ["space", 0.9],
  ["pageup", -0.9],
  ["b", -0.9],
]);

export function scrollByKey(pane: ScrollBoxRenderable, key: KeyEvent): boolean {
  if (key.meta) return false;
  if (key.ctrl) {
    if (key.name !== "u" && key.name !== "d") return false;
    key.preventDefault();
    pane.scrollBy(key.name === "u" ? -0.5 : 0.5, "viewport");
    return true;
  }
  const x = PAN_KEYS.get(key.name);
  const y = SCROLL_KEYS.get(key.name);
  const page = PAGE_KEYS.get(key.name);
  if (x === undefined && y === undefined && page === undefined) return false;
  key.preventDefault();
  if (page !== undefined) pane.scrollBy(page, "viewport");
  else pane.scrollBy({ x: x ?? 0, y: y ?? 0 });
  return true;
}
