import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "link" | "other";
}

export interface Document {
  path: string;
  text: string;
  lineCount: number;
}

export function displayText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // Matching control characters is the point of this expression.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�")
  );
}

export function describeError(error: unknown): string {
  return displayLabel(error instanceof Error ? error.message : "Unable to open this path.");
}

export function displayLabel(text: string): string {
  return displayText(text).replace(/[\n\t]/g, " ");
}

/**
 * Entries that are almost never what you opened a folder to read: version-control internals and files an
 * operating system scatters around. Other dotfiles, such as `.gitignore` or `.env`, are still listed.
 */
const NOISE = new Set([".git", ".hg", ".svn", ".DS_Store", ".AppleDouble", "Thumbs.db", "desktop.ini"]);

export async function readDirectory(path: string): Promise<DirectoryEntry[]> {
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => !NOISE.has(entry.name))
    .map((entry): DirectoryEntry => ({
      name: entry.name,
      path: join(path, entry.name),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other",
    }));
  entries.sort((left, right) => {
    const directoryOrder = Number(right.kind === "directory") - Number(left.kind === "directory");
    return directoryOrder || left.name.localeCompare(right.name);
  });
  return entries;
}

export async function readDocument(path: string): Promise<Document> {
  // Non-blocking open lets us reject pipes and devices without waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Only regular text files can be viewed.");
    if (metadata.size > MAX_FILE_BYTES) throw new Error("File is too large (limit: 1 MiB).");
    const bytes = await readBounded(file);
    if (bytes.includes(0)) throw new Error("Binary files are not supported.");
    const text = displayText(decodeText(bytes)).replace(/\t/g, "    ");
    return { path, text, lineCount: text === "" ? 0 : text.replace(/\n$/, "").split("\n").length };
  } finally {
    await file.close();
  }
}

async function readBounded(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > MAX_FILE_BYTES) throw new Error("File is too large (limit: 1 MiB).");
  return bytes.subarray(0, length);
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Only UTF-8 text files are supported.");
  }
}
