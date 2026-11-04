/** One palette for the whole interface so panes, header and footer never drift apart. */
export const theme = {
  text: "#d4d8de",
  muted: "#8b929c",
  dim: "#666d78",
  accent: "#818cf8",
  accentSoft: "#c7d2fe",
  /** Text on top of a solid accent background. */
  accentInk: "#0f1117",
  error: "#f2a1a1",
  hover: "#343a42",
  /** Meaning of a change, shared by the change list, the diff and the footer. */
  added: "#8fd3a8",
  removed: "#f2a1a1",
  modified: "#e5b880",
} as const;
