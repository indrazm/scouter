import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { git, withDirectory } from "./fixtures";

const root = join(import.meta.dir, "..");
const installer = join(root, "install.sh");

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(
  command: string[],
  options: { env?: Record<string, string>; cwd?: string; stdin?: string } = {},
): Promise<Run> {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

/** A stand-in for the GitHub repository: this working tree, committed and tagged, in a temporary folder. */
async function upstream(directory: string, tag: string): Promise<string> {
  const target = join(directory, "upstream");
  await mkdir(target, { recursive: true });
  const files = (await run(["git", "ls-files", "--cached", "--others", "--exclude-standard"])).out
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(root, file), join(target, file));
  }
  git(target, "init", "--quiet", "--initial-branch=main");
  git(target, "add", "--all");
  git(target, "commit", "--quiet", "-m", "release");
  git(target, "tag", tag);
  return target;
}

test("prints usage, and rejects unknown options with a non-zero exit", async () => {
  const help = await run(["bash", installer, "--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("scouter --upgrade");
  expect(help.out).toContain("SCOUTER_HOME");

  const unknown = await run(["bash", installer, "--nonsense"]);
  expect(unknown.code).toBe(2);
  expect(unknown.err).toContain("unknown option: --nonsense");
});

test("says what to do when Bun is not installed", () =>
  withDirectory(async (directory) => {
    const result = await run(["/bin/bash", installer], { env: { PATH: directory } });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Bun is required");
    expect(result.err).toContain("https://bun.sh");
  }));

test("will not install over a folder or a command that is not its own", () =>
  withDirectory(async (directory) => {
    const source = await upstream(directory, "v0.1.0");
    const foreign = join(directory, "foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, "precious.txt"), "do not delete");
    const env = {
      SCOUTER_REPO: pathToFileURL(source).href,
      SCOUTER_HOME: foreign,
      SCOUTER_BIN_DIR: join(directory, "bin"),
    };

    const install = await run(["bash"], { env, stdin: await readFile(installer, "utf8") });
    expect(install.code).toBe(1);
    expect(install.err).toContain("was not created by this installer");

    const uninstall = await run(["bash", installer, "--uninstall"], { env });
    expect(uninstall.code).toBe(0);
    expect(await readFile(join(foreign, "precious.txt"), "utf8")).toBe("do not delete");

    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "scouter"), "#!/bin/sh\necho someone else's program\n");
    await chmod(join(bin, "scouter"), 0o755);
    await run(["bash", installer, "--uninstall"], { env: { ...env, SCOUTER_HOME: join(directory, "nothing") } });
    expect(await readFile(join(bin, "scouter"), "utf8")).toContain("someone else's program");
  }));

test(
  "installs a release, runs safely from any folder, upgrades itself and uninstalls",
  () =>
    withDirectory(async (directory) => {
      const source = await upstream(directory, "v0.1.0");
      // A space in the path: everything the installer writes must survive it.
      const home = join(directory, "with space", "home");
      const bin = join(directory, "bin");
      const env = { SCOUTER_REPO: pathToFileURL(source).href, SCOUTER_HOME: home, SCOUTER_BIN_DIR: bin };
      const scouter = join(bin, "scouter");

      // Piped, like `curl ... | bash`: there is no checkout, so it downloads the newest release tag.
      const install = await run(["bash"], { env, stdin: await readFile(installer, "utf8") });
      expect(install.err).toBe("");
      expect(install.out).toContain("Downloading Scouter (v0.1.0)");
      expect(install.out).toContain("Installed scouter 0.1.0");
      expect((await run([scouter, "--version"])).out).toBe("scouter 0.1.0\n");

      // The folder being viewed must not be able to run code through Bun's own configuration.
      const hostile = join(directory, "hostile");
      await mkdir(hostile);
      await writeFile(join(hostile, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
      await writeFile(join(hostile, "evil.ts"), 'await Bun.write(new URL("./PWNED", import.meta.url), "ran");\n');
      await writeFile(join(hostile, ".env"), "SCOUTER_TEST=1\n");
      expect((await run([scouter, "--version"], { cwd: hostile })).out).toBe("scouter 0.1.0\n");
      expect(await Bun.file(join(hostile, "PWNED")).exists()).toBe(false);

      // Nothing newer yet.
      const same = await run([scouter, "--upgrade"]);
      expect(same.code).toBe(0);
      expect(same.out).toContain("Already up to date: scouter 0.1.0");

      // A new release appears; the installed command finds it and replaces itself.
      const manifest = join(source, "package.json");
      await writeFile(manifest, (await readFile(manifest, "utf8")).replace('"version": "0.1.0"', '"version": "0.1.1"'));
      git(source, "commit", "--quiet", "--all", "-m", "bump");
      git(source, "tag", "v0.1.1");
      const upgrade = await run([scouter, "--upgrade"]);
      expect(upgrade.code).toBe(0);
      expect(upgrade.out).toContain("Updating Scouter (v0.1.1)");
      expect(upgrade.out).toContain("Upgraded: 0.1.0 → 0.1.1");
      expect((await run([scouter, "--version"])).out).toBe("scouter 0.1.1\n");

      const removal = await run(["bash", installer, "--uninstall"], { env });
      expect(removal.code).toBe(0);
      expect(await Bun.file(scouter).exists()).toBe(false);
      expect(await Bun.file(join(home, "package.json")).exists()).toBe(false);
    }),
  60_000,
);

test(
  "a checkout install links to the checkout in place, and refuses to upgrade it",
  () =>
    withDirectory(async (directory) => {
      const bin = join(directory, "bin");
      const env = { SCOUTER_BIN_DIR: bin };
      const install = await run(["bash", installer], { env });
      expect(install.out).toContain(`Installing from this checkout: ${root}`);
      const scouter = join(bin, "scouter");
      expect((await run([scouter, "--version"])).out).toMatch(/^scouter \d+\.\d+\.\d+\n$/);

      const upgrade = await run([scouter, "--upgrade"]);
      expect(upgrade.code).toBe(1);
      expect(upgrade.err).toContain("runs from a checkout");

      await run(["bash", installer, "--uninstall"], { env });
      expect(await Bun.file(scouter).exists()).toBe(false);
      // The checkout it linked to is never deleted.
      expect(await Bun.file(join(root, "src", "index.ts")).exists()).toBe(true);
    }),
  60_000,
);
