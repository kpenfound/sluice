// Archive the working build inputs, including the release's bumped versions.
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function packageSource(version, artifactsDir) {
  const staging = await mkdtemp(path.join(tmpdir(), "sluice-source-"));
  const archive = path.join(artifactsDir, `sluice-${version}-source.tar.gz`);
  try {
    await mkdir(path.join(staging, "scripts"));
    // Explicit roots keep local configuration, credentials and artifacts out.
    for (const file of ["package.json", "package-lock.json", "tsconfig.json", "LICENSE", "scripts/build.mjs"]) {
      await cp(file, path.join(staging, file));
    }
    await cp("src", path.join(staging, "src"), {
      recursive: true,
      filter: async (file) => {
        const name = path.basename(file);
        if (name.startsWith(".") || ["node_modules", "dist", "web-ext-artifacts"].includes(name)
          || /\.(pem|key|p12|pfx)$/i.test(name)) return false;
        if ((await lstat(file)).isSymbolicLink()) {
          throw new Error(`Source package cannot contain symlinks: ${file}`);
        }
        return true;
      },
    });
    const instructions = await readFile(new URL("./source-README.md", import.meta.url), "utf8");
    await writeFile(path.join(staging, "README.md"),
      `${instructions}\nSubmitted version: ${version}\nBuild host: Node ${process.version}, ${process.platform} ${process.arch}.\n`);
    await mkdir(artifactsDir, { recursive: true });
    execFileSync("tar", ["-czf", path.resolve(archive), "-C", staging, "."], { stdio: "inherit" });
    return archive;
  } catch (error) {
    await rm(archive, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
