// Bumps the version and signs an unlisted .xpi. Usage: npm run release [patch|minor|major].
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const VALID_KINDS = ["patch", "minor", "major"];
const SNAPSHOT_FILES = ["package.json", "package-lock.json", "src/manifest.json"];
const ARTIFACTS_DIR = "web-ext-artifacts";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const kind = process.argv[2] ?? "patch";
if (!VALID_KINDS.includes(kind)) {
  fail(`Usage: npm run release [${VALID_KINDS.join("|")}] (default: patch)`);
}

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  fail(
    "WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set to the AMO API keys before running the release.",
  );
}

const snapshots = new Map();
for (const file of SNAPSHOT_FILES) {
  snapshots.set(file, await readFile(file, "utf8"));
}

async function restoreSnapshots() {
  for (const [file, contents] of snapshots) {
    await writeFile(file, contents);
  }
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

const versionOutput = execFileSync("npm", ["version", kind, "--no-git-tag-version"], {
  encoding: "utf8",
}).trim();
const version = versionOutput.replace(/^v/, "");

const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
manifest.version = version;
await writeFile("src/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

try {
  run("npm", ["run", "build"]);
  run("npx", [
    "web-ext",
    "sign",
    "--channel=unlisted",
    "--source-dir",
    "dist",
    "--artifacts-dir",
    ARTIFACTS_DIR,
  ]);
} catch (error) {
  await restoreSnapshots();
  fail(`Release failed, restored previous version: ${error.message}`);
}

const artifacts = await readdir(ARTIFACTS_DIR);
const xpiFiles = await Promise.all(
  artifacts
    .filter((name) => name.endsWith(".xpi"))
    .map(async (name) => {
      const filePath = path.join(ARTIFACTS_DIR, name);
      return { filePath, mtime: (await stat(filePath)).mtimeMs };
    }),
);
xpiFiles.sort((a, b) => b.mtime - a.mtime);

console.log(`Released version ${version}`);
if (xpiFiles.length > 0) {
  console.log(`Signed .xpi: ${xpiFiles[0].filePath}`);
} else {
  console.log(`Signed .xpi in ${ARTIFACTS_DIR}/`);
}
