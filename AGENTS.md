# Working on Sluice

## Design and scope

- Read [docs/design.md](docs/design.md) before proposing, planning or implementing a feature. It is the source of truth, including its answered open questions and its amendments, which override the sections they contradict.
- Keep behavior and the design consistent. Surface a conflict with the design instead of silently changing product scope.
- Repository bootstrap, the build, the manifest and the Dagger checks are already set up. Do not repeat them.
- Firefox only, Manifest V3. Do not add Chrome shims or a polyfill; use the global `browser` namespace.

## Layout

| Path | Holds |
| --- | --- |
| `src/manifest.json` | The extension manifest, copied into `dist/` as is |
| `src/background/` | The background script: revisit matching, the periodic alarm, away-gap detection, wash and tab auto-close |
| `src/newtab/` | The new tab page (launcher, triage, recently closed, banners) |
| `src/popup/` | The toolbar popup (add form, pause control) |
| `src/options/` | The options page (buckets, pauses, settings) |
| `src/lib/` | Code shared by the entry points: the data model, due-time math, URL normalization and the storage module |
| `scripts/build.mjs` | Bundles each entry point with esbuild and copies the manifest and HTML into `dist/` |
| `.dagger/modules/sluice/` | The Dagger module behind `dagger check` |

Each entry point is `src/<name>/index.ts`; pages also have `src/<name>/index.html`, which loads `<name>.js`. A new entry point needs a line in `scripts/build.mjs` and the manifest.

## Architecture guardrails

- The background script holds no state between events. All state lives in `storage.local`, and every read and write goes through one storage module in `src/lib/`.
- Overdue state is computed on read, never stored. Keep due-time math, pause merging and URL normalization as pure functions with no `browser` access, so they can be unit tested directly.
- Request only the permissions in the design's table. `src/manifest.test.ts` enforces the list; change both together when the design changes.
- No runtime dependencies without a concrete need. Plain DOM or Preact for UI, nothing heavier.

## Validation

- Run every check before declaring a change complete:

  ```sh
  dagger check --progress=report
  ```

  This runs the unit tests, `tsc --noEmit` and `web-ext lint` on the built extension, each in a container with dependencies installed from `package-lock.json`.
- Unit tests are `*.test.ts` files beside the code they test, under `src/`. Vitest runs them in Node; there is no browser. Pass the `browser` API into code under test, or fake it, rather than reaching for a global.
- Each test file is a collection item. Select test files while iterating:

  ```sh
  dagger check --progress=report --sluice-test=src/lib/normalize.test.ts
  dagger check --progress=report --check test          # every test file
  dagger list checks --all -f=link                     # every check's link
  ```

  `--progress=report` names a failing check by its link; pass the link back to `dagger check`, quoted, to rerun exactly that check.
- `npm test`, `npm run typecheck` and `npm run lint` run the same tools on the host and are fine for quick iteration, but `dagger check` is the gate.
- Add meaningful tests for changed behavior and regressions, especially due-time math with pauses, URL normalization rules, uniqueness on add, and wash and auto-close decisions.
- Report the checks actually run and their results. If validation is blocked, state the exact blocker; do not report success.

## Housekeeping

- Keep changes focused. Avoid unrelated refactors, generated churn and dependencies without a concrete need.
- Keep `package-lock.json` and `dagger.lock` consistent with dependency changes, and commit them.
- Keep build output (`dist/`, `web-ext-artifacts/`), credentials and AMO API keys out of version control. Reference secrets through environment variables.
- Update documentation with user-visible behavior and configuration changes. Keep the README concise while the extension is under construction.

## Comments and documentation

- Comments and documentation always describe the current state. Never reference how things used to work.
- Name code, tests, documentation and user-facing messages after product features and behavior, without development phase labels.
- Comments and documentation never reference GitHub issues, pull requests or commits.
- Comment blocks can describe a function's API or specific behavior of nearby code, never a whole feature. That belongs in the design or other documentation.
