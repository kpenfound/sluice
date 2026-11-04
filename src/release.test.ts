import { afterEach, expect, test } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
const tar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
const versionFiles = ["package.json", "package-lock.json", "src/manifest.json"];
const original = '{"version":"0.0.0"}\n';
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(failure = "", metadata = "valid") {
  const dir = await mkdtemp(path.join(tmpdir(), "sluice-release-"));
  directories.push(dir);
  for (const folder of ["src", "scripts", "bin", "node_modules", "dist", "web-ext-artifacts", "src/node_modules"]) {
    await mkdir(path.join(dir, folder), { recursive: true });
  }
  for (const file of ["release.mjs", "package-source.mjs", "source-README.md", "amo-metadata.json", "build.mjs"]) {
    await copyFile(new URL(`../scripts/${file}`, import.meta.url), path.join(dir, "scripts", file));
  }
  if (metadata === "missing") await rm(path.join(dir, "scripts/amo-metadata.json"));
  if (metadata === "malformed") await writeFile(path.join(dir, "scripts/amo-metadata.json"), "{");
  for (const file of versionFiles) await writeFile(path.join(dir, file), original);
  await copyFile(new URL("../tsconfig.json", import.meta.url), path.join(dir, "tsconfig.json"));
  await copyFile(new URL("../LICENSE", import.meta.url), path.join(dir, "LICENSE"));
  // These working files have no git history. The archive must use their current contents.
  await writeFile(path.join(dir, "src/input.ts"), 'export const bucket = "Default";\n');
  for (const file of [".env", ".npmrc", "secret.pem", ".amo-upload-uuid", "src/.env", "src/private.key",
    "src/node_modules/secret", "node_modules/secret", "dist/old.xpi", "web-ext-artifacts/old.xpi"]) {
    await writeFile(path.join(dir, file), "fixture credentials or excluded output");
  }
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const files = ['package.json', 'package-lock.json', 'src/manifest.json'];
fs.appendFileSync('commands.jsonl', JSON.stringify([command, ...args]) + '\\n');
const stage = command === 'dagger' ? 'check' : command === 'npx' ? 'submission' : command === 'tar' ? 'package' : args[0] === 'run' ? 'build' : args[0];
if (stage === 'check') fs.writeFileSync('gate-versions.json', JSON.stringify(files.map(file => fs.readFileSync(file, 'utf8'))));
if (stage === 'version') {
  fs.writeFileSync('package.json', JSON.stringify({version:'0.1.0'}));
  if (process.env.RELEASE_TEST_FAILURE === 'version') process.exit(1);
  fs.writeFileSync('package-lock.json', JSON.stringify({version:'0.1.0', packages:{'':{version:'0.1.0'}}}));
  console.log('v0.1.0');
}
if (stage === 'build') fs.writeFileSync('built-versions.json', JSON.stringify(files.map(file => JSON.parse(fs.readFileSync(file)).version)));
if (process.env.RELEASE_TEST_FAILURE === stage) process.exit(1);
if (stage === 'package') {
  const result = spawnSync(process.env.RELEASE_TEST_TAR, args, {stdio:'inherit'});
  process.exit(result.status ?? 1);
}
if (stage === 'submission') {
  const metadata = args[args.indexOf('--amo-metadata') + 1];
  const source = args[args.indexOf('--upload-source-code') + 1];
  if (!args.includes('--channel=listed') || !args.includes('--approval-timeout=0')) process.exit(2);
  JSON.parse(fs.readFileSync(metadata, 'utf8'));
  if (!fs.statSync(source).size) process.exit(3);
  fs.writeFileSync('submission.json', JSON.stringify({metadata, source}));
  // AMO accepted the version for review; no signed artifact is downloaded.
}
`;
  for (const name of ["npm", "npx", "dagger", "tar"]) {
    const executable = path.join(dir, "bin", name);
    await writeFile(executable, fake);
    await chmod(executable, 0o755);
  }
  const result = spawnSync(process.execPath, ["scripts/release.mjs", "minor"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      WEB_EXT_API_KEY: "fixture-key",
      WEB_EXT_API_SECRET: "fixture-secret",
      RELEASE_TEST_FAILURE: failure,
      RELEASE_TEST_TAR: tar,
    },
  });
  const contents = await Promise.all(versionFiles.map((file) => readFile(path.join(dir, file), "utf8")));
  const commandLog = await readFile(path.join(dir, "commands.jsonl"), "utf8").catch(() => "");
  const commands: string[][] = commandLog.trim() ? commandLog.trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { dir, result, contents, commands };
}

test.each(["check", "version", "build", "package", "submission"])("release failure at %s restores all version files", async (failure) => {
  const { dir, result, contents, commands } = await fixture(failure);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("restored previous version");
  expect(contents).toEqual(Array(3).fill(original));
  expect(JSON.parse(await readFile(path.join(dir, "gate-versions.json"), "utf8"))).toEqual(Array(3).fill(original));
  if (failure === "check") expect(commands).toEqual([["dagger", "check", "--progress=report"]]);
  if (failure === "package") expect(commands.some((command) => command[0] === "npx")).toBe(false);
});

test.each(["missing", "malformed"])("%s metadata fails before validation or version changes", async (metadata) => {
  const { result, contents, commands } = await fixture("", metadata);
  expect(result.status).not.toBe(0);
  expect(contents).toEqual(Array(3).fill(original));
  expect(commands).toEqual([]);
});

test("release validates before bumping, builds and submits matching source without waiting for approval", async () => {
  const { dir, result, contents, commands } = await fixture();
  expect(result.status, result.stderr).toBe(0);
  expect(contents.map((value) => JSON.parse(value).version)).toEqual(Array(3).fill("0.1.0"));
  expect(JSON.parse(contents[1]!).packages[""].version).toBe("0.1.0");
  expect(JSON.parse(await readFile(path.join(dir, "gate-versions.json"), "utf8"))).toEqual(Array(3).fill(original));
  expect(JSON.parse(await readFile(path.join(dir, "built-versions.json"), "utf8"))).toEqual(Array(3).fill("0.1.0"));
  expect(commands.map((command) => command.slice(0, 2))).toEqual([
    ["dagger", "check"], ["npm", "version"], ["npm", "run"], ["tar", "-czf"], ["npx", "web-ext"],
  ]);
  expect(commands.at(-1)).toEqual([
    "npx", "web-ext", "sign", "--channel=listed", "--amo-metadata", "scripts/amo-metadata.json",
    "--upload-source-code", "web-ext-artifacts/sluice-0.1.0-source.tar.gz", "--approval-timeout=0",
    "--source-dir", "dist", "--artifacts-dir", "web-ext-artifacts",
  ]);
  expect(JSON.parse(await readFile(path.join(dir, "submission.json"), "utf8"))).toEqual({
    metadata: "scripts/amo-metadata.json", source: "web-ext-artifacts/sluice-0.1.0-source.tar.gz",
  });
  expect(result.stdout).toContain("Version 0.1.0 submitted and awaiting AMO review.");
  expect(result.stdout).not.toContain("Signed .xpi");
  // A stale signing artifact must never be reported as this release's result.
  expect(result.stdout).not.toContain("old.xpi");
});

test("source archive contains the working build inputs and bumped versions, excluding credentials and output", async () => {
  const { dir, result } = await fixture();
  expect(result.status, result.stderr).toBe(0);
  const extracted = path.join(dir, "extracted");
  await mkdir(extracted);
  const archive = path.join(dir, "web-ext-artifacts/sluice-0.1.0-source.tar.gz");
  const unpack = spawnSync(tar, ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
  expect(unpack.status, unpack.stderr).toBe(0);
  for (const file of versionFiles) {
    expect(await readFile(path.join(extracted, file), "utf8")).toBe(await readFile(path.join(dir, file), "utf8"));
    expect(JSON.parse(await readFile(path.join(extracted, file), "utf8")).version).toBe("0.1.0");
  }
  for (const file of ["src/input.ts", "scripts/build.mjs", "tsconfig.json", "LICENSE"]) {
    expect(await readFile(path.join(extracted, file), "utf8")).toBe(await readFile(path.join(dir, file), "utf8"));
  }
  const instructions = await readFile(path.join(extracted, "README.md"), "utf8");
  for (const text of ["Node.js 24", "npm 11", "npm ci", "npm run build", "dist/", "Submitted version: 0.1.0"]) {
    expect(instructions).toContain(text);
  }
  const listing = spawnSync(tar, ["-tzf", archive], { encoding: "utf8" }).stdout;
  expect(listing).not.toMatch(/node_modules|dist\/|web-ext-artifacts|\.env|\.npmrc|secret\.pem|private\.key|amo-upload|\.xpi/);
});

test("release script contains no unlisted channel", async () => {
  expect(await readFile(new URL("../scripts/release.mjs", import.meta.url), "utf8")).not.toContain("unlisted");
});
