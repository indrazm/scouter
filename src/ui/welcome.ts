import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { version } from "../../package.json";
import { styled } from "./styled";
import { theme } from "./theme";
import type { Segment } from "./types";

const wordmark = ["█▀▀ █▀▀ █▀█ █ █ ▀█▀ █▀▀ █▀▄", "▀▀█ █   █ █ █ █  █  █▀▀ █▀▄", "▀▀▀ ▀▀▀ ▀▀▀ ▀▀▀  ▀  ▀▀▀ ▀ ▀"];

const hints: [key: string, action: string][] = [
  ["j k ↑ ↓", "move"],
  ["Enter", "open file or folder"],
  ["/", "find a file"],
  ["d", "changes in a git repository"],
  ["q", "quit"],
];

const KEY_COLUMN_WIDTH = 7;

export function createWelcome(context: RenderContext): BoxRenderable {
  const { wordmark: wordmarkColors, accentSoft, border, dim, ignored, muted, text } = theme;
  const welcome = new BoxRenderable(context, {
    id: "welcome",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    minWidth: 0,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  });
  const line = (content: Segment[] | string, fg?: string, marginTop = 0): TextRenderable =>
    new TextRenderable(context, {
      content: typeof content === "string" ? styled([{ text: content, fg }]) : styled(content),
      height: 1,
      flexShrink: 0,
      marginTop,
      wrapMode: "none",
      selectable: false,
    });

  wordmark.forEach((row, index) => welcome.add(line(row, wordmarkColors[index]!)));
  welcome.add(
    line(
      [
        { text: "a quiet, read-only file viewer", fg: muted },
        { text: `  v${version}`, fg: dim },
      ],
      undefined,
      1,
    ),
  );
  welcome.add(line("Select a file and press Enter.", accentSoft, 1));

  const card = new BoxRenderable(context, {
    flexDirection: "column",
    flexShrink: 0,
    marginTop: 1,
    paddingLeft: 2,
    paddingRight: 2,
    border: true,
    borderStyle: "rounded",
    borderColor: border,
  });
  for (const [key, action] of hints) {
    card.add(
      line([
        { text: key.padStart(KEY_COLUMN_WIDTH), fg: accentSoft, bold: true },
        { text: "  │  ", fg: border },
        { text: action, fg: text },
      ]),
    );
  }
  welcome.add(card);
  welcome.add(
    line(
      [
        { text: "Press ? for every key.", fg: accentSoft },
        { text: "  ·  ", fg: ignored },
        { text: "No editing. Just reading.", fg: dim },
      ],
      undefined,
      1,
    ),
  );
  return welcome;
}
