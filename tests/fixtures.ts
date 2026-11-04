import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withDirectory(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "scouter-test-"));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

interface SpanSource {
  captureSpans(): { lines: { spans: { width: number; bg: { intent: string } }[] }[] };
}

/** Background intents of every rendered span that starts at or right of `fromX`, skipping the sidebar. */
export function backgroundIntentsFrom(setup: SpanSource, fromX: number, toY = Infinity): string[] {
  return setup.captureSpans().lines.slice(0, toY).flatMap((line) => {
    let x = 0;
    return line.spans.flatMap((span) => {
      const start = x;
      x += span.width;
      return start >= fromX ? [span.bg.intent] : [];
    });
  });
}

/** Runs git in `directory` with a fixed identity, throwing with git's own message on failure. */
export function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Initialises a repository in `directory` and, when given files, commits them as the first commit. */
export async function createRepository(directory: string, files: Record<string, string> = {}): Promise<void> {
  git(directory, "init", "--quiet");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await writeFile(join(directory, name), text);
  }
  if (Object.keys(files).length) {
    git(directory, "add", "--all");
    git(directory, "commit", "--quiet", "-m", "initial");
  }
}

/**
 * Renders until the screen contains `text`, sleeping between passes. For results that depend on real work
 * outside the renderer, such as git processes, which `waitForFrame`'s few quick passes would not outlast.
 */
export async function waitForText(
  setup: { renderOnce(): Promise<void>; captureCharFrame(): string }, text: string, timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await setup.renderOnce();
    if (setup.captureCharFrame().includes(text)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for "${text}". Last frame:\n${setup.captureCharFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
