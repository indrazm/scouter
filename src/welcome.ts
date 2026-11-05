import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { theme } from "./theme";

const wordmark = ["╔═╗ ╔═╗ ╔═╗ ╦ ╦ ╔╦╗ ╔═╗ ╦═╗", "╚═╗ ║   ║ ║ ║ ║  ║  ║╣  ╠╦╝", "╚═╝ ╚═╝ ╚═╝ ╚═╝  ╩  ╚═╝ ╩╚═"];

const hints: [key: string, action: string][] = [
  ["j k  ↑ ↓", "move"],
  ["Enter", "open file or folder"],
  ["/", "find a file"],
  ["d", "changes in a git repository"],
  ["q", "quit"],
];

/** Empty state for the reader pane, centered both ways, shown until a file is opened. */
export function createWelcome(context: RenderContext): BoxRenderable {
  const { wordmark: wordmarkColors, accentSoft: keyColor, muted: mutedColor } = theme;
  const welcome = new BoxRenderable(context, {
    id: "welcome",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    minWidth: 0,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    // A short terminal shows the first hints rather than smearing them over the footer.
    overflow: "hidden",
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
  welcome.add(text("Press ? for every key.", keyColor, { marginTop: 2 }));
  welcome.add(text("No editing. Just reading.", mutedColor, { marginTop: 1 }));
  return welcome;
}
