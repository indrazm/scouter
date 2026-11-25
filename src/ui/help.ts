import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { KEY_COLUMN, keySections } from "../core/keymap";
import { styled, type Segment } from "./styled";
import { theme } from "./theme";

interface HeadingStyle {
  fg?: string;
  bold?: boolean;
}

const LIST_ROWS = keySections.reduce((total, [, rows]) => total + 1 + rows.length, keySections.length - 1);
const CARD_CHROME_ROWS = 2;

export function createHelp(context: RenderContext, background: string): BoxRenderable {
  const overlay = new BoxRenderable(context, {
    id: "help",
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 2,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: background,
    onSizeChange: () => centre(),
  });
  const card = new BoxRenderable(context, {
    flexDirection: "column",
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.accent,
    title: " Keyboard Shortcuts ",
    titleAlignment: "center",
    titleColor: theme.accentSoft,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: background,
  });
  const centre = (): void => {
    card.marginTop = Math.max(0, Math.floor((overlay.height - (LIST_ROWS + CARD_CHROME_ROWS)) / 2));
  };
  const line = (content: Segment[] | string, style: HeadingStyle = {}): TextRenderable =>
    new TextRenderable(context, {
      content: typeof content === "string" ? content : styled(content),
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      ...style,
    });
  for (const [title, rows] of keySections) {
    card.add(line(title, { fg: theme.muted, bold: true }));
    for (const [key, action] of rows) {
      card.add(
        line([
          { text: `  ${key.padEnd(KEY_COLUMN)}`, fg: theme.accentSoft },
          { text: action, fg: theme.text },
        ]),
      );
    }

    if (title !== keySections.at(-1)?.[0]) card.add(line(""));
  }
  overlay.add(card);
  return overlay;
}
