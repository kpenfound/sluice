# AMO listing

Sluice replaces Firefox's new tab page with a queue launcher and closes inactive
web tabs after **two hours by default**. The timeout is configurable in Settings.
Firefox asks for confirmation of the new-tab replacement; only one extension can
own the new tab page at a time.

## Listing copy

Name: **Sluice**. Category: **Tabs**. License: **MIT**, matching `LICENSE`.
Requires Firefox 142 or later.

Summary:

> Make every tab disposable: queue pages to revisit, replace your new tab page with a launcher, and auto-close inactive tabs after two hours by default.

Description:

> Sluice replaces your new tab page with a launcher and closes inactive web tabs after two hours by default. Change the timeout in Settings; active tabs, tabs playing audio and tabs marked Keep open are protected.
>
> Queue pages for 24 hours, 72 hours, one week or one month. Visits reset their timers; overdue pages stay queued until you act. Defer, move, search or resolve items, and pause queue deadlines while away. Start with one Default bucket and rename it or add buckets in Settings.
>
> Wash lets you file pages before closing tabs across normal windows. Recently closed keeps unqueued web pages for up to seven days or 100 entries so you can reopen or file them. Open tabs and Recently closed start collapsed. Private windows are untouched.
>
> Your queues and settings stay in this Firefox profile. Sluice has no telemetry, sync or page-content access. Favicons may load from the sites that supplied them. Firefox 142 or later is required.

`scripts/amo-metadata.json` is the source of truth for the summary, description,
category, license and reviewer notes. Every release sends it to AMO, overwriting
edits to those fields made in the Developer Hub. Keep this document's copy and
the metadata in agreement. The listing URL is assigned by AMO on first submission.

## Permissions

These are all the permissions in `src/manifest.json`:

| Permission | Why Sluice needs it |
| --- | --- |
| `alarms` | Run the once-a-minute check for queue badges, pauses and inactive tab auto-close. |
| `history` | Observe visits to queued URLs to reset their revisit timers. Browsing history is not uploaded or scanned into a separate history database. |
| `sessions` | Preserve tab tracking IDs and Keep open flags across Firefox restarts using tab values. |
| `storage` | Save buckets, queued items, pauses, settings, tab tracking and Recently closed in local extension storage. |
| `tabs` | Read tab URLs and titles for capture, triage and the launcher, and close tabs for Wash and auto-close. |

There are no host permissions or content scripts. Sluice does not read page
contents. Private windows are untouched. Wash skips audible and Keep open tabs;
automatic closing additionally protects active tabs in every window and applies
only to HTTP(S) tabs. Pausing freezes queue deadlines, not tab auto-close.

## Privacy statement

Sluice collects and transmits no user data to its developer or any analytics
service. This matches the manifest's Firefox data-collection declaration:
`data_collection_permissions.required` is `["none"]`.

Queues contain the URLs and titles you choose to save. Settings, pauses, tab
tracking and unqueued HTTP(S) pages in Recently closed stay in this Firefox
profile's local extension storage. Recently closed is deduplicated by normalized
URL and limited to seven days and 100 entries. Browser-internal pages and local
files are not retained there. There is no telemetry, sync or export. Favicons
may load from the sites that supplied them, causing ordinary requests to those
sites. Removing the extension removes its saved data.

## Submission and recovery

The release script validates with Dagger before changing versions, builds the
extension, packages the working source at the bumped version, and submits
`dist/` through `web-ext sign --channel=listed` with metadata and source.
The source archive is `web-ext-artifacts/sluice-<version>-source.tar.gz`.
It contains a reviewer README with Node 24/npm 11 build instructions, source,
lockfile and build script. Source packaging requires the platform's `tar` tool.
Reviewers only need `npm ci` and `npm run build` to recreate `dist/`.

An accepted submission awaiting review is success. The script uses
`--approval-timeout=0`, keeps the bumped versions and reports that they are
awaiting AMO review. It downloads no signed file. AMO reviews and signs the
version later; Firefox delivers approved updates to installed users.

Failures at validation, versioning, building, source packaging or submission
restore the three version files. AMO can create a version before its source
upload finishes. If submission fails, inspect that version in the Developer Hub
before retrying: attach the matching source archive under **Manage Status &
Versions → version → Source code**, or release the next version. Do not try to
resubmit an already-created version. Keep the matching archive and built output
until recovery is complete; restoring local versions does not remove AMO's copy.

## Owner checklist

- [ ] Run the Firefox smoke checks in `docs/release.md`: new-tab consent, popup capture, one Default bucket and renaming, queue actions, pause behavior, Wash, auto-close protections, Recently closed, and restart persistence. Record the Firefox version and results.
- [ ] Capture screenshots in Firefox with non-sensitive sample pages. Show the launcher, popup and Settings; disclose new-tab replacement and the two-hour default auto-close prominently on the listing.
- [ ] Supply and verify a support contact and optional homepage. These are intentionally absent from the metadata until supplied. Add the assigned AMO listing link to project documentation after the first submission.
- [ ] Confirm the permanent add-on ID `sluice@kylepenfound.com` before the first submission; confirm the correct AMO developer account and protect its API credentials in environment variables.
- [ ] Review the listing copy, privacy statement, MIT license and permission explanations against the built extension. Keep metadata as the source of truth for fields it sends.
- [ ] Before an authorized first submission, use Node 24/npm 11, install dependencies from the lockfile, run the validation gate, and rebuild the source archive independently to compare `dist/`. Confirm metadata and matching source are included.
- [ ] When ready to publish, run the listed release with an appropriate version bump and monitor AMO's review in the Developer Hub. This preparation does not itself authorize or perform submission.
- [ ] After approval, install the AMO-signed version and perform signed-installation, update and restart checks; verify Firefox delivers the update without losing local data.
