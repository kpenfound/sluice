# Personal installation checks

The automated gate is `dagger check --progress=report`: all unit tests, TypeScript checking and `web-ext lint` on the built extension. The release script runs this gate before changing versions or signing. AMO credentials come only from `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`.

## Firefox smoke checks

Use a disposable Firefox 142+ profile with test tabs. `npm run build` followed by `npm start` loads a temporary extension in an isolated profile. Temporary installations do not verify signed installation or persistence through a browser restart; use the signed XPI in a separate disposable profile for those checks.

- Accept the new-tab override. Confirm three default buckets, five riffles, collapsed Stale, Settings, and a useful empty state.
- Queue a web page with Alt+Shift+S and Enter. Queue the same URL with a tracking parameter in another bucket; confirm one item remains with its original age.
- Search across buckets and Stale. Tab to Defer and Resolve and press Enter; each should perform its labeled action. Check arrow/card shortcuts and native select keyboard controls.
- Open the popup, launcher and options together. Add and revisit different items concurrently. Keep an unfinished settings form open while changing tabs; its draft should survive unrelated background updates.
- Add a past pause, schedule a pause, edit it, resume it and delete it. Check the badge and frozen due times. In an isolated profile, leave Firefox closed for over 72 hours to verify the gap offer and dismissal across restarts.
- Set auto-close to one minute. Leave a web tab inactive, keeping one active tab in each of two windows. Check expiry on the next alarm, Keep open, audio protection, and Recently closed recovery. Restore the two-hour setting.
- Bind Wash, review triage, file a tab, then confirm. Check both normal windows, audio and Keep open exemptions, one surviving launcher, and Recently closed. Repeat with a second shortcut press to skip triage.
- Check narrow windows, long titles, keyboard focus, and accessible names for form controls. Confirm private tabs are excluded from tracking and wash.
- With the signed extension, restart Firefox with session restore enabled. Verify queued items and settings persist, keep-open flags survive when Firefox restores tab session values, and unmatched tabs are treated as new.

## Signing and installation

From version 0.0.0, `npm run release minor` produces 0.1.0. Subsequent releases use patch, minor or major as appropriate. Install the signed artifact from `web-ext-artifacts/` into the smoke-test profile, verify the displayed version, then install it in your normal Firefox profile. Unlisted signing uploads the package to Mozilla but does not create a public listing; sharing or hosting the XPI is unnecessary. Commit the matching package, lockfile and manifest version updates. For updates, install a newly signed higher-version XPI over the existing extension without uninstalling it. Keep build output, signed artifacts and credentials out of Git.
