import { rmSync } from "node:fs";
import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { displayText, readDocument } from "./files";

const LIST_LIMIT_BYTES = 8 * 1024 * 1024;
const PATCH_LIMIT_BYTES = 1024 * 1024;
/** Total size of the diffs shown together; files beyond it are left for the single-file view. */
const ALL_LIMIT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
/** The change list renders one row per entry, so a runaway repository is cut off rather than loaded whole. */
export const MAX_CHANGES = 1000;

export class GitError extends Error {}

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "typechange" | "conflict" | "untracked";

export interface Change {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  /** Unknown (`undefined`) for untracked files, whose size git does not report. */
  added?: number;
  removed?: number;
  binary: boolean;
  /** The index differs from the base: the change is (at least partly) staged. Untracked files are never staged. */
  staged?: boolean;
  /** The working tree differs from the index: the change is (at least partly) not staged. */
  unstaged?: boolean;
}

interface LineCounts {
  added?: number;
  removed?: number;
  binary: boolean;
}

export interface Repository {
  root: string;
  /** `HEAD`, or the empty tree before the first commit; re-resolved on every `listChanges` because that commit changes it. */
  base: string;
  /** `git diff` rewrites the index it reads even with optional locks off, so git works on this copy and never touches `.git/index`. */
  indexFile: string;
  gitIndex: string;
  /** Tail of the git calls in flight: they share `indexFile`, so they take turns. */
  queue: Promise<unknown>;
}

export interface ChangeSet {
  changes: Change[];
  truncated: boolean;
}

export type Patch =
  | { kind: "text"; text: string; hunks: number; added: number; removed: number }
  | { kind: "notice"; message: string };

/** Git is only asked questions: no repository-configured helpers (external diff, textconv, fsmonitor) run (0007). */
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
  // `--no-ext-diff` already stops it; dropping the variable too means a missed flag cannot run an external program.
  delete env.GIT_EXTERNAL_DIFF;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
}

interface Output {
  text: string;
  truncated: boolean;
}

interface RunOptions {
  limit?: number;
  indexFile?: string;
  /** Keep what was read at `limit`; the chunk that crossed it is kept whole, so the text can run a little past it. */
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
  return { text: new TextDecoder().decode(bytes), truncated };
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  partial: boolean,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  // Leaving the loop early cancels the stream, which is what stops git from writing more than we want.
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
  const base = await resolveBase(root);
  const gitIndex = (await run(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).text.trim();
  const copyDirectory = await mkdtemp(join(tmpdir(), "scouter-index-"));
  openCopies.add(copyDirectory);
  return { root, base, indexFile: join(copyDirectory, "index"), gitIndex, queue: Promise.resolve() };
}

async function resolveBase(root: string): Promise<string> {
  const head = await run(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
    () => true,
    () => false,
  );
  return head ? "HEAD" : (await run(root, ["hash-object", "-t", "tree", "/dev/null"])).text.trim();
}

/** Runs git calls that use the private index one at a time, so a copy is never replaced while git reads it. */
function exclusive<T>(repository: Repository, task: () => Promise<T>): Promise<T> {
  const result = repository.queue.then(task, task);
  repository.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Safe to call more than once. */
export async function closeRepository(repository: Repository): Promise<void> {
  const directory = dirname(repository.indexFile);
  openCopies.delete(directory);
  await rm(directory, { recursive: true, force: true });
}

/**
 * The copy keeps the original's modification time: git trusts a same-second edit by comparing file times with the
 * index's own, so a copy stamped "now" would make it report a changed file as unchanged.
 */
async function syncIndex(repository: Repository): Promise<void> {
  try {
    const { atime, mtime } = await stat(repository.gitIndex);
    await copyFile(repository.gitIndex, repository.indexFile);
    await utimes(repository.indexFile, atime, mtime);
  } catch {
    await rm(repository.indexFile, { force: true });
  }
}

export function listChanges(repository: Repository): Promise<ChangeSet> {
  return exclusive(repository, () => readChanges(repository));
}

async function readChanges(repository: Repository): Promise<ChangeSet> {
  repository.base = await resolveBase(repository.root);
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

/** An ignored folder is listed once with a trailing slash, so `node_modules/` costs one entry. */
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

export async function readPatch(repository: Repository, change: Change): Promise<Patch> {
  if (change.binary) return binaryNotice;
  const text =
    change.kind === "untracked" ? await untrackedPatch(repository, change) : await trackedPatch(repository, change);
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

/** One `git diff` covers all tracked files and is split per file; untracked files are read from disk. */
export async function readAllPatches(repository: Repository, changes: Change[]): Promise<FilePatch[]> {
  let chunks = new Map<string, string>();
  let cut = false;
  if (changes.some((change) => change.kind !== "untracked" && !change.binary)) {
    const output = await exclusive(repository, () =>
      run(repository.root, ["diff", repository.base, ...diffOptions], {
        limit: ALL_LIMIT_BYTES,
        indexFile: repository.indexFile,
        partial: true,
      }),
    );
    cut = output.truncated;
    chunks = splitPatch(output.text, cut);
  }
  let budget = ALL_LIMIT_BYTES;
  const result: FilePatch[] = [];
  for (const change of changes) {
    result.push({
      change,
      // In list order, so the size budget is spent on the first files rather than on whichever finishes first.
      // oxlint-disable-next-line no-await-in-loop
      patch: await patchFor(
        repository,
        change,
        chunks,
        cut,
        () => budget,
        (used) => {
          budget -= used;
        },
      ),
    });
  }
  return result;
}

async function patchFor(
  repository: Repository,
  change: Change,
  chunks: Map<string, string>,
  cut: boolean,
  budget: () => number,
  spend: (bytes: number) => void,
): Promise<Patch> {
  if (change.binary) return binaryNotice;
  if (change.kind === "untracked") {
    if (budget() <= 0) return notShown;
    const raw = await untrackedPatch(repository, change);
    if (typeof raw !== "string") return raw;
    spend(raw.length);
    return toPatch(change, raw);
  }
  const chunk = chunks.get(change.path);
  if (chunk !== undefined) return toPatch(change, chunk);
  // Missing from the combined output: it was cut off, or its name was written in a form we do not parse.
  return cut ? notShown : readPatch(repository, change);
}

function splitPatch(text: string, cut: boolean): Map<string, string> {
  // A cut-off read ends mid-file; drop that last, incomplete file rather than show half of it.
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
  // Git ends the name with a tab when it contains spaces.
  const added = /^\+\+\+ b\/(.*?)\t?$/m.exec(chunk);
  if (added) return added[1];
  const removed = /^--- a\/(.*?)\t?$/m.exec(chunk);
  if (removed) return removed[1];
  // Binary and mode-only changes have neither; without a rename both halves of the header name the same file.
  const header = /^diff --git a\/(.+)$/m.exec(chunk)?.[1];
  if (header === undefined) return undefined;
  const length = (header.length - 3) / 2;
  return Number.isInteger(length) &&
    header.slice(length, length + 3) === " b/" &&
    header.slice(0, length) === header.slice(length + 3)
    ? header.slice(0, length)
    : undefined;
}

async function trackedPatch(repository: Repository, change: Change): Promise<string | Patch> {
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  const output = await exclusive(repository, () =>
    run(repository.root, ["diff", repository.base, ...diffOptions, "--", ...paths], {
      limit: PATCH_LIMIT_BYTES,
      indexFile: repository.indexFile,
    }),
  );
  if (output.truncated) return tooLarge;
  return output.text;
}

async function untrackedPatch(repository: Repository, change: Change): Promise<string | Patch> {
  let document;
  try {
    document = await readDocument(`${repository.root}/${change.path}`);
  } catch (error) {
    const message = error instanceof Error ? displayText(error.message) : "Unable to read this file.";
    return { kind: "notice", message: `New file: ${message}` };
  }
  if (document.truncated) return { kind: "notice", message: "New file: File is too large (limit: 1 MiB)." };
  if (document.lineCount === 0) return { kind: "notice", message: "New empty file." };
  const lines = document.text.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${change.path} b/${change.path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${change.path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
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
    // A copy names a source and a destination path just as a rename does.
    const renamed = status.startsWith("R") || status.startsWith("C");
    const first = tokens[index++];
    const second = renamed ? tokens[index++] : undefined;
    const path = second ?? first;
    if (!path) continue;
    changes.push({
      path,
      ...(renamed ? { oldPath: first } : {}),
      kind: kinds[status[0] ?? "M"] ?? "modified",
      ...(counts.get(path) ?? { binary: false }),
    });
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
    // A rename lists an empty path here, followed by the old and new paths as separate tokens.
    const path = match[3] === "" ? tokens[index + 2] : match[3];
    index += match[3] === "" ? 3 : 1;
    if (!path) continue;
    const binary = match[1] === "-";
    result.set(path, binary ? { binary } : { added: Number(match[1]), removed: Number(match[2]), binary });
  }
  return result;
}

// Private index copies are removed when their repository is closed; this catches an abrupt exit.
const openCopies = new Set<string>();
process.once("exit", () => {
  for (const directory of openCopies) rmSync(directory, { recursive: true, force: true });
});
