import { expect, test } from "bun:test";
import { chmod, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GitError,
  closeRepository,
  listChanges,
  openRepository,
  readAllPatches,
  readPatch,
  type Change,
} from "../src/git";
import { createRepository as repository, git, withDirectory } from "./fixtures";

const byPath = (changes: Change[], path: string): Change => {
  const change = changes.find((candidate) => candidate.path === path);
  if (!change) throw new Error(`No change for ${path}.`);
  return change;
};

test("explains when a directory is not inside a git repository", () =>
  withDirectory(async (directory) => {
    const error = await openRepository(directory).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitError);
    expect((error as Error).message).toBe("Not a git repository.");
  }));

test("a clean repository has no changes", () =>
  withDirectory(async (directory) => {
    await repository(directory, { "a.txt": "one\n" });
    const repo = await openRepository(directory);
    expect(repo.base).toBe("HEAD");
    expect(await listChanges(repo)).toEqual({ changes: [], truncated: false });
  }));

test("lists staged and unstaged edits together with every kind of change, sorted, with line counts", () =>
  withDirectory(async (directory) => {
    await repository(directory, {
      "edited.txt": "one\ntwo\nthree\n",
      "gone.txt": "bye\n",
      "moved.txt": "a stable body\nthat is long enough\nto be recognised\n",
      "src/deep/inner.txt": "x\n",
      "image.bin": "binary\n",
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
    expect(changes.map((change) => change.path)).toEqual(changes.map((change) => change.path).toSorted());
    expect(byPath(changes, "edited.txt")).toMatchObject({ kind: "modified", added: 3, removed: 1 });
    expect(byPath(changes, "gone.txt")).toMatchObject({ kind: "deleted", added: 0, removed: 1 });
    expect(byPath(changes, "renamed.txt")).toMatchObject({
      kind: "renamed",
      oldPath: "moved.txt",
      added: 0,
      removed: 0,
    });
    expect(byPath(changes, "staged-new.txt")).toMatchObject({ kind: "added", added: 1 });
    expect(byPath(changes, "untracked.txt")).toMatchObject({ kind: "untracked" });
    expect(byPath(changes, "untracked.txt").added).toBeUndefined();
    expect(byPath(changes, "image.bin")).toMatchObject({ kind: "modified", binary: true });
    expect(changes.some((change) => change.path === "src/deep/inner.txt")).toBe(false);
  }));

test("a repository without commits compares against the empty tree", () =>
  withDirectory(async (directory) => {
    await repository(directory);
    await writeFile(join(directory, "first.txt"), "hello\n");
    git(directory, "add", "first.txt");
    const repo = await openRepository(directory);
    expect(repo.base).not.toBe("HEAD");
    const { changes } = await listChanges(repo);
    expect(changes).toEqual([
      { path: "first.txt", kind: "added", added: 1, removed: 0, binary: false, staged: true, unstaged: false },
    ]);
  }));

test("reads unified patches, synthesises one for untracked files and explains what cannot be shown", () =>
  withDirectory(async (directory) => {
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

    expect(await readPatch(repo, byPath(changes, "image.bin"))).toEqual({
      kind: "notice",
      message: "Binary file: no preview.",
    });
    expect(await readPatch(repo, byPath(changes, "mode.sh"))).toMatchObject({
      kind: "notice",
      message: expect.stringContaining("permissions"),
    });
    expect(await readPatch(repo, byPath(changes, "empty.txt"))).toEqual({ kind: "notice", message: "New empty file." });
    expect(await readPatch(repo, byPath(changes, "binary.dat"))).toMatchObject({
      kind: "notice",
      message: expect.stringContaining("Binary"),
    });
  }));

test("refuses diffs over 1 MiB instead of loading them", () =>
  withDirectory(async (directory) => {
    await repository(directory, { "big.txt": "start\n" });
    await writeFile(join(directory, "big.txt"), `${"line of filler text\n".repeat(80_000)}`);
    const repo = await openRepository(directory);
    const { changes } = await listChanges(repo);
    expect(await readPatch(repo, byPath(changes, "big.txt"))).toMatchObject({
      kind: "notice",
      message: expect.stringContaining("too large"),
    });
  }));

test("strips terminal control sequences from patch text", () =>
  withDirectory(async (directory) => {
    await repository(directory, { "a.txt": "safe\n" });
    await writeFile(join(directory, "a.txt"), "safe \u001b[2Jwiped ‮evil\n");
    const repo = await openRepository(directory);
    const patch = await readPatch(repo, byPath((await listChanges(repo)).changes, "a.txt"));
    if (patch.kind !== "text") throw new Error("Expected a text patch.");
    expect(patch.text).not.toContain("\u001b");
    expect(patch.text).not.toContain("‮");
    expect(patch.text).toContain("wiped");
  }));

test("treats unusual file names literally", () =>
  withDirectory(async (directory) => {
    const odd = "weird [name] *.txt";
    await repository(directory, { [odd]: "a\n", "other.txt": "b\n" });
    await writeFile(join(directory, odd), "changed\n");
    await writeFile(join(directory, "other.txt"), "also changed\n");
    const repo = await openRepository(directory);
    const { changes } = await listChanges(repo);
    expect(changes.map((change) => change.path).toSorted()).toEqual(["other.txt", odd].toSorted());
    const patch = await readPatch(repo, byPath(changes, odd));
    expect(patch.kind === "text" && patch.text).toContain("+changed");
    expect(patch.kind === "text" && patch.text).not.toContain("also changed");
  }));

test("never writes to the repository and never runs programs configured by it", () =>
  withDirectory(async (directory) => {
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
    await Promise.all(changes.map((change) => readPatch(repo, change)));

    const after = await stat(join(directory, ".git", "index"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(await Bun.file(marker).exists()).toBe(false);
    await rm(marker, { force: true });
    await closeRepository(repo);
    expect(await Bun.file(repo.indexFile).exists()).toBe(false);
  }));

test("works from a subdirectory and reports paths relative to the repository root", () =>
  withDirectory(async (directory) => {
    await repository(directory, { "pkg/inner.txt": "one\n" });
    await writeFile(join(directory, "pkg", "inner.txt"), "two\n");
    await symlink(join(directory, "pkg"), join(directory, "link"));
    const repo = await openRepository(join(directory, "pkg"));
    expect((await listChanges(repo)).changes.map((change) => change.path)).toEqual(["link", "pkg/inner.txt"]);
  }));

test("moves from the empty tree to HEAD once the first commit exists", () =>
  withDirectory(async (directory) => {
    await repository(directory);
    await writeFile(join(directory, "first.txt"), "hello\n");
    git(directory, "add", "first.txt");
    const repo = await openRepository(directory);
    expect((await listChanges(repo)).changes.map((change) => change.path)).toEqual(["first.txt"]);
    expect(repo.base).not.toBe("HEAD");

    git(directory, "commit", "--quiet", "-m", "first");
    expect(await listChanges(repo)).toEqual({ changes: [], truncated: false });
    expect(repo.base).toBe("HEAD");
  }));

test("reads every file's diff in one pass and matches each to its own file", () =>
  withDirectory(async (directory) => {
    await repository(directory, {
      "edited.txt": "one\ntwo\n",
      "my file.txt": "spaced\n",
      "gone.txt": "bye\n",
      "mode.sh": "echo\n",
      "image.bin": "x\n",
      "moved.txt": "a stable body\nthat is long enough\nto be recognised\n",
      "src/deep/inner.ts": "const a = 1;\n",
    });
    await writeFile(join(directory, "edited.txt"), "one\nTWO edited\n");
    await writeFile(join(directory, "my file.txt"), "spaced out\n");
    await writeFile(join(directory, "src/deep/inner.ts"), "const a = 2;\n");
    await rm(join(directory, "gone.txt"));
    await chmod(join(directory, "mode.sh"), 0o755);
    await writeFile(join(directory, "image.bin"), Buffer.from([0, 1, 2]));
    await rename(join(directory, "moved.txt"), join(directory, "renamed.txt"));
    git(directory, "add", "--all");
    await writeFile(join(directory, "fresh.txt"), "untracked\n");
    const repo = await openRepository(directory);
    const { changes } = await listChanges(repo);

    const all = await readAllPatches(repo, changes);
    expect(all.map((entry) => entry.change.path)).toEqual(changes.map((change) => change.path));
    const text = (path: string): string => {
      const patch = all.find((entry) => entry.change.path === path)?.patch;
      if (patch?.kind !== "text") throw new Error(`No text diff for ${path}.`);
      return patch.text;
    };
    expect(text("edited.txt")).toContain("+TWO edited");
    expect(text("edited.txt")).not.toContain("spaced");
    expect(text("my file.txt")).toContain("+spaced out");
    expect(text("gone.txt")).toContain("-bye");
    expect(text("src/deep/inner.ts")).toContain("+const a = 2;");
    expect(text("fresh.txt")).toContain("+untracked");
    const notice = (path: string): string => {
      const patch = all.find((entry) => entry.change.path === path)?.patch;
      if (patch?.kind !== "notice") throw new Error(`Expected a notice for ${path}.`);
      return patch.message;
    };
    expect(notice("image.bin")).toContain("Binary");
    expect(notice("mode.sh")).toContain("permissions");
    expect(notice("renamed.txt")).toContain("Renamed from moved.txt");
    // The same text, file by file, is what the single-file view shows.
    await Promise.all(all.map(async (entry) => expect(entry.patch).toEqual(await readPatch(repo, entry.change))));
  }));

test("stops reading diffs past the size budget and says so for the files it skipped", () =>
  withDirectory(async (directory) => {
    const names = Array.from({ length: 6 }, (_, index) => `big${index}.txt`);
    await repository(directory, Object.fromEntries(names.map((name) => [name, "start\n"])));
    await Promise.all(names.map((name) => writeFile(join(directory, name), "filler line of text\n".repeat(45_000))));
    const repo = await openRepository(directory);
    const all = await readAllPatches(repo, (await listChanges(repo)).changes);
    const shown = all.filter((entry) => entry.patch.kind === "text");
    const skipped = all.filter((entry) => entry.patch.kind === "notice");
    expect(shown.length).toBeGreaterThan(0);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((entry) => entry.patch.kind === "notice" && entry.patch.message.includes("Press a"))).toBe(
      true,
    );
    // What is shown is whole files from the start of the list, never half of one.
    expect(all.slice(0, shown.length).every((entry) => entry.patch.kind === "text")).toBe(true);
  }));

test("sees a same-size edit made in the same second the index was written", () =>
  withDirectory(async (directory) => {
    // Git trusts a file whose size and modification time match the index, unless the entry is "racy": no older than
    // the index file itself. The private index copy must keep the original's timestamp or that safeguard is lost.
    await repository(directory);
    git(directory, "config", "core.trustctime", "false");
    const past = new Date("2020-01-01T00:00:00Z");
    const file = join(directory, "a.txt");
    await writeFile(file, "one\n");
    await utimes(file, past, past);
    git(directory, "add", "a.txt");
    git(directory, "commit", "--quiet", "-m", "initial");
    await utimes(join(directory, ".git", "index"), past, past);
    await writeFile(file, "two\n");
    await utimes(file, past, past);

    const repo = await openRepository(directory);
    const { changes } = await listChanges(repo);
    expect(changes.map((change) => [change.path, change.kind])).toEqual([["a.txt", "modified"]]);
    const patch = await readPatch(repo, changes[0]!);
    expect(patch.kind === "text" && patch.text).toContain("+two");
  }));
