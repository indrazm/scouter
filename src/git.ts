import { rmSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { displayText, readDocument } from "./files";

const LIST_LIMIT_BYTES = 8 * 1024 * 1024;
const PATCH_LIMIT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
/** The change list renders one row per entry, so a runaway repository is cut off rather than loaded whole. */
export const MAX_CHANGES = 1000;

export class GitError extends Error {}

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "typechange" | "conflict" | "untracked";

export interface Change {
  path: string;
  /** Previous path, for renames. */
  oldPath?: string;
  kind: ChangeKind;
  /** Unknown (`undefined`) for untracked files, whose size git does not report. */
  added?: number;
  removed?: number;
  binary: boolean;
}

export interface Repository {
  root: string;
  /**
   * What the working tree is compared against: `HEAD`, or the empty tree in a repository with no commits.
   * Re-resolved on every `listChanges`, because the first commit turns the latter into the former.
   */
  base: string;
  /**
   * A private copy of the repository's index. `git diff` refreshes the index it reads and rewrites it even when
   * optional locks are disabled, so git works on this copy and the real `.git/index` is never touched.
   */
  indexFile: string;
  /** The real index, copied into `indexFile` before every refresh. */
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

/**
 * Git is only ever asked questions: it works on a private index copy (see `Repository.indexFile`), and
 * repository-configured helpers (external diff, text conversion, the filesystem monitor) are not run.
 */
const readOnlyOptions = ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"];
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];

function environment(indexFile?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  delete env.GIT_EXTERNAL_DIFF;
  return {
    ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
}

interface Output {
  text: string;
  truncated: boolean;
}

interface RunOptions {
  limit?: number;
  indexFile?: string;
}

async function run(directory: string, args: string[], { limit = LIST_LIMIT_BYTES, indexFile }: RunOptions = {}): Promise<Output> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(["git", "-C", directory, ...readOnlyOptions, ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment(indexFile), signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
  } catch {
    throw new GitError("Git is not installed or could not be started.");
  }
  const stderr = new Response(child.stderr).text();
  const { bytes, truncated } = await readCapped(child.stdout, limit);
  if (truncated) child.kill();
  const code = await child.exited;
  if (!truncated && code !== 0) {
    const reason = (await stderr).trim().split("\n")[0];
    throw new GitError(reason ? displayText(reason) : `git exited with status ${code}.`);
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      return { bytes: new Uint8Array(), truncated: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated: false };
}

/** Finds the repository containing `directory`, or explains why there is none. */
export async function openRepository(directory: string): Promise<Repository> {
  let root: string;
  try {
    root = (await run(directory, ["rev-parse", "--show-toplevel"])).text.trim();
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.message)) throw new GitError("Not a git repository.");
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
  const head = await run(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
  return head ? "HEAD" : (await run(root, ["hash-object", "-t", "tree", "/dev/null"])).text.trim();
}

/** Runs git calls that use the private index one at a time, so a copy is never replaced while git reads it. */
function exclusive<T>(repository: Repository, task: () => Promise<T>): Promise<T> {
  const result = repository.queue.then(task, task);
  repository.queue = result.then(() => undefined, () => undefined);
  return result;
}

/** Removes the private index copy. Safe to call more than once. */
export async function closeRepository(repository: Repository): Promise<void> {
  const directory = dirname(repository.indexFile);
  openCopies.delete(directory);
  await rm(directory, { recursive: true, force: true });
}

async function syncIndex(repository: Repository): Promise<void> {
  await copyFile(repository.gitIndex, repository.indexFile).catch(() => rm(repository.indexFile, { force: true }));
}

/** Everything that differs from `base`: staged and unstaged edits together, plus files git does not track yet. */
export function listChanges(repository: Repository): Promise<ChangeSet> {
  return exclusive(repository, () => readChanges(repository));
}

async function readChanges(repository: Repository): Promise<ChangeSet> {
  repository.base = await resolveBase(repository.root);
  await syncIndex(repository);
  const indexFile = repository.indexFile;
  const [statuses, numbers, untracked] = await Promise.all([
    run(repository.root, ["diff", repository.base, "--name-status", "-z", ...diffOptions], { indexFile }),
    run(repository.root, ["diff", repository.base, "--numstat", "-z", ...diffOptions], { indexFile }),
    run(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], { indexFile }),
  ]);
  const counts = parseNumstat(numbers.text);
  const changes = [...parseNameStatus(statuses.text, counts), ...splitZ(untracked.text).map((path): Change => ({
    path, kind: "untracked", binary: false,
  }))];
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const truncated = changes.length > MAX_CHANGES || statuses.truncated || numbers.truncated || untracked.truncated;
  return { changes: changes.slice(0, MAX_CHANGES), truncated };
}

/** The unified diff for one change, or a short explanation when there is nothing textual to show. */
export async function readPatch(repository: Repository, change: Change): Promise<Patch> {
  if (change.binary) return { kind: "notice", message: "Binary file: no preview." };
  const text = change.kind === "untracked"
    ? await untrackedPatch(repository, change)
    : await trackedPatch(repository, change);
  if (typeof text !== "string") return text;
  const body = displayText(text).replace(/\t/g, "    ");
  if (/^Binary files .* differ$/m.test(body)) return { kind: "notice", message: "Binary file: no preview." };
  const counts = countLines(body);
  if (counts.hunks === 0) return { kind: "notice", message: emptyMessage(change) };
  return { kind: "text", text: body, ...counts };
}

async function trackedPatch(repository: Repository, change: Change): Promise<string | Patch> {
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  const output = await exclusive(repository, () => run(repository.root, ["diff", repository.base, ...diffOptions, "--", ...paths], {
    limit: PATCH_LIMIT_BYTES, indexFile: repository.indexFile,
  }));
  if (output.truncated) return { kind: "notice", message: "This diff is too large to display (limit: 1 MiB)." };
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
  if (document.lineCount === 0) return { kind: "notice", message: "New empty file." };
  const lines = document.text.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${change.path} b/${change.path}`, "new file mode 100644", "--- /dev/null", `+++ b/${change.path}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), "",
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

const kinds: Record<string, ChangeKind> = { M: "modified", A: "added", D: "deleted", R: "renamed", T: "typechange", U: "conflict" };

function splitZ(text: string): string[] {
  const tokens = text.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

function parseNameStatus(text: string, counts: Map<string, { added?: number; removed?: number; binary: boolean }>): Change[] {
  const tokens = splitZ(text);
  const changes: Change[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const first = tokens[index++];
    const second = renamed ? tokens[index++] : undefined;
    const path = second ?? first;
    if (!path) continue;
    changes.push({
      path, ...(renamed ? { oldPath: first } : {}), kind: kinds[status[0] ?? "M"] ?? "modified",
      ...(counts.get(path) ?? { binary: false }),
    });
  }
  return changes;
}

function parseNumstat(text: string): Map<string, { added?: number; removed?: number; binary: boolean }> {
  const tokens = splitZ(text);
  const result = new Map<string, { added?: number; removed?: number; binary: boolean }>();
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
process.once("exit", () => { for (const directory of openCopies) rmSync(directory, { recursive: true, force: true }); });
