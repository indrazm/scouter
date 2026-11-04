import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { ScouterApp } from "../src/app";
import { languageFor } from "../src/code-view";
import manifest from "../grammars/manifest.json";
import { waitForFrame, withDirectory } from "./fixtures";

const grammars = join(import.meta.dir, "..", "grammars");
const PLAIN = "212,216,222";

/** A file name, some source, and a word in it that a highlighter must colour. */
const samples: [file: string, source: string, word: string][] = [
  ["data.json", '{"name": "scouter", "ok": true}\n', "true"],
  ["style.css", "a { color: red; }\n", "color"],
  ["page.html", '<div class="a">hi</div>\n', "div"],
  ["main.go", "package main\n\nfunc main() {}\n", "func"],
  ["lib.rs", "fn main() {\n    let x = 1;\n}\n", "fn"],
  ["tool.py", "def f(x):\n    return x\n", "def"],
  ["run.sh", 'if true; then echo "hi"; fi\n', "if"],
  ["config.yaml", "name: scouter\ncount: 3\n", "name"],
  ["Cargo.toml", '[package]\nname = "scouter"\n', "package"],
  ["main.c", "int main(void) {\n    return 0;\n}\n", "return"],
  ["App.java", "class App {\n    void run() {}\n}\n", "class"],
];

test("every vendored grammar is a language Scouter highlights, and is the file that was vendored", async () => {
  for (const [file] of samples) expect(languageFor(file)).toBeString();
  expect(samples.length).toBe(manifest.length);
  const hashes = await Promise.all(
    manifest.flatMap((grammar) => [
      readFile(join(grammars, grammar.wasm)).then((bytes) => [
        createHash("sha256").update(bytes).digest("hex"),
        grammar.wasmSha256,
      ]),
      readFile(join(grammars, grammar.filetype, "highlights.scm")).then((bytes) => [
        createHash("sha256").update(bytes).digest("hex"),
        grammar.highlightsSha256,
      ]),
    ]),
  );
  for (const [actual, expected] of hashes) expect(actual).toBe(expected);
});

for (const [file, source, word] of samples) {
  test(
    `highlights ${file}`,
    () =>
      withDirectory(async (directory) => {
        await writeFile(join(directory, file), source);
        await using setup = await createTestRenderer({ width: 100, height: 14 });
        await using app = new ScouterApp(setup.renderer);
        await app.open(join(directory, file));
        const coloured = (): boolean =>
          setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .some((span) => span.text.includes(word) && span.fg.toInts().slice(0, 3).join(",") !== PLAIN);
        await waitForFrame(setup, () => coloured(), `"${word}" to be highlighted in ${file}`, 10_000);
        expect(coloured()).toBe(true);
      }),
    20_000,
  );
}
