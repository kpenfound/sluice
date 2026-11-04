# Sluice

A Firefox extension that makes every tab disposable. Queue pages to revisit on a schedule, and close tabs when you step away. Sluice replaces your new tab page with a queue launcher and closes inactive web tabs after **two hours by default**.

Firefox 142+ · Manifest V3. The [design](docs/design.md) defines the behavior.

## Install and use

Install Sluice from **addons.mozilla.org (AMO)** once its listing is approved. Firefox delivers approved updates automatically. Confirm the new-tab replacement when Firefox asks; only one extension can own the new tab page at a time.

- Start with one **Default** bucket. Rename it or add buckets in **Settings**.
- Press **Alt+Shift+S** or click Sluice on a web page to queue it. Choose a bucket and a riffle: 24h, 72h, 1w or 1mo. Enter saves; the defaults are 72h and your last-used bucket.
- A new tab shows one queue for the selected bucket, ordered by soonest due. Search covers all buckets and Stale. Move, defer or resolve items; overdue items stay queued until you act. Visits reset their timers. The **Stale** entry holds items without deadlines.
- **Open tabs** and **Recently closed** start collapsed. Settings changes the auto-close timeout; active tabs in every window, audio-playing tabs and **Keep open** tabs are protected. Recently closed holds unqueued HTTP(S) pages for up to **7 days / 100 entries** to reopen or file.
- **Wash** opens triage across normal windows. File what you need, then confirm. Pressing the Wash shortcut again or choosing **Wash now** skips triage. Audio-playing and Keep open tabs remain; private windows are untouched.
- **Pause** freezes queue deadlines. Settings supports past, future and automatic weekend pauses. After Firefox has been closed for more than 72 hours, the launcher offers to pause the gap.

Set Wash and Open launcher shortcuts in Firefox's **Add-ons Manager → gear menu → Manage Extension Shortcuts**. The launcher shows its keyboard controls and links to Settings.

Data stays in this Firefox profile's local extension storage. There is no sync, export, telemetry or page-content access. Favicons may load from the sites that supplied them. Removing the extension removes its saved data. See the [listing and privacy statement](docs/listing.md).

## Build and try without signing

Use Node 24 and npm 11:

```sh
npm ci
npm run build      # bundle into dist/
npm start          # load dist/ in a separate temporary Firefox profile
npm run watch      # rebuild on change
```

Alternatively, open **about:debugging → This Firefox → Load Temporary Add-on** and select `dist/manifest.json`. No signing or AMO credentials are needed. A temporary add-on lasts until Firefox restarts.

For validation, install [Dagger](https://dagger.io) 1.0.0-beta.15 or later and its container engine, then run `dagger check --progress=report` for unit tests, type checking and AMO lint. See [AGENTS.md](AGENTS.md) for contribution rules.

## Release

Follow the [release checks](docs/release.md) and [owner checklist](docs/listing.md#owner-checklist). With AMO API credentials in `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, run `npm run release minor` for the initial 0.1.0 release, or `npm run release` for a patch (also accepts `major`).

The script validates with Dagger, bumps the package, lockfile and manifest together, builds, and submits through `web-ext sign --channel=listed` with listing metadata and a rebuildable source archive. An accepted submission awaiting review is success; it retains the new version and downloads no signed file. AMO reviews and signs it later. Install the approved version from AMO and use Firefox's updates thereafter.
