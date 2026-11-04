# Rebuild Sluice for AMO review

Use Node.js 24 and npm 11 (the Mozilla reviewer defaults). Install Node from
https://nodejs.org/en/download; its distribution includes npm. Linux (including
Ubuntu 24.04 on ARM64), macOS and Windows are supported by the build tools.
The build host used to create this submission is recorded below.

Extract this archive, open a terminal in its root and run:

```sh
npm ci
npm run build
```

Network access is needed for npm to download the development tools pinned by
package-lock.json. esbuild bundles the TypeScript entry points; scripts/build.mjs
copies the manifest, HTML, CSS and icon. The complete extension is written to
dist/, including source maps. Compare that directory with the submitted extension.
There are no runtime dependencies, private packages, generated inputs or secrets
needed for the build. No signing credentials or container tools are required.

Do not bump the version: package.json, package-lock.json and src/manifest.json
already contain the submitted version. The included source is copied from the
working files used for the release build.
