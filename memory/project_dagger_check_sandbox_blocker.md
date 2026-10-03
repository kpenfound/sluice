---
name: dagger-check-sandbox-blocker
description: dagger check cannot run from a mason sandbox in this project; use npm test/typecheck/lint locally instead
metadata:
  type: project
---

In the sluice project's mason sandboxes, `dagger check` (and even `dagger workspace ls`/`cat`) cannot see the sandbox's own files: the CLI reports the correct workspace root path, but any file read against it fails with "no such file or directory", and `dagger check -l` lists zero checks. The sandbox talks to a shared remote engine via `_EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://host.docker.internal:53910`, which appears not to have this sandbox's filesystem synced in. Falling back to a local engine (`env -u _EXPERIMENTAL_DAGGER_RUNNER_HOST dagger ...`) also fails: pulling `registry.dagger.io/engine:...` gets a 403 "Approval required for registry.dagger.io" from the sandbox network policy. `git` is also not granted to this session, so git-based workspace detection paths error too.

**Why:** This is an infrastructure/environment constraint of the mason sandbox, not something fixable from inside it (no root, no policy-approval tool, registry pull needs host-side approval).
**How to apply:** For lib-model (and likely sibling units normalize/due/pauses/store in workstream 1), don't block on getting `dagger check` to run yourself. Instead run `npm ci`, then `npm test`, `npm run typecheck`, and `npm run lint` directly (AGENTS.md confirms these run the same tools as `dagger check` and are fine for iteration) and report that `dagger check` itself was unreachable from the sandbox. The osmia service runs project checks on the submitted candidate after `done` is called, so the real gate still gets applied outside the sandbox.
