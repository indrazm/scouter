import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describeError } from "./files";
import { version } from "../package.json";

const help = `scouter — a minimal read-only terminal file viewer

Usage: scouter [file-or-directory]
       scouter --version
       scouter --upgrade     update to the newest release (installed command only)

Defaults to the current directory. UTF-8 text files show their first megabyte.

  hjkl / arrows  Navigate files or scroll text
  Enter          Open a file or toggle a folder
  l / Right      Expand a folder or select its first child
  h / Backspace  Collapse a folder or select its parent
  -              Open the folder above
  /              Find a file, or search the open file
  n / p          Next search match, or next hunk (changes screen)
  Space / b      Page down / up in the reader
  g / G          Top / bottom
  Tab            Switch panes
  w              Toggle word wrap
  m              Markdown: rendered / source
  d              Show or hide the changes screen (press again to cancel a slow read)
  s              Split or unified diff (changes screen)
  a              All files or the highlighted one (changes screen)
  r              Reload changes (changes screen)
  o              Open the changed file at its first change (changes screen)
  ?              Show every key
  Escape         Cancel a prompt, or return to the file pane
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
  if (args.includes("--upgrade")) {
    throw new Error(
      "--upgrade is for the installed command. Install Scouter with install.sh, then run: scouter --upgrade",
    );
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`scouter ${version}`);
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
