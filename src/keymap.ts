export type KeyRow = [keys: string, action: string];

/**
 * Every key in the app, grouped as the `?` list and `--help` show them. This is the one place that says what a key
 * does; the README's table must only use keys that appear here (tests/keymap.test.ts).
 */
export const keySections: [title: string, rows: KeyRow[]][] = [
  [
    "Browse",
    [
      ["j k ↑ ↓", "move"],
      ["l → Enter", "open a file or folder"],
      ["h ← Backspace", "collapse a folder or go back"],
      ["/", "find a file by name; Tab: text in files"],
      ["-", "open the folder above"],
      ["gg G", "top / bottom"],
      ["Ctrl+← →", "resize the list, or drag its edge"],
    ],
  ],
  [
    "Reader",
    [
      ["j k", "scroll"],
      ["/", "search the file; Enter next, Esc keeps it for n N"],
      ["n N p", "next / previous match"],
      ["space b ^d ^u", "page / half a page"],
      ["gg G", "top / bottom"],
      ["120G", "go to line 120"],
      ["{ }", "previous / next paragraph"],
      ["z z", "centre the match, or the middle line"],
      ["w", "wrap long lines"],
      ["m", "Markdown: rendered / source"],
    ],
  ],
  [
    "Changes",
    [
      ["d", "show / hide the changes screen"],
      ["n N p", "next / previous hunk"],
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
      ["Ctrl+o Alt+i", "jump back / forward through opened places"],
      ["Esc", "clear a search, or back to the file list"],
      ["?", "this help (any key closes)"],
      ["q Ctrl+c", "quit"],
    ],
  ],
];

/** What the mouse does. Listed by `--help` only: the `?` list is for keys. */
export const mouseRows: KeyRow[] = [
  ["Left click", "open a file or toggle a folder"],
  ["Wheel", "scroll the pane under the pointer"],
  ["Drag edge", "resize the list"],
];

export const KEY_COLUMN = 15;

function formatRow([keys, action]: KeyRow): string {
  return `  ${keys.padEnd(KEY_COLUMN)}${action}`;
}

export function keyListText(): string {
  return [...keySections, ["Mouse", mouseRows] as const]
    .map(([title, rows]) => [title, ...rows.map(formatRow)].join("\n"))
    .join("\n\n");
}
