# Sluice

A Firefox extension that makes every tab disposable. You close all your tabs whenever you step away. Anything you mean to come back to sits in a queue that decays on a schedule, so the queues can't grow into a second backlog.

Status: under construction. The [design](docs/design.md) defines the intended behavior.

## Development

Requires Node 24+ and [Dagger](https://dagger.io) v1.0.0-beta.15 or later.

```sh
npm ci
npm run build      # bundle into dist/
npm run watch      # rebuild on change
npm start          # run Firefox with dist/ loaded as a temporary add-on

dagger check       # unit tests, type check and web-ext lint, in containers
```

## Release

Releasing bumps the version and signs an unlisted `.xpi` with
[AMO](https://addons.mozilla.org) API keys. Set the two keys first:

```sh
export WEB_EXT_API_KEY=...
export WEB_EXT_API_SECRET=...
```

Then run:

```sh
npm run release           # bumps the patch version (default)
npm run release minor
npm run release major
```

This bumps `package.json`, `package-lock.json` and `src/manifest.json` to the
same new version, builds the extension, and signs `dist/` with
`web-ext sign --channel=unlisted`. The signed `.xpi` lands in
`web-ext-artifacts/`, which git ignores. If the build or the signing fails,
the script restores the previous version in all three files and exits
non-zero.

Install the signed `.xpi` by dragging it into a Firefox window.

See [AGENTS.md](AGENTS.md) for the layout and contribution rules.
