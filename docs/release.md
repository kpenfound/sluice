# Release checks

The automated gate is `dagger check --progress=report`: all unit tests, TypeScript checking and AMO-hosted `web-ext lint` on the built extension. The release script runs this gate before changing versions. Live Firefox checks below are owner steps; automated checks do not establish browser acceptance.

## Firefox smoke checks

Use a disposable Firefox 142+ profile with test tabs. With Node 24/npm 11, run `npm ci`, `npm run build` and `npm start` to load a temporary extension in an isolated profile. Temporary installations support the behavior checks but do not verify signed installation or persistence through a browser restart.

- Accept the new-tab override. Confirm one Default bucket followed by the Stale entry, Settings and a useful empty state. Open tabs and Recently closed both start collapsed and expand independently; after a page reload, both start collapsed again.
- Queue a web page into Default with Alt+Shift+S and Enter. Rename Default in Settings; confirm the new name in the launcher and popup, with its item and remembered selection intact. Reject a blank rename without changing the bucket.
- Add a second bucket in Settings. Queue the same URL with a tracking parameter into that bucket; confirm one item remains with its original age and the selected bucket is remembered.
- Queue items in different timed riffles. Confirm a single queue ordered by soonest due, with each item's riffle shown. Defer an item from 1mo to Stale; it leaves the timed queue and appears under the Stale entry with its bucket name. Search across buckets and Stale. Tab to Defer and Resolve and press Enter; each performs its labeled action. Check the displayed keyboard shortcuts and native select controls.
- Open the popup, launcher and options together. Add and revisit different items concurrently. Keep an unfinished settings form open while changing tabs; its draft should survive unrelated background updates.
- Add a past pause, schedule a pause, edit it, resume it and delete it. Confirm blanking a label clears it and a successful Save closes the edit form. Check the badge and frozen due times. Enable automatic weekend pauses and verify their local-midnight boundaries when a weekend occurs. Pausing does not stop tab auto-close timers.
- Set auto-close to one minute. Leave a web tab inactive, keeping one active tab in each of two windows. Check expiry on the next alarm, Keep open and audio protection. Expand Recently closed and reopen or File an unqueued page; File removes it from Recently closed and remembers the chosen bucket. Restore the two-hour setting.
- Bind Wash, review triage, file a tab, then confirm. Check both normal windows, audio and Keep open exemptions, one surviving launcher, and Recently closed. Repeat with a second shortcut press to skip triage.
- Check narrow windows, long titles, keyboard focus and accessible names for form controls. Confirm private tabs are excluded from tracking and Wash.

## Listed release and approval

Review the [listing material and owner checklist](listing.md), including screenshots, contacts and the permanent add-on ID. The metadata in `scripts/amo-metadata.json` is sent on every release and overwrites the fields it supplies in AMO's Developer Hub. Use Node 24/npm 11, Dagger with its container engine, and the platform's `tar` tool. Obtain AMO developer API credentials and set them locally:

```sh
export WEB_EXT_API_KEY=...
export WEB_EXT_API_SECRET=...
npm ci
npm run release minor     # initial release: 0.0.0 → 0.1.0
# npm run release         # subsequent patch release (default)
# npm run release major   # or choose minor/major as appropriate
```

The script runs the gate, bumps `package.json`, `package-lock.json` and `src/manifest.json`, builds `dist/`, and creates `web-ext-artifacts/sluice-<version>-source.tar.gz`. It submits through `web-ext sign --channel=listed` with the listing metadata, source archive and `--approval-timeout=0`. Acceptance awaiting AMO review is a successful release: the versions stay bumped, and no signed file is downloaded or claimed. Monitor review in the AMO Developer Hub.

To check source reproducibility, extract the source archive into an empty directory and follow its own README: `npm ci`, then `npm run build`. Compare that `dist/` recursively with the submitted `dist/`; every file, including source maps, must match. The archive includes the submitted versions, source, lockfile, build script and instructions. It excludes credentials, dependencies, built output and signing artifacts.

Failures at validation, versioning, build, packaging or submission restore all three local version files. If AMO created the version before a source upload failed, inspect it in the Developer Hub and follow [submission recovery](listing.md#submission-and-recovery) before retrying. Keep matching source and output for recovery. Commit the matching version updates after success; keep build output, artifacts and credentials out of version control.

## After AMO approval

Perform signed-installation and restart checks on the **AMO-signed version after approval**. Install it from addons.mozilla.org into the disposable test profile, confirm the displayed version and new-tab consent, and repeat the behavior checks above. Users install from AMO and Firefox delivers approved updates; verify an update preserves queued items and settings without uninstalling first.

Restart Firefox with session restore enabled. Verify queued items, renamed buckets and settings persist, Keep open flags survive when Firefox restores tab session values, and unmatched tabs are treated as new. In an isolated profile, leave Firefox closed for over 72 hours to verify the gap offer and dismissal across restarts. Record the Firefox version and results in the owner checklist. Add the assigned AMO listing link to project documentation after the first submission.
