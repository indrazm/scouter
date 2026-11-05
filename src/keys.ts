import type { KeyEvent } from "@opentui/core";

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
