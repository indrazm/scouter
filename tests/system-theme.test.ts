import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { SystemThemeWatcher, type SystemTheme, type ThemeSource } from "../src/system-theme";
import type { ThemeMode } from "../src/theme";

/** A terminal whose answers the test hands out one at a time, or refuses to give at all. */
class FakeTerminal implements ThemeSource {
  themeMode: ThemeMode | null = null;
  asked = 0;
  private readonly events = new EventEmitter();
  private readonly waiting: ((answer: string | Error) => void)[] = [];
  private onQuestion?: () => void;

  on(_event: "theme_mode", listener: (mode: ThemeMode) => void): void {
    this.events.on("theme_mode", listener);
  }

  off(_event: "theme_mode", listener: (mode: ThemeMode) => void): void {
    this.events.off("theme_mode", listener);
  }

  clearPaletteCache(): void {}

  getPalette(): Promise<{ defaultBackground: string | null }> {
    this.asked += 1;
    return new Promise((resolve, reject) => {
      this.waiting.push((answer) =>
        answer instanceof Error ? reject(answer) : resolve({ defaultBackground: answer }),
      );
      this.onQuestion?.();
    });
  }

  /** Answers the oldest (or the newest) question not yet answered, waiting for one to be asked if there is none. */
  async answer(background: string | Error, which: "oldest" | "newest" = "oldest"): Promise<void> {
    if (this.waiting.length === 0) await new Promise<void>((resolve) => (this.onQuestion = resolve));
    (which === "oldest" ? this.waiting.shift() : this.waiting.pop())?.(background);
  }

  announce(mode: ThemeMode): void {
    this.events.emit("theme_mode", mode);
  }
}

/** Lets everything that can run without waiting on a timer or the terminal run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function watch(terminal: FakeTerminal, pollMs = 5): { seen: SystemTheme[]; watcher: SystemThemeWatcher } {
  const seen: SystemTheme[] = [];
  const watcher = new SystemThemeWatcher(terminal, (theme) => seen.push(theme), pollMs);
  watcher.start();
  return { seen, watcher };
}

test("the first reading is always reported, as dark when the terminal will not say", async () => {
  const terminal = new FakeTerminal();
  const { seen, watcher } = watch(terminal);
  await terminal.answer(new Error("no terminal"));
  await settle();
  expect(seen).toEqual([{ mode: "dark" }]);
  watcher.stop();
});

test("the mode comes from how bright the background is, and only a different reading is reported again", async () => {
  const terminal = new FakeTerminal();
  const { seen, watcher } = watch(terminal);
  await terminal.answer("#ffffff");
  await terminal.answer("#ffffff");
  await terminal.answer("#101010");
  await settle();
  expect(seen).toEqual([
    { mode: "light", background: "#ffffff" },
    { mode: "dark", background: "#101010" },
  ]);
  watcher.stop();
});

test("a slow answer that arrives after a newer one does not undo it", async () => {
  const terminal = new FakeTerminal();
  const { seen, watcher } = watch(terminal);
  // The first question is still unanswered when the terminal announces a change; that second question is answered
  // first, and the first, now out of date, is answered after it.
  terminal.announce("light");
  await settle();
  expect(terminal.asked).toBe(2);
  await terminal.answer("#ffffff", "newest");
  await terminal.answer("#101010");
  await settle();
  expect(seen).toEqual([{ mode: "light", background: "#ffffff" }]);
  watcher.stop();
});

test("a terminal that does not answer is not asked again", async () => {
  const terminal = new FakeTerminal();
  const { watcher } = watch(terminal);
  await terminal.answer(new Error("no answer"));
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(terminal.asked).toBe(1);
  watcher.stop();
});

test("a terminal that announces a change stops being asked, even for an answer still on its way", async () => {
  const terminal = new FakeTerminal();
  const { seen, watcher } = watch(terminal);
  terminal.announce("dark");
  await terminal.answer("#101010", "newest");
  await terminal.answer("#101010");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(terminal.asked).toBe(2);
  expect(seen).toEqual([{ mode: "dark", background: "#101010" }]);
  watcher.stop();
});
