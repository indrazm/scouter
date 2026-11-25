import type { FiletypeParserOptions, TreeSitterClient } from "@opentui/core";
import { fileURLToPath } from "node:url";
import manifest from "../../grammars/manifest.json";

export const extraLanguages: readonly string[] = manifest.map((grammar) => grammar.filetype);

function parserFor(filetype: string): FiletypeParserOptions {
  const file = (name: string): string => fileURLToPath(new URL(`../../grammars/${filetype}/${name}`, import.meta.url));
  return {
    filetype,
    wasm: file(`tree-sitter-${filetype}.wasm`),
    queries: { highlights: [file("highlights.scm")] },
  };
}

export function registerGrammars(client: TreeSitterClient): void {
  for (const filetype of extraLanguages) client.addFiletypeParser(parserFor(filetype));
}
