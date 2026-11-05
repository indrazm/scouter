import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KEY_COLUMN, keyListText, keySections } from "../src/keymap";

const documented = new Set(keySections.flatMap(([, rows]) => rows.flatMap(([keys]) => keys.toLowerCase().split(" "))));

test("every key in the README's Keys table is one the app's key list documents", async () => {
  const readme = await readFile(join(import.meta.dir, "..", "README.md"), "utf8");
  const table = readme.slice(readme.indexOf("## Keys"), readme.indexOf("## Update or remove"));
  const keys = [...table.matchAll(/`([^`]+)`/g)].map((match) => match[1]?.toLowerCase() ?? "");
  expect(keys.length).toBeGreaterThan(10);
  expect(keys.filter((key) => !documented.has(key))).toEqual([]);
});

test("--help lists the same rows as the ? list", () => {
  const text = keyListText();
  for (const [title, rows] of keySections) {
    expect(text).toContain(title);
    for (const [keys, action] of rows) expect(text).toContain(`${keys.padEnd(KEY_COLUMN)}${action}`);
  }
});
