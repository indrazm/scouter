import { expect, test } from "bun:test";
import { isTyped } from "../src/keys";

const press = (sequence: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => ({
  sequence,
  ctrl: false,
  meta: false,
  ...modifiers,
});

test("a typed character is one printable character, and an emoji counts as one", () => {
  for (const sequence of ["a", "É", "日", " ", "📄"]) expect(isTyped(press(sequence))).toBe(true);
});

test("control characters, chords and multi-character sequences are not typed text", () => {
  expect(isTyped(press("\u001b"))).toBe(false);
  expect(isTyped(press("\u007f"))).toBe(false);
  expect(isTyped(press("ab"))).toBe(false);
  expect(isTyped(press("a", { ctrl: true }))).toBe(false);
  expect(isTyped(press("a", { meta: true }))).toBe(false);
});
