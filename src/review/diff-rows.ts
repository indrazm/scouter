import type { DiffRow } from "./types";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export function parseRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of patch.split("\n")) {
    if (oldLeft <= 0 && newLeft <= 0) {
      const header = HUNK_HEADER.exec(raw);

      if (header) {
        oldLine = Number(header[1]);
        oldLeft = Number(header[2] ?? 1);
        newLine = Number(header[3]);
        newLeft = Number(header[4] ?? 1);
      }

      continue;
    }

    const mark = raw[0];
    const text = raw.slice(1);

    if (mark === "+") {
      rows.push({ mark, line: newLine, text });
      newLine += 1;
      newLeft -= 1;
    } else if (mark === "-") {
      rows.push({ mark, line: oldLine, text });
      oldLine += 1;
      oldLeft -= 1;
    } else if (mark === " " || raw === "") {
      rows.push({ mark: " ", line: newLine, text });
      oldLine += 1;
      newLine += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  }

  return rows;
}
