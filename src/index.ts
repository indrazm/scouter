import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describeError } from "./files";

const help = `scouter — a minimal read-only terminal file viewer

Usage: bun run start [file-or-directory]

Defaults to the current directory. UTF-8 text files up to 1 MiB.

  hjkl / arrows  Navigate files or scroll text
  Enter          Open a file or toggle a folder
  l / Right      Expand a folder or select its first child
  h / Backspace  Collapse a folder or select its parent
  Tab            Switch panes
  w              Toggle word wrap
  d              Show or hide the git diff screen
  Escape         Return to the file pane
  g / G          Top / bottom
  Ctrl+u / d     Scroll half a page
  n / p          Next / previous hunk (diff screen)
  s              Split or unified diff (diff screen)
  r              Reload changes (diff screen)
  q / Ctrl+c     Quit
  Left click     Open a file or toggle a folder
  Mouse wheel    Scroll the pane under the pointer
  Drag sidebar edge Resize the sidebar
  Ctrl+Left/Right Resize the sidebar with the keyboard
`;

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return;
  }
  if (args.length > 1) throw new Error("Expected one file or directory. Use --help for usage.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run Scouter in an interactive terminal.");
  const path = resolve(args[0] ?? process.cwd());
  const metadata = await stat(path);
  if (!metadata.isFile() && !metadata.isDirectory()) throw new Error("Only files and directories can be opened.");
  const { createCliRenderer, RGBA } = await import("@opentui/core");
  const { ScouterApp } = await import("./app");
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    backgroundColor: RGBA.defaultBackground(),
    consoleMode: "disabled",
    useMouse: true,
  });
  try {
    await using app = new ScouterApp(renderer);
    await app.open(path);
    await renderer.closed;
  } finally {
    renderer.destroy();
    await renderer.closed;
  }
}

main().catch((error: unknown) => {
  console.error(`scouter: ${describeError(error)}`);
  process.exitCode = 1;
});
