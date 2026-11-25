import { rmSync } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { displayText, readDocument } from "./files";

const LIST_LIMIT_BYTES = 8 * 1024 * 1024;
const PATCH_LIMIT_BYTES = 1024 * 1024;
const ALL_LIMIT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const RACY_INDEX_WINDOW_MS = 2000;
const UNTRACKED_BATCH = 16;
const STAMP_BATCH = 32;
export const MAX_CHANGES = 1000;

const utf8Decoder = new TextDecoder();

export class GitError extends Error {}

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "typechange" | "conflict" | "untracked";

export interface Change {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  added?: number;
  removed?: number;
  binary: boolean;
  staged?: boolean;
  unstaged?: boolean;
}

interface LineCounts {
  added?: number;
  removed?: number;
  binary: boolean;
}

interface IndexStamp {
  sourceIno: bigint;
  sourceSize: bigint;
  sourceMtimeNs: bigint;
  sourceCtimeNs: bigint;
  copyIno: bigint;
  copySize: bigint;
  copyMtimeNs: bigint;
}

export interface Repository {
  root: string;
  base: string;
  headOid: string;
  indexFile: string;
  gitIndex: string;
  indexStamp?: IndexStamp;
  queue: Promise<unknown>;
}

export interface MarksSnapshot {
  changes: Pick<Change, "path" | "kind">[];
  ignored: string[];
}

export interface ChangeSet {
  changes: Change[];
  truncated: boolean;
}

export type Patch =
  | { kind: "text"; text: string; hunks: number; added: number; removed: number }
  | { kind: "notice"; message: string };

const readOnlyOptions = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotepath=false",
];
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];

function environment(indexFile?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  delete env.GIT_EXTERNAL_DIFF;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";

  if (indexFile) env.GIT_INDEX_FILE = indexFile;

  return env;
}

interface Output {
  text: string;
  truncated: boolean;
}

interface RunOptions {
  limit?: number;
  indexFile?: string;
  partial?: boolean;
}

async function run(
  directory: string,
  args: string[],
  { limit = LIST_LIMIT_BYTES, indexFile, partial = false }: RunOptions = {},
): Promise<Output> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(["git", "-C", directory, ...readOnlyOptions, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: environment(indexFile),
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
  } catch {
    throw new GitError("Git is not installed or could not be started.");
  }
  const stderr = new Response(child.stderr).text();
  const { bytes, truncated } = await readCapped(child.stdout, limit, partial);

  if (truncated) child.kill();

  const code = await child.exited;

  if (!truncated && code !== 0) {
    const reason = (await stderr).trim().split("\n")[0];
    throw new GitError(reason ? displayText(reason) : `git exited with status ${code}.`);
  }

  return { text: utf8Decoder.decode(bytes), truncated };
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  partial: boolean,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  for await (const value of stream) {
    length += value.length;

    if (length > limit) {
      if (!partial) return { bytes: new Uint8Array(), truncated: true };

      chunks.push(value);
      truncated = true;
      break;
    }

    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

export async function openRepository(directory: string): Promise<Repository> {
  let root: string;
  try {
    root = (await run(directory, ["rev-parse", "--show-toplevel"])).text.trim();
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.message))
      throw new GitError("Not a git repository.");

    throw error;
  }

  if (!root) throw new GitError("Not a git repository.");

  const { base, headOid } = await resolveBase(root);
  const gitIndex = (await run(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).text.trim();
  const copyDirectory = await mkdtemp(join(tmpdir(), "scouter-index-"));
  openCopies.add(copyDirectory);
  return { root, base, headOid, indexFile: join(copyDirectory, "index"), gitIndex, queue: Promise.resolve() };
}

async function resolveBase(root: string): Promise<{ base: string; headOid: string }> {
  const headOid = await run(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
    (output) => output.text.trim(),
    () => "",
  );

  if (headOid) return { base: "HEAD", headOid };

  const base = (await run(root, ["hash-object", "-t", "tree", "/dev/null"])).text.trim();
  return { base, headOid: "" };
}

function exclusive<T>(repository: Repository, task: () => Promise<T>): Promise<T> {
  const result = repository.queue.then(task, task);
  repository.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function closeRepository(repository: Repository): Promise<void> {
  const directory = dirname(repository.indexFile);
  openCopies.delete(directory);
  await rm(directory, { recursive: true, force: true });
}

async function syncIndex(repository: Repository): Promise<void> {
  try {
    const info = await stat(repository.gitIndex, { bigint: true });
    const previous = repository.indexStamp;
    const mtimeMs = Number(info.mtimeNs / 1_000_000n);

    if (
      previous &&
      previous.sourceIno === info.ino &&
      previous.sourceSize === info.size &&
      previous.sourceMtimeNs === info.mtimeNs &&
      previous.sourceCtimeNs === info.ctimeNs &&
      Date.now() - mtimeMs > RACY_INDEX_WINDOW_MS
    ) {
      const copy = await stat(repository.indexFile, { bigint: true }).catch(() => undefined);

      if (
        copy &&
        copy.ino === previous.copyIno &&
        copy.size === previous.copySize &&
        copy.mtimeNs === previous.copyMtimeNs
      ) {
        return;
      }
    }

    await copyFile(repository.gitIndex, repository.indexFile);
    await utimes(repository.indexFile, Number(info.atimeNs) / 1e9, Number(info.mtimeNs) / 1e9);
    const copy = await stat(repository.indexFile, { bigint: true });
    repository.indexStamp = {
      sourceIno: info.ino,
      sourceSize: info.size,
      sourceMtimeNs: info.mtimeNs,
      sourceCtimeNs: info.ctimeNs,
      copyIno: copy.ino,
      copySize: copy.size,
      copyMtimeNs: copy.mtimeNs,
    };
  } catch {
    repository.indexStamp = undefined;
    await rm(repository.indexFile, { force: true });
  }
}

export function listChanges(repository: Repository): Promise<ChangeSet> {
  return exclusive(repository, () => readChanges(repository));
}

async function readChanges(repository: Repository): Promise<ChangeSet> {
  const { base, headOid } = await resolveBase(repository.root);
  repository.base = base;
  repository.headOid = headOid;
  await syncIndex(repository);
  const indexFile = repository.indexFile;
  const [statuses, numbers, untracked, staged, unstaged] = await Promise.all([
    run(repository.root, ["diff", repository.base, "--name-status", "-z", ...diffOptions], { indexFile }),
    run(repository.root, ["diff", repository.base, "--numstat", "-z", ...diffOptions], { indexFile }),
    run(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], { indexFile }),
    run(repository.root, ["diff", "--cached", repository.base, "--name-only", "-z", ...diffOptions], { indexFile }),
    run(repository.root, ["diff", "--name-only", "-z", ...diffOptions], { indexFile }),
  ]);
  const counts = parseNumstat(numbers.text);
  const stagedPaths = new Set(splitZ(staged.text));
  const unstagedPaths = new Set(splitZ(unstaged.text));
  const changes = [
    ...parseNameStatus(statuses.text, counts).map((change) =>
      Object.assign(change, {
        staged: stagedPaths.has(change.path),
        unstaged: unstagedPaths.has(change.path),
      }),
    ),
    ...splitZ(untracked.text).map((path): Change => ({
      path,
      kind: "untracked",
      binary: false,
    })),
  ];
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const truncated = changes.length > MAX_CHANGES || statuses.truncated || numbers.truncated || untracked.truncated;
  return { changes: changes.slice(0, MAX_CHANGES), truncated };
}

export function listMarks(repository: Repository): Promise<MarksSnapshot> {
  return exclusive(repository, async () => {
    const { base, headOid } = await resolveBase(repository.root);
    repository.base = base;
    repository.headOid = headOid;
    await syncIndex(repository);
    const indexFile = repository.indexFile;
    const [statuses, untracked, ignored] = await Promise.all([
      run(repository.root, ["diff", repository.base, "--name-status", "-z", ...diffOptions], { indexFile }),
      run(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], { indexFile }),
      run(repository.root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
        indexFile,
      }),
    ]);
    const emptyCounts = new Map<string, LineCounts>();
    const changes: Pick<Change, "path" | "kind">[] = [
      ...parseNameStatus(statuses.text, emptyCounts).map(({ path, kind }) => ({ path, kind })),
      ...splitZ(untracked.text).map((path): Pick<Change, "path" | "kind"> => ({ path, kind: "untracked" })),
    ];
    changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { changes: changes.slice(0, MAX_CHANGES), ignored: splitZ(ignored.text) };
  });
}

async function pathStamp(path: string, followSymlinks: boolean): Promise<string> {
  try {
    const info = await (followSymlinks ? stat(path, { bigint: true }) : lstat(path, { bigint: true }));
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return "missing";
  }
}

export async function changesStamp(repository: Repository, changes: Change[]): Promise<string> {
  const index = await pathStamp(repository.gitIndex, true);
  const parts: string[] = [repository.headOid, repository.base, index];
  for (let start = 0; start < changes.length; start += STAMP_BATCH) {
    const batch = changes.slice(start, start + STAMP_BATCH);
    // oxlint-disable-next-line no-await-in-loop
    const stamps = await Promise.all(
      batch.map((change) =>
        change.kind === "deleted"
          ? Promise.resolve("deleted")
          : pathStamp(join(repository.root, change.path), change.kind === "untracked"),
      ),
    );
    for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch += 1) {
      parts.push(`${batch[indexInBatch]!.path}\0${stamps[indexInBatch]!}`);
    }
  }
  return parts.join("\n");
}

export function listIgnored(repository: Repository): Promise<string[]> {
  return exclusive(repository, async () => {
    await syncIndex(repository);
    const output = await run(
      repository.root,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { indexFile: repository.indexFile },
    );
    return splitZ(output.text);
  });
}

export async function readPatch(repository: Repository, change: Change, contextLines = 3): Promise<Patch> {
  if (change.binary) return binaryNotice;

  if (change.kind === "untracked") return untrackedPatch(repository, change);

  const text = await trackedPatch(repository, change, contextLines);
  return typeof text === "string" ? toPatch(change, text) : text;
}

function toPatch(change: Change, raw: string): Patch {
  if (raw.length > PATCH_LIMIT_BYTES) return tooLarge;

  const body = displayText(raw).replace(/\t/g, "    ");

  if (/^Binary files .* differ$/m.test(body)) return binaryNotice;

  const counts = countLines(body);

  if (counts.hunks === 0) return { kind: "notice", message: emptyMessage(change) };

  return { kind: "text", text: body, ...counts };
}

const binaryNotice: Patch = { kind: "notice", message: "Binary file: no preview." };
const tooLarge: Patch = { kind: "notice", message: "This diff is too large to display (limit: 1 MiB)." };
const notShown: Patch = { kind: "notice", message: "Too much to show at once. Press a to view this file alone." };

export interface FilePatch {
  change: Change;
  patch: Patch;
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
      run(repository.root, ["diff", `-U${contextLines}`, repository.base, ...diffOptions], {
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
    run(repository.root, ["diff", `-U${contextLines}`, repository.base, ...diffOptions, "--", ...paths], {
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

const kinds: Record<string, ChangeKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  T: "typechange",
  U: "conflict",
};

function splitZ(text: string): string[] {
  const tokens = text.split("\0");

  if (tokens.at(-1) === "") tokens.pop();

  return tokens;
}

function parseNameStatus(text: string, counts: Map<string, LineCounts>): Change[] {
  const tokens = splitZ(text);
  const changes: Change[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const first = tokens[index++];
    const second = renamed ? tokens[index++] : undefined;
    const path = second ?? first;

    if (!path) continue;

    const lineCounts = counts.get(path) ?? { binary: false };
    const change: Change = {
      path,
      kind: kinds[status[0] ?? "M"] ?? "modified",
      binary: lineCounts.binary,
    };

    if (renamed && first !== undefined) change.oldPath = first;

    if (lineCounts.added !== undefined) change.added = lineCounts.added;

    if (lineCounts.removed !== undefined) change.removed = lineCounts.removed;

    changes.push(change);
  }
  return changes;
}

function parseNumstat(text: string): Map<string, LineCounts> {
  const tokens = splitZ(text);
  const result = new Map<string, LineCounts>();
  for (let index = 0; index < tokens.length;) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index] ?? "");

    if (!match) {
      index += 1;
      continue;
    }

    const path = match[3] === "" ? tokens[index + 2] : match[3];
    index += match[3] === "" ? 3 : 1;

    if (!path) continue;

    const binary = match[1] === "-";
    result.set(path, binary ? { binary } : { added: Number(match[1]), removed: Number(match[2]), binary });
  }
  return result;
}

const openCopies = new Set<string>();
process.once("exit", () => {
  for (const directory of openCopies) rmSync(directory, { recursive: true, force: true });
});
