import type { CliRenderer } from "@opentui/core";

export type ClipboardWriter = (text: string) => Promise<boolean> | boolean;

function hostCommand(): string[] | undefined {
  if (process.platform === "darwin") return Bun.which("pbcopy") ? ["pbcopy"] : undefined;

  if (process.platform === "linux") {
    const candidates: string[][] = [];

    if (process.env.WAYLAND_DISPLAY) candidates.push(["wl-copy"]);

    candidates.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]);
    return candidates.find(([binary]) => binary && Bun.which(binary));
  }

  return undefined;
}

async function writeHostClipboard(text: string): Promise<boolean> {
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return false;

  const command = hostCommand();

  if (!command) return false;

  try {
    const child = Bun.spawn(command, {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

export async function copyToClipboard(renderer: CliRenderer, text: string): Promise<boolean> {
  const osc52 = renderer.copyToClipboardOSC52(text);
  const host = await writeHostClipboard(text);
  return osc52 || host;
}

export function copiedSummary(text: string): string {
  const lines = text.split("\n");

  if (lines.length > 1) return `Copied ${lines.length.toLocaleString("en-US")} lines.`;

  const length = [...text].length;
  return `Copied ${length.toLocaleString("en-US")} ${length === 1 ? "character" : "characters"}.`;
}
