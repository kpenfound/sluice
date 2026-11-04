// Bumps the version and submits for AMO review. Usage: npm run release [patch|minor|major].
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { packageSource } from "./package-source.mjs";

const VALID_KINDS = ["patch", "minor", "major"];
const SNAPSHOT_FILES = ["package.json", "package-lock.json", "src/manifest.json"];
const ARTIFACTS_DIR = "web-ext-artifacts";
const METADATA_FILE = "scripts/amo-metadata.json";

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

// Catch missing or malformed listing material before changing any version file.
JSON.parse(await readFile(METADATA_FILE, "utf8"));

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

let version;
try {
  // Validate the exact source being released before changing any version files.
  run("dagger", ["check", "--progress=report"]);

  const versionOutput = execFileSync("npm", ["version", kind, "--no-git-tag-version"], {
    encoding: "utf8",
  }).trim();
  version = versionOutput.replace(/^v/, "");

  const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
  manifest.version = version;
  await writeFile("src/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  run("npm", ["run", "build"]);
  const sourcePackage = await packageSource(version, ARTIFACTS_DIR);
  run("npx", [
    "web-ext",
    "sign",
    "--channel=listed",
    "--amo-metadata",
    METADATA_FILE,
    "--upload-source-code",
    sourcePackage,
    "--approval-timeout=0",
    "--source-dir",
    "dist",
    "--artifacts-dir",
    ARTIFACTS_DIR,
  ]);
} catch (error) {
  await restoreSnapshots();
  fail(`Release failed, restored previous version: ${error.message}`);
}

console.log(`Version ${version} submitted and awaiting AMO review.`);
