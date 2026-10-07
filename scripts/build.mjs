// Bundles the extension into dist/. Pass --watch to rebuild on change.
import { cp, mkdir, rm } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const pages = ["newtab", "popup", "options"];

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("src/manifest.json", "dist/manifest.json");
await cp("src/common.css", "dist/common.css");
await cp("src/icon.svg", "dist/icon.svg");
for (const page of pages) {
  await cp(`src/${page}/index.html`, `dist/${page}.html`);
}

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    ...Object.fromEntries(pages.map((page) => [page, `src/${page}/index.ts`])),
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "firefox142",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
