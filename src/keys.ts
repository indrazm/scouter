import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";

/** A key pressed without Ctrl or Alt, so it is a command or a typed character rather than a chord. */
export function isPlain(key: Pick<KeyEvent, "ctrl" | "meta">): boolean {
  return !key.ctrl && !key.meta;
}

export function isQuit(key: KeyEvent): boolean {
  return (key.name === "q" && isPlain(key)) || (key.name === "c" && key.ctrl);
}

/** A key that types a character: one printable character (an emoji counts as one), without Ctrl or Alt. */
export function isTyped(key: Pick<KeyEvent, "sequence" | "ctrl" | "meta">): boolean {
  const code = key.sequence.codePointAt(0) ?? 0;
  const length = code > 0xffff ? 2 : 1;
  return key.sequence.length === length && code >= 32 && code !== 127 && isPlain(key);
}

/** `g` and Home go to the start; `G` (Shift) and End go to the end. Undefined for any other key. */
export function boundaryOf(key: KeyEvent): "start" | "end" | undefined {
  if (!["g", "home", "end"].includes(key.name)) return undefined;
  return key.shift || key.name === "end" ? "end" : "start";
}

/** What a list needs to offer for the keys that move its highlight. */
interface MovableList {
  moveSelection(delta: number): void;
  readonly viewport: { height: number };
}

/** The keys both lists share: j / k / arrows move (five rows with Shift), PageUp / PageDown move a screen. */
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

/** Columns a `h` / `l` press pans a pane by. */
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
/** Fractions of the viewport a paging key scrolls by. */
const PAGE_KEYS = new Map([
  ["pagedown", 0.9],
  ["space", 0.9],
  ["pageup", -0.9],
  ["b", -0.9],
]);

/**
 * Arrows and vim keys pan or scroll by a few cells, paging keys by most of the viewport, and Ctrl+U / Ctrl+D by half.
 * True when the key was one of them.
 */
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
