import { constants, type Stats } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "link" | "other";
}

export interface Document {
  path: string;
  text: string;
  lineCount: number;
  /** Only the first megabyte is loaded; the rest of the file is not shown. */
  truncated?: boolean;
}

export interface ImageFile {
  path: string;
  bytes: Uint8Array;
}

/** Whether the file name says it is a picture Scouter can show. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
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

/** Reads a text file. Larger files show their first megabyte, cut at a whole character, and are marked as truncated. */
export async function readDocument(path: string): Promise<Document> {
  const { file } = await openRegularFile(path, "Only regular text files can be viewed.");
  try {
    const loaded = await readBounded(file);
    const truncated = loaded.length > MAX_FILE_BYTES;
    const bytes = truncated ? loaded.subarray(0, characterBoundary(loaded, MAX_FILE_BYTES)) : loaded;
    if (bytes.includes(0)) throw new Error("Binary files are not supported.");
    const text = displayText(decodeText(bytes)).replace(/\t/g, "    ");
    return {
      path,
      text,
      lineCount: text === "" ? 0 : text.replace(/\n$/, "").split("\n").length,
      ...(truncated ? { truncated } : {}),
    };
  } finally {
    await file.close();
  }
}

/** The position just before the UTF-8 character that `end` would split, so the bytes before it decode cleanly. */
function characterBoundary(bytes: Uint8Array, end: number): number {
  let cut = end;
  // Continuation bytes are 10xxxxxx; the character starts at the first byte that is not one.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return cut;
}

type OpenFile = Awaited<ReturnType<typeof open>>;

/** Opens `path` for reading and refuses anything that is not a regular file, closing it again when it is refused. */
async function openRegularFile(path: string, refusal: string): Promise<{ file: OpenFile; metadata: Stats }> {
  // Non-blocking open lets us reject pipes and devices without waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error(refusal);
    return { file, metadata };
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Reads a picture's bytes, under the same rules as text files: regular files only, and a size limit. */
export async function readImage(path: string): Promise<ImageFile> {
  const { file, metadata } = await openRegularFile(path, "Only regular files can be viewed.");
  try {
    if (metadata.size > MAX_IMAGE_BYTES) throw new Error("Image is too large (limit: 10 MiB).");
    const bytes = await file.readFile();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is too large (limit: 10 MiB).");
    return { path, bytes };
  } finally {
    await file.close();
  }
}

/** Up to one byte past the limit, so the caller can tell a file that fits from one that does not. */
async function readBounded(file: OpenFile): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    // Each read continues where the last one stopped, so these cannot overlap.
    // oxlint-disable-next-line no-await-in-loop
    const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return bytes.subarray(0, length);
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Only UTF-8 text files are supported.");
  }
}
