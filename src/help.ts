import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { styled, type Segment } from "./styled";
import { theme } from "./theme";

const sections: [title: string, keys: [key: string, action: string][]][] = [
  [
    "Browse",
    [
      ["j k ↑ ↓", "move"],
      ["l → Enter", "open a file or folder"],
      ["h ← Backspace", "collapse a folder or go back"],
      ["/", "find a file by name"],
      ["-", "open the folder above"],
      ["g G", "top / bottom"],
      ["Ctrl+← →", "resize the list, or drag its edge"],
    ],
  ],
  [
    "Reader",
    [
      ["j k", "scroll"],
      ["/", "search the file, then n p"],
      ["space b ^d ^u", "page / half a page"],
      ["g G", "top / bottom"],
      ["w", "wrap long lines"],
      ["m", "Markdown: rendered / source"],
    ],
  ],
  [
    "Changes (d)",
    [
      ["n p", "next / previous hunk"],
      ["a", "all files / one file"],
      ["s", "split / unified"],
      ["r", "reload"],
      ["o", "open the file at its first change"],
    ],
  ],
  [
    "Everywhere",
    [
      ["Tab", "switch panes"],
      ["Esc", "back to the file list"],
      ["?", "this help (any key closes)"],
      ["q Ctrl+c", "quit"],
    ],
  ],
];

/** Every key in the app, in one centred box over the panes. Any key press closes it. */
export function createHelp(context: RenderContext, background: string): BoxRenderable {
  const overlay = new BoxRenderable(context, {
    id: "help",
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    // A short terminal shows the first sections rather than smearing rows past its edges.
    overflow: "hidden",
    backgroundColor: background,
  });
  const keys = new BoxRenderable(context, { flexDirection: "column", flexShrink: 0 });
  const line = (content: Segment[] | string, options: Record<string, unknown> = {}): TextRenderable =>
    new TextRenderable(context, {
      content: typeof content === "string" ? content : styled(content),
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      ...options,
    });
  for (const [title, rows] of sections) {
    keys.add(line(title, { fg: theme.muted, bold: true }));
    for (const [key, action] of rows) {
      keys.add(
        line([
          { text: `  ${key.padEnd(15)}`, fg: theme.accentSoft },
          { text: action, fg: theme.text },
        ]),
      );
    }
    if (title !== sections.at(-1)?.[0]) keys.add(line(""));
  }
  overlay.add(keys);
  return overlay;
}
