import { afterEach, expect, test } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(failure: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "sluice-release-"));
  directories.push(dir);
  await mkdir(path.join(dir, "src"));
  await mkdir(path.join(dir, "bin"));
  await copyFile(new URL("../scripts/release.mjs", import.meta.url), path.join(dir, "release.mjs"));
  const files = ["package.json", "package-lock.json", "src/manifest.json"];
  for (const file of files) await writeFile(path.join(dir, file), '{"version":"0.0.0"}\n');
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync('commands.jsonl', JSON.stringify([command, ...args]) + '\\n');
const stage = command === 'dagger' ? 'check' : command === 'npx' ? 'sign' : args[0];
if (stage === 'version') {
  fs.writeFileSync('package.json', JSON.stringify({version:'0.1.0'}));
  if (process.env.RELEASE_TEST_FAILURE === 'version') process.exit(1);
  fs.writeFileSync('package-lock.json', JSON.stringify({version:'0.1.0'}));
  console.log('v0.1.0');
}
if (process.env.RELEASE_TEST_FAILURE === stage) process.exit(1);
if (stage === 'sign') {
  fs.mkdirSync('web-ext-artifacts');
  fs.writeFileSync('web-ext-artifacts/sluice-0.1.0.xpi', 'test artifact');
}
`;
  for (const name of ["npm", "npx", "dagger"]) {
    const executable = path.join(dir, "bin", name);
    await writeFile(executable, fake);
    await chmod(executable, 0o755);
  }
  const result = spawnSync(process.execPath, ["release.mjs", "minor"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      WEB_EXT_API_KEY: "fixture-key",
      WEB_EXT_API_SECRET: "fixture-secret",
      RELEASE_TEST_FAILURE: failure,
    },
  });
  const contents = await Promise.all(files.map((file) => readFile(path.join(dir, file), "utf8")));
  const commands = (await readFile(path.join(dir, "commands.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { result, contents, commands };
}

test.each(["check", "version", "run", "sign"])("release failure at %s preserves all version files", async (failure) => {
  const { result, contents, commands } = await fixture(failure);
  expect(result.status).not.toBe(0);
  expect(contents).toEqual(Array(3).fill('{"version":"0.0.0"}\n'));
  if (failure === "check") expect(commands).toEqual([["dagger", "check", "--progress=report"]]);
});

test("release validates before bumping, builds, and signs the matching version", async () => {
  const { result, contents, commands } = await fixture("");
  expect(result.status, result.stderr).toBe(0);
  expect(contents.map((value) => JSON.parse(value).version)).toEqual(Array(3).fill("0.1.0"));
  expect(commands.map((command) => command.slice(0, 2))).toEqual([
    ["dagger", "check"], ["npm", "version"], ["npm", "run"], ["npx", "web-ext"],
  ]);
  expect(result.stdout).toContain("Signed .xpi: web-ext-artifacts/sluice-0.1.0.xpi");
});
