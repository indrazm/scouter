import zlib from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRenderable, RGBA, type Renderable } from "@opentui/core";

/** Records every change to a pane's border color, leaving the real getter and setter in charge. */
export function watchBorder(root: Renderable, id: string, writes: string[]): void {
  const panel = root.findDescendantById(id);
  if (!(panel instanceof BoxRenderable)) throw new Error(`No ${id}.`);
  const accessor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(panel), "borderColor");
  if (!accessor?.get || !accessor.set) throw new Error("No borderColor accessor.");
  let current = panel.borderColor.toInts().join(",");
  Object.defineProperty(panel, "borderColor", {
    configurable: true,
    get(this: BoxRenderable) {
      return accessor.get!.call(this);
    },
    set(this: BoxRenderable, value: string | RGBA) {
      const next = (typeof value === "string" ? RGBA.fromHex(value) : value).toInts().join(",");
      if (next !== current) writes.push(`${id} -> ${next}`);
      current = next;
      accessor.set!.call(this, value);
    },
  });
}

/** The border color of a pane, as a comparable string. */
export function borderColorOf(root: Renderable, id: string): string {
  const panel = root.findDescendantById(id);
  if (!(panel instanceof BoxRenderable)) throw new Error(`No ${id}.`);
  return panel.borderColor.toInts().join(",");
}

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
  return setup
    .captureSpans()
    .lines.slice(0, toY)
    .flatMap((line) => {
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
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Initialises a repository in `directory` and, when given files, commits them as the first commit. */
export async function createRepository(directory: string, files: Record<string, string> = {}): Promise<void> {
  git(directory, "init", "--quiet");
  await Promise.all(
    Object.entries(files).map(async ([name, text]) => {
      await mkdir(join(directory, name, ".."), { recursive: true });
      await writeFile(join(directory, name), text);
    }),
  );
  if (Object.keys(files).length) {
    git(directory, "add", "--all");
    git(directory, "commit", "--quiet", "-m", "initial");
  }
}

type Frames = { renderOnce(): Promise<void>; captureCharFrame(): string };

/**
 * Renders until the screen contains `text`, sleeping between passes. For results that depend on real work
 * outside the renderer, such as git processes, which `waitForFrame`'s few quick passes would not outlast.
 */
export async function waitForText(setup: Frames, text: string, timeoutMs = 5000): Promise<void> {
  await waitForFrame(setup, (frame) => frame.includes(text), `"${text}"`, timeoutMs);
}

/** Like `waitForText`, for anything a frame can satisfy, such as some text having gone away. */
export async function waitForFrame(
  setup: Frames,
  satisfied: (frame: string) => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Polling: each pass must finish before the next frame is looked at.
  /* oxlint-disable no-await-in-loop */
  while (true) {
    await setup.renderOnce();
    if (satisfied(setup.captureCharFrame())) return;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${description}. Last frame:\n${setup.captureCharFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  /* oxlint-enable no-await-in-loop */
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour PNG, built by hand so tests need no image files. */
export function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, no interlace
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat()),
  ]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixels),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
