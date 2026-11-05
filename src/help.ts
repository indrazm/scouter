import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { KEY_COLUMN, keySections } from "./keymap";
import { styled, type Segment } from "./styled";
import { theme } from "./theme";

interface HeadingStyle {
  fg?: string;
  bold?: boolean;
}

/** A title and its rows for each section, with a blank row between sections. */
const LIST_ROWS = keySections.reduce((total, [, rows]) => total + 1 + rows.length, keySections.length - 1);

/**
 * Every key in the app, in one box over the panes: centred while it fits, pinned to the top when it does not.
 * Any key press closes it.
 */
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
    // A short terminal shows the first sections rather than smearing rows past its edges.
    overflow: "hidden",
    backgroundColor: background,
    onSizeChange: () => centre(),
  });
  const keys = new BoxRenderable(context, { flexDirection: "column", flexShrink: 0 });
  // Centred while it fits; once it does not, it starts at the top so the first sections are the ones that show.
  const centre = (): void => {
    keys.marginTop = Math.max(0, Math.floor((overlay.height - LIST_ROWS) / 2));
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
    keys.add(line(title, { fg: theme.muted, bold: true }));
    for (const [key, action] of rows) {
      keys.add(
        line([
          { text: `  ${key.padEnd(KEY_COLUMN)}`, fg: theme.accentSoft },
          { text: action, fg: theme.text },
        ]),
      );
    }
    if (title !== keySections.at(-1)?.[0]) keys.add(line(""));
  }
  overlay.add(keys);
  return overlay;
}
