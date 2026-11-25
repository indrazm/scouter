import { displayText, readDocument } from "../core/files";
import { diffOptions, exclusive, runGit } from "./git";
import type { Change, FilePatch, Patch, Repository } from "./types";

const PATCH_LIMIT_BYTES = 1024 * 1024;
const ALL_LIMIT_BYTES = 4 * 1024 * 1024;
const UNTRACKED_BATCH = 16;

const binaryNotice: Patch = { kind: "notice", message: "Binary file: no preview." };
const tooLarge: Patch = { kind: "notice", message: "This diff is too large to display (limit: 1 MiB)." };
const notShown: Patch = { kind: "notice", message: "Too much to show at once. Press a to view this file alone." };

export async function readPatch(repository: Repository, change: Change, contextLines = 3): Promise<Patch> {
  if (change.binary) return binaryNotice;

  if (change.kind === "untracked") return untrackedPatch(repository, change);

  const text = await trackedPatch(repository, change, contextLines);
  return typeof text === "string" ? toPatch(change, text) : text;
}

export async function readAllPatches(
  repository: Repository,
  changes: Change[],
  contextLines = 3,
): Promise<FilePatch[]> {
  let chunks = new Map<string, string>();
  let cut = false;

  if (changes.some((change) => change.kind !== "untracked" && !change.binary)) {
    const output = await exclusive(repository, () =>
      runGit(repository.root, ["diff", `-U${contextLines}`, repository.base, ...diffOptions], {
        limit: ALL_LIMIT_BYTES,
        indexFile: repository.indexFile,
        partial: true,
      }),
    );
    cut = output.truncated;
    chunks = splitPatch(output.text, cut);
  }

  let budget = ALL_LIMIT_BYTES;
  const untrackedPatches = new Map<string, Patch>();
  const untrackedChanges = changes.filter((change) => change.kind === "untracked" && !change.binary);
  for (let start = 0; start < untrackedChanges.length && budget > 0; start += UNTRACKED_BATCH) {
    const batch = untrackedChanges.slice(start, start + UNTRACKED_BATCH);
    // oxlint-disable-next-line no-await-in-loop
    const built = await Promise.all(batch.map((change) => untrackedPatch(repository, change)));
    for (let index = 0; index < batch.length; index += 1) {
      const change = batch[index]!;
      const patch = built[index]!;

      if (budget <= 0) {
        untrackedPatches.set(change.path, notShown);
        continue;
      }

      if (patch.kind === "text") budget -= patch.text.length;

      untrackedPatches.set(change.path, patch);
    }
  }

  const result: FilePatch[] = [];
  for (const change of changes) {
    result.push({
      change,
      // oxlint-disable-next-line no-await-in-loop
      patch: await patchFor(repository, change, chunks, untrackedPatches, cut, contextLines),
    });
  }
  return result;
}

function toPatch(change: Change, raw: string): Patch {
  if (raw.length > PATCH_LIMIT_BYTES) return tooLarge;

  const body = displayText(raw).replace(/\t/g, "    ");

  if (/^Binary files .* differ$/m.test(body)) return binaryNotice;

  const counts = countLines(body);

  if (counts.hunks === 0) return { kind: "notice", message: emptyMessage(change) };

  return { kind: "text", text: body, ...counts };
}

async function patchFor(
  repository: Repository,
  change: Change,
  chunks: Map<string, string>,
  untrackedPatches: Map<string, Patch>,
  cut: boolean,
  contextLines: number,
): Promise<Patch> {
  if (change.binary) return binaryNotice;

  if (change.kind === "untracked") return untrackedPatches.get(change.path) ?? notShown;

  const chunk = chunks.get(change.path);

  if (chunk !== undefined) return toPatch(change, chunk);

  return cut ? notShown : readPatch(repository, change, contextLines);
}

function splitPatch(text: string, cut: boolean): Map<string, string> {
  const complete = cut ? text.slice(0, text.lastIndexOf("\ndiff --git ") + 1) : text;
  const chunks = new Map<string, string>();
  for (const chunk of complete.split(/^(?=diff --git )/m)) {
    const path = chunkPath(chunk);

    if (path !== undefined) chunks.set(path, chunk);
  }
  return chunks;
}

function chunkPath(chunk: string): string | undefined {
  const renamed = /^rename to (.+)$/m.exec(chunk);

  if (renamed) return renamed[1];

  const added = /^\+\+\+ b\/(.*?)\t?$/m.exec(chunk);

  if (added) return added[1];

  const removed = /^--- a\/(.*?)\t?$/m.exec(chunk);

  if (removed) return removed[1];

  const header = /^diff --git a\/(.+)$/m.exec(chunk)?.[1];

  if (header === undefined) return undefined;

  const length = (header.length - 3) / 2;
  return Number.isInteger(length) &&
    header.slice(length, length + 3) === " b/" &&
    header.slice(0, length) === header.slice(length + 3)
    ? header.slice(0, length)
    : undefined;
}

async function trackedPatch(repository: Repository, change: Change, contextLines = 3): Promise<string | Patch> {
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  const output = await exclusive(repository, () =>
    runGit(repository.root, ["diff", `-U${contextLines}`, repository.base, ...diffOptions, "--", ...paths], {
      limit: PATCH_LIMIT_BYTES,
      indexFile: repository.indexFile,
    }),
  );

  if (output.truncated) return tooLarge;

  return output.text;
}

async function untrackedPatch(repository: Repository, change: Change): Promise<Patch> {
  let document;
  try {
    document = await readDocument(`${repository.root}/${change.path}`);
  } catch (error) {
    const message = error instanceof Error ? displayText(error.message) : "Unable to read this file.";
    return { kind: "notice", message: `New file: ${message}` };
  }

  if (document.truncated) return { kind: "notice", message: "New file: File is too large (limit: 1 MiB)." };

  if (document.lineCount === 0) return { kind: "notice", message: "New empty file." };

  const safePath = displayText(change.path).replace(/\t/g, "    ");
  const lines = document.text.replace(/\n$/, "").split("\n");
  const text = [
    `diff --git a/${safePath} b/${safePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${safePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");

  if (text.length > PATCH_LIMIT_BYTES) return tooLarge;

  return { kind: "text", text, hunks: 1, added: lines.length, removed: 0 };
}

function emptyMessage(change: Change): string {
  if (change.kind === "renamed") return `Renamed from ${change.oldPath ?? "another path"} with no content changes.`;

  if (change.kind === "conflict") return "Unmerged: resolve the conflict to see a diff.";

  return "No line changes (permissions or file type only).";
}

function countLines(patch: string): { hunks: number; added: number; removed: number } {
  let hunks = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) hunks += 1;
    else if (hunks > 0 && line.startsWith("+")) added += 1;
    else if (hunks > 0 && line.startsWith("-")) removed += 1;
  }
  return { hunks, added, removed };
}
