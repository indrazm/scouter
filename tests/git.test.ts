import { expect, test } from "bun:test";
import { chmod, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitError, closeRepository, listChanges, openRepository, readPatch, type Change } from "../src/git";
import { createRepository as repository, git, withDirectory } from "./fixtures";

const byPath = (changes: Change[], path: string): Change => {
  const change = changes.find((candidate) => candidate.path === path);
  if (!change) throw new Error(`No change for ${path}.`);
  return change;
};

test("explains when a directory is not inside a git repository", () => withDirectory(async (directory) => {
  const error = await openRepository(directory).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(GitError);
  expect((error as Error).message).toBe("Not a git repository.");
}));

test("a clean repository has no changes", () => withDirectory(async (directory) => {
  await repository(directory, { "a.txt": "one\n" });
  const repo = await openRepository(directory);
  expect(repo.base).toBe("HEAD");
  expect(await listChanges(repo)).toEqual({ changes: [], truncated: false });
}));

test("lists staged and unstaged edits together with every kind of change, sorted, with line counts", () => withDirectory(async (directory) => {
  await repository(directory, {
    "edited.txt": "one\ntwo\nthree\n", "gone.txt": "bye\n", "moved.txt": "a stable body\nthat is long enough\nto be recognised\n",
    "src/deep/inner.txt": "x\n", "image.bin": "binary\n",
  });
  await writeFile(join(directory, "edited.txt"), "one\nTWO\nthree\nfour\n");
  git(directory, "add", "edited.txt");
  await writeFile(join(directory, "edited.txt"), "one\nTWO\nthree\nfour\nfive\n");
  await rm(join(directory, "gone.txt"));
  await rename(join(directory, "moved.txt"), join(directory, "renamed.txt"));
  git(directory, "add", "--all");
  await writeFile(join(directory, "staged-new.txt"), "fresh\n");
  git(directory, "add", "staged-new.txt");
  await writeFile(join(directory, "untracked.txt"), "loose\n");
  await writeFile(join(directory, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));

  const { changes, truncated } = await listChanges(await openRepository(directory));
  expect(truncated).toBe(false);
  expect(changes.map((change) => change.path)).toEqual([...changes.map((change) => change.path)].sort());
  expect(byPath(changes, "edited.txt")).toMatchObject({ kind: "modified", added: 3, removed: 1 });
  expect(byPath(changes, "gone.txt")).toMatchObject({ kind: "deleted", added: 0, removed: 1 });
  expect(byPath(changes, "renamed.txt")).toMatchObject({ kind: "renamed", oldPath: "moved.txt", added: 0, removed: 0 });
  expect(byPath(changes, "staged-new.txt")).toMatchObject({ kind: "added", added: 1 });
  expect(byPath(changes, "untracked.txt")).toMatchObject({ kind: "untracked" });
  expect(byPath(changes, "untracked.txt").added).toBeUndefined();
  expect(byPath(changes, "image.bin")).toMatchObject({ kind: "modified", binary: true });
  expect(changes.some((change) => change.path === "src/deep/inner.txt")).toBe(false);
}));

test("a repository without commits compares against the empty tree", () => withDirectory(async (directory) => {
  await repository(directory);
  await writeFile(join(directory, "first.txt"), "hello\n");
  git(directory, "add", "first.txt");
  const repo = await openRepository(directory);
  expect(repo.base).not.toBe("HEAD");
  const { changes } = await listChanges(repo);
  expect(changes).toEqual([{ path: "first.txt", kind: "added", added: 1, removed: 0, binary: false }]);
}));

test("reads unified patches, synthesises one for untracked files and explains what cannot be shown", () => withDirectory(async (directory) => {
  await repository(directory, { "a.txt": "one\ntwo\nthree\n", "mode.sh": "echo\n", "image.bin": "x\n" });
  await writeFile(join(directory, "a.txt"), "one\n\ttwo changed\nthree\n");
  await chmod(join(directory, "mode.sh"), 0o755);
  await writeFile(join(directory, "image.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(directory, "new.txt"), "alpha\nbeta\n");
  await writeFile(join(directory, "empty.txt"), "");
  await writeFile(join(directory, "binary.dat"), Buffer.from([0, 159, 146, 150]));
  const repo = await openRepository(directory);
  const { changes } = await listChanges(repo);

  const edited = await readPatch(repo, byPath(changes, "a.txt"));
  expect(edited).toMatchObject({ kind: "text", hunks: 1, added: 1, removed: 1 });
  expect(edited.kind === "text" && edited.text).toContain("+    two changed");

  const untracked = await readPatch(repo, byPath(changes, "new.txt"));
  expect(untracked).toMatchObject({ kind: "text", hunks: 1, added: 2, removed: 0 });
  expect(untracked.kind === "text" && untracked.text).toContain("+++ b/new.txt");

  expect(await readPatch(repo, byPath(changes, "image.bin"))).toEqual({ kind: "notice", message: "Binary file: no preview." });
  expect(await readPatch(repo, byPath(changes, "mode.sh"))).toMatchObject({ kind: "notice", message: expect.stringContaining("permissions") });
  expect(await readPatch(repo, byPath(changes, "empty.txt"))).toEqual({ kind: "notice", message: "New empty file." });
  expect(await readPatch(repo, byPath(changes, "binary.dat"))).toMatchObject({ kind: "notice", message: expect.stringContaining("Binary") });
}));

test("refuses diffs over 1 MiB instead of loading them", () => withDirectory(async (directory) => {
  await repository(directory, { "big.txt": "start\n" });
  await writeFile(join(directory, "big.txt"), `${"line of filler text\n".repeat(80_000)}`);
  const repo = await openRepository(directory);
  const { changes } = await listChanges(repo);
  expect(await readPatch(repo, byPath(changes, "big.txt"))).toMatchObject({ kind: "notice", message: expect.stringContaining("too large") });
}));

test("strips terminal control sequences from patch text", () => withDirectory(async (directory) => {
  await repository(directory, { "a.txt": "safe\n" });
  await writeFile(join(directory, "a.txt"), "safe \u001b[2Jwiped ‮evil\n");
  const repo = await openRepository(directory);
  const patch = await readPatch(repo, byPath((await listChanges(repo)).changes, "a.txt"));
  if (patch.kind !== "text") throw new Error("Expected a text patch.");
  expect(patch.text).not.toContain("\u001b");
  expect(patch.text).not.toContain("‮");
  expect(patch.text).toContain("wiped");
}));

test("treats unusual file names literally", () => withDirectory(async (directory) => {
  const odd = "weird [name] *.txt";
  await repository(directory, { [odd]: "a\n", "other.txt": "b\n" });
  await writeFile(join(directory, odd), "changed\n");
  await writeFile(join(directory, "other.txt"), "also changed\n");
  const repo = await openRepository(directory);
  const { changes } = await listChanges(repo);
  expect(changes.map((change) => change.path).sort()).toEqual(["other.txt", odd].sort());
  const patch = await readPatch(repo, byPath(changes, odd));
  expect(patch.kind === "text" && patch.text).toContain("+changed");
  expect(patch.kind === "text" && patch.text).not.toContain("also changed");
}));

test("never writes to the repository and never runs programs configured by it", () => withDirectory(async (directory) => {
  await repository(directory, { "a.txt": "one\n" });
  const marker = join(directory, "..", `scouter-ran-${Date.now()}`);
  const script = join(directory, "hook.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(script, 0o755);
  git(directory, "config", "diff.external", script);
  git(directory, "config", "core.fsmonitor", script);
  git(directory, "config", "diff.test.textconv", script);
  await writeFile(join(directory, ".gitattributes"), "*.txt diff=test\n");
  // Touching a file without changing it makes a plain `git status` refresh, and rewrite, the index.
  await utimes(join(directory, "a.txt"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await writeFile(join(directory, "b.txt"), "new\n");
  const before = await stat(join(directory, ".git", "index"));

  const repo = await openRepository(directory);
  const { changes } = await listChanges(repo);
  for (const change of changes) await readPatch(repo, change);

  const after = await stat(join(directory, ".git", "index"));
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBe(before.size);
  expect(await Bun.file(marker).exists()).toBe(false);
  await rm(marker, { force: true });
  await closeRepository(repo);
  expect(await Bun.file(repo.indexFile).exists()).toBe(false);
}));

test("works from a subdirectory and reports paths relative to the repository root", () => withDirectory(async (directory) => {
  await repository(directory, { "pkg/inner.txt": "one\n" });
  await writeFile(join(directory, "pkg", "inner.txt"), "two\n");
  await symlink(join(directory, "pkg"), join(directory, "link"));
  const repo = await openRepository(join(directory, "pkg"));
  expect((await listChanges(repo)).changes.map((change) => change.path)).toEqual(["link", "pkg/inner.txt"]);
}));
