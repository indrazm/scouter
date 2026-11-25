import { segmentsWidth } from "./styled";
import { theme } from "./theme";
import type { DiffScope, FooterFocus, FooterMode, FooterPrompt, Hint, Segment } from "./types";

export const HINT_GAP = "   ";

export const promptLabels: Record<FooterPrompt, string> = { files: "FIND", text: "TEXT", reader: "SEARCH" };

export const promptHints: Record<FooterPrompt, Hint[]> = {
  files: [
    ["type", "filter"],
    ["↑ ↓", "move"],
    ["Enter", "open"],
    ["Tab", "text"],
    ["Esc", "cancel"],
  ],
  text: [
    ["type", "search"],
    ["↑ ↓", "move"],
    ["Enter", "open"],
    ["Tab", "files"],
    ["Esc", "cancel"],
  ],
  reader: [
    ["type", "search"],
    ["Enter", "next"],
    ["↑ ↓", "prev / next"],
    ["Esc", "close"],
  ],
};

export const pillLabels: Record<FooterMode, Record<FooterFocus, string>> = {
  browse: { files: "FILES", reader: "READER" },
  diff: { files: "CHANGES", reader: "DIFF" },
};

export function hintsFor(
  mode: FooterMode,
  focus: FooterFocus,
  wrap: boolean,
  scope: DiffScope,
  rendered?: boolean,
  image = false,
): Hint[] {
  const pan: Hint[] = wrap ? [] : [["h l", "pan"]];

  if (mode === "diff") {
    const other: Hint = ["a", scope === "all" ? "one file" : "all files"];
    return focus === "files"
      ? [
          ["j k", "move"],
          ["Enter", "view"],
          ["o", "open file"],
          ["Tab", "diff"],
          ["s", "split"],
          other,
          ["d", "back"],
          ["^←→", "resize"],
          ["?", "help"],
          ["q", "quit"],
        ]
      : [
          ["j k", "scroll"],
          ["n N", "hunk"],
          ["o", "open file"],
          ["s", "split"],
          other,
          ["Tab", "files"],
          ["c", "fold"],
          ["x", "context"],
          ["y", "copy"],
          ["w", "wrap"],
          ...pan,
          ["gg G", "top/bottom"],
          ["^d ^u", "page"],
          ["d", "back"],
          ["?", "help"],
          ["q", "quit"],
        ];
  }

  if (image && focus !== "files") {
    return [
      ["Tab", "files"],
      ["d", "changes"],
      ["q", "quit"],
    ];
  }

  const view: Hint[] = rendered === undefined ? [] : [["m", rendered ? "source" : "preview"]];

  if (focus === "files") {
    return [
      ["j k", "move"],
      ["Enter", "open"],
      ["/", "find"],
      ["-", "up"],
      ["h", "back"],
      ["Tab", "reader"],
      ["d", "changes"],
      ["w", "wrap"],
      ["^←→", "resize"],
      ["^o alt+i", "jump"],
      ["?", "help"],
      ["q", "quit"],
    ];
  }

  const hints: Hint[] = [["j k", "scroll"]];

  if (!rendered) hints.push(...pan);

  hints.push(["gg G", "top/bottom"]);

  if (!rendered) hints.push(["{ }", "paragraph"]);

  hints.push(["z z", "centre"], ["^d ^u", "page"], ["Tab", "files"], ...view);

  if (!rendered) hints.push(["/", "search"]);

  hints.push(["y", "copy"], ["d", "changes"], ["^o alt+i", "jump"]);

  if (!rendered) hints.push(["w", "wrap"]);

  hints.push(["?", "help"], ["q", "quit"]);
  return hints;
}

export function fitHintList(hints: Hint[], columns: number): Segment[] {
  const segments: Segment[] = [];
  for (const [key, action] of hints) {
    const hint: Segment[] = [
      { text: key, fg: theme.accentSoft },
      { text: ` ${action}`, fg: theme.dim },
    ];
    const next = segments.length ? [...segments, { text: HINT_GAP }, ...hint] : hint;

    if (segmentsWidth(next) > columns) break;

    segments.splice(0, segments.length, ...next);
  }
  return segments;
}
