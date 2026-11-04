import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { theme } from "./theme";

const wordmark = ["╔═╗ ╔═╗ ╔═╗ ╦ ╦ ╔╦╗ ╔═╗ ╦═╗", "╚═╗ ║   ║ ║ ║ ║  ║  ║╣  ╠╦╝", "╚═╝ ╚═╝ ╚═╝ ╚═╝  ╩  ╚═╝ ╩╚═"];
const wordmarkColors = ["#a5b4fc", theme.accent, "#6366f1"];
const keyColor = theme.accentSoft;
const mutedColor = theme.muted;

const hints: [key: string, action: string][] = [
  ["j k  ↑ ↓", "move"],
  ["h l", "collapse or expand folder"],
  ["Enter", "open file or folder"],
  ["Tab", "switch pane"],
  ["Esc", "back to the file list"],
  ["g G", "top / bottom"],
  ["d", "changes in a git repository"],
  ["m", "Markdown: rendered / source"],
  ["w", "toggle word wrap"],
  ["Ctrl+← →", "resize, or drag the gap"],
  ["q", "quit"],
];

/** Empty state for the reader pane, centered both ways, shown until a file is opened. */
export function createWelcome(context: RenderContext): BoxRenderable {
  const welcome = new BoxRenderable(context, {
    id: "welcome",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    minWidth: 0,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  });
  const text = (content: string, fg: string, options: { marginTop?: number } = {}): TextRenderable =>
    new TextRenderable(context, {
      content,
      fg,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      ...options,
    });

  wordmark.forEach((row, index) => welcome.add(text(row, wordmarkColors[index]!)));
  welcome.add(text("a quiet, read-only file viewer", mutedColor, { marginTop: 1 }));
  welcome.add(text("Select a file and press Enter.", keyColor, { marginTop: 2 }));

  const keys = new BoxRenderable(context, { flexDirection: "column", flexShrink: 0, marginTop: 2 });
  for (const [key, action] of hints) {
    const row = new BoxRenderable(context, { flexDirection: "row", height: 1, flexShrink: 0 });
    row.add(text(key.padEnd(10), keyColor));
    row.add(text(action, mutedColor));
    keys.add(row);
  }
  welcome.add(keys);
  welcome.add(text("No editing. Just reading.", mutedColor, { marginTop: 2 }));
  return welcome;
}
