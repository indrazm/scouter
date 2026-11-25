import { rmSync } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { displayText } from "../core/files";
import type { Change, ChangeKind, ChangeSet, GitOutput, MarksSnapshot, Repository, RunOptions } from "./types";

const LIST_LIMIT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const RACY_INDEX_WINDOW_MS = 2000;
const STAMP_BATCH = 32;
export const MAX_CHANGES = 1000;

const utf8Decoder = new TextDecoder();

export class GitError extends Error {}

interface LineCounts {
  added?: number;
  removed?: number;
  binary: boolean;
}

const readOnlyOptions = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotepath=false",
];
export const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];

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

export async function runGit(
  directory: string,
  args: string[],
  { limit = LIST_LIMIT_BYTES, indexFile, partial = false }: RunOptions = {},
): Promise<GitOutput> {
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
    root = (await runGit(directory, ["rev-parse", "--show-toplevel"])).text.trim();
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.message))
      throw new GitError("Not a git repository.");

    throw error;
  }

  if (!root) throw new GitError("Not a git repository.");

  const { base, headOid } = await resolveBase(root);
  const gitIndex = (await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).text.trim();
  const copyDirectory = await mkdtemp(join(tmpdir(), "scouter-index-"));
  openCopies.add(copyDirectory);
  return { root, base, headOid, indexFile: join(copyDirectory, "index"), gitIndex, queue: Promise.resolve() };
}

async function resolveBase(root: string): Promise<{ base: string; headOid: string }> {
  const headOid = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
    (output) => output.text.trim(),
    () => "",
  );

  if (headOid) return { base: "HEAD", headOid };

  const base = (await runGit(root, ["hash-object", "-t", "tree", "/dev/null"])).text.trim();
  return { base, headOid: "" };
}

export function exclusive<T>(repository: Repository, task: () => Promise<T>): Promise<T> {
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
    runGit(repository.root, ["diff", repository.base, "--name-status", "-z", ...diffOptions], { indexFile }),
    runGit(repository.root, ["diff", repository.base, "--numstat", "-z", ...diffOptions], { indexFile }),
    runGit(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], { indexFile }),
    runGit(repository.root, ["diff", "--cached", repository.base, "--name-only", "-z", ...diffOptions], { indexFile }),
    runGit(repository.root, ["diff", "--name-only", "-z", ...diffOptions], { indexFile }),
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
      runGit(repository.root, ["diff", repository.base, "--name-status", "-z", ...diffOptions], { indexFile }),
      runGit(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], { indexFile }),
      runGit(repository.root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
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
    const output = await runGit(
      repository.root,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { indexFile: repository.indexFile },
    );
    return splitZ(output.text);
  });
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
