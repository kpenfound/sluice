# Sluice

A Firefox extension that makes every tab disposable. You close all your tabs whenever you step away. Anything you mean to come back to sits in a queue that decays on a schedule, so the queues can't grow into a second backlog.

Firefox 142+ · Manifest V3 · Personal installation. The [design](docs/design.md) defines the behavior.

## Using Sluice

- On a web page, press **Alt+Shift+S** or click Sluice to queue it. Choose a bucket and a riffle; Enter saves. The default is 72h and your last-used bucket.
- Open a new tab to search all queues, move or defer items, and resolve finished work. An overdue item stays queued until you act on it; Stale has no deadline. Visits to queued URLs reset their timers.
- Inactive web tabs close after **2 hours** by default. Settings changes the timeout. Active tabs in every window, audio-playing tabs, and tabs marked **Keep open** are protected. Countdown cues appear in the launcher's Open tabs list.
- **Wash** opens triage across normal windows. File what you need, then confirm. Pressing the wash shortcut again or choosing **Wash now** skips triage. Audio-playing and Keep open tabs remain; private windows are untouched.
- **Recently closed** holds unqueued HTTP(S) URLs for up to **7 days / 100 entries**, deduplicated by URL. Reopen or file them from the launcher. Internal pages and local files are not retained, including after a wash.
- **Pause** freezes queue deadlines, not tab auto-close. Settings supports past and future pauses. After Firefox has been closed for more than 72 hours, the launcher offers to pause the gap before queue triage.

Set Wash and Open launcher shortcuts in Firefox's **Add-ons Manager → gear menu → Manage Extension Shortcuts**. The launcher shows its keyboard controls and links to Settings. Firefox asks to confirm the new-tab replacement; only one extension can own it.

Data stays in this Firefox profile's local extension storage. There is no sync, export, telemetry, or page-content access. Favicons may load from the sites that supplied them. Removing the extension removes its saved data.

## Development

Requires Node 24+ and [Dagger](https://dagger.io) v1.0.0-beta.15 or later.

```sh
npm ci
npm run build      # bundle into dist/
npm run watch      # rebuild on change
npm start          # run Firefox with dist/ loaded as a temporary add-on

dagger check --progress=report # unit tests, type check and web-ext lint, in containers
```

## Install in your own Firefox

For everyday use in your normal Firefox profile, install a **signed, unlisted XPI**. This does not publish Sluice on addons.mozilla.org or require sharing it with anyone. Standard Firefox requires Mozilla signing for permanent installation, even for personal use. The extension package is uploaded to Mozilla for signing. See [Mozilla's signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

The script named `release` builds that personal installation package. With Node, Dagger and its container engine available, obtain signing API credentials from your [AMO developer account](https://addons.mozilla.org/developers/) and set them locally:

```sh
export WEB_EXT_API_KEY=...
export WEB_EXT_API_SECRET=...
```

Then run:

```sh
npm run release minor     # initial release: 0.0.0 → 0.1.0
npm run release           # subsequent patch release (default)
npm run release major
```

This first runs `dagger check --progress=report`, then bumps `package.json`, `package-lock.json` and `src/manifest.json` to the
same new version, builds the extension, and signs `dist/` with
`web-ext sign --channel=unlisted`. The signed `.xpi` lands in
`web-ext-artifacts/`, which git ignores. If the version update, build or signing fails,
the script restores the previous version in all three files and exits
non-zero.

Install the signed `.xpi` from `web-ext-artifacts/` by dragging it into your normal Firefox window, or use **about:addons → gear menu → Install Add-on From File**. Confirm installation and the new-tab override. It stays installed across Firefox restarts. No public listing or hosting is needed.

For updates, run `npm run release` and install the new signed XPI over the existing extension; do not uninstall first, since uninstalling removes saved data. Sluice does not configure automatic updates. The [smoke checks](docs/release.md) cover installation, restart persistence and tab behavior.

### Try it without signing

Run `npm run build`, then in your normal Firefox open **about:debugging → This Firefox → Load Temporary Add-on** and select `dist/manifest.json`. No AMO credentials are needed. This installation lasts only until Firefox restarts, so use the signed installation for everyday use. [Mozilla's temporary-install instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) describe these limits.

`npm start` also loads a temporary add-on, but launches a separate temporary Firefox profile rather than installing it into your normal browser.

See [AGENTS.md](AGENTS.md) for the layout and contribution rules.
