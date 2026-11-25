import { constants, type Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { DirectoryEntry, Document, ImageFile } from "./types";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const nameCollator = new Intl.Collator();

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function displayText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
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

const NOISE = new Set([".git", ".hg", ".svn", ".DS_Store", ".AppleDouble", "Thumbs.db", "desktop.ini"]);

export async function readDirectoryRaw(path: string): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (NOISE.has(entry.name)) continue;

    entries.push({
      name: entry.name,
      path: join(path, entry.name),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other",
    });
  }
  return entries;
}

export async function readDirectory(path: string): Promise<DirectoryEntry[]> {
  const entries = await readDirectoryRaw(path);
  entries.sort((left, right) => {
    const directoryOrder = Number(right.kind === "directory") - Number(left.kind === "directory");
    return directoryOrder || nameCollator.compare(left.name, right.name);
  });
  return entries;
}

export class BinaryFileError extends Error {
  constructor(readonly size: number) {
    super("Binary files are not supported.");
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLogicalLines(text: string): number {
  if (text === "") return 0;

  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0 && at < end; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
}

export function formatFileStamp(metadata: Pick<Stats, "mtimeMs" | "size">): string {
  return `${metadata.mtimeMs}:${metadata.size}`;
}

export async function fileStamp(path: string): Promise<string> {
  return formatFileStamp(await stat(path));
}

export async function readDocument(path: string): Promise<Document> {
  return (await readDocumentWithStamp(path)).document;
}

export async function readDocumentWithStamp(path: string): Promise<{ document: Document; stamp: string }> {
  const { file, metadata } = await openRegularFile(path, "Only regular text files can be viewed.");
  try {
    const loaded = await readBounded(file, metadata.size);
    const truncated = loaded.length > MAX_FILE_BYTES;
    const bytes = truncated ? loaded.subarray(0, characterBoundary(loaded, MAX_FILE_BYTES)) : loaded;
    const text = displayText(decodeText(bytes)).replace(/\t/g, "    ");
    const document: Document = {
      path,
      text,
      lineCount: countLogicalLines(text),
    };

    if (truncated) document.truncated = true;

    return { document, stamp: formatFileStamp(metadata) };
  } finally {
    await file.close();
  }
}

function characterBoundary(bytes: Uint8Array, end: number): number {
  let cut = end;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return cut;
}

type OpenFile = Awaited<ReturnType<typeof open>>;

async function openRegularFile(path: string, refusal: string): Promise<{ file: OpenFile; metadata: Stats }> {
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

async function readBounded(file: OpenFile, size: number): Promise<Buffer> {
  const limit = MAX_FILE_BYTES + 1;
  const target = Math.min(Math.max(size, 0), MAX_FILE_BYTES) + 1;
  let bytes = Buffer.allocUnsafe(Math.min(target, BINARY_PROBE_BYTES));
  let length = 0;
  while (length < limit) {
    if (length === bytes.length) {
      const nextSize = bytes.length < target ? target : limit;
      const grown = Buffer.allocUnsafe(nextSize);
      bytes.copy(grown, 0, 0, length);
      bytes = grown;
    }

    // oxlint-disable-next-line no-await-in-loop
    const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);

    if (bytesRead === 0) break;

    const checkEnd = Math.min(length + bytesRead, MAX_FILE_BYTES);

    if (checkEnd > length && bytes.subarray(length, checkEnd).includes(0)) throw new BinaryFileError(size);

    length += bytesRead;
  }
  return bytes.subarray(0, length);
}

function decodeText(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error("Only UTF-8 text files are supported.");
  }
}

export function treeRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}
