# Sluice design

A Firefox extension that makes every tab disposable. You close all your tabs whenever you step away. Anything you mean to come back to sits in a queue that decays on a schedule, so the queues can't grow into a second backlog.

Status: design, pre-implementation. Firefox only.

## Problem

Tabs do two jobs at once. They show what I'm looking at right now, and they remind me of things I haven't finished. A GitHub issue stays open for a week because closing it means forgetting it. Throwaway tabs pile up around the ones I care about, and eventually I can't close anything safely.

Bookmarks and read-later tools don't fix this. They keep things forever, nothing forces a decision, and they turn into their own maintenance chore.

## Goals

- Close every tab often, with no exceptions, and lose nothing I meant to keep.
- Get back to a queued item in a keystroke or two.
- Make each queued item come up for a decision on a schedule: open it, defer it, or resolve it.
- Count any visit to a queued URL as a revisit, however I got there.

## Non-goals

- Always-open sites like email and calendar. These go on the native bookmarks bar.
- Bookmark management, read-later, or knowledge capture.
- Session restore.
- Chrome support in v1. The WebExtension APIs make a later port possible.

## Concepts

|Term|Meaning|
|---|---|
|Bucket|A workspace for one area of life, such as Dagger, Side projects, or Personal. Each bucket has its own set of riffles.|
|Riffle|A fixed queue inside a bucket. Each riffle has a TTL.|
|Item|A queued URL. It lives in exactly one bucket and one riffle.|
|Overdue|An item whose TTL has run out since its last visit or its last move.|
|Wash|Closing all tabs.|
|Resolve|Deleting an item because the work is done. Nothing is kept.|
|Pause|A time range that doesn't count toward any item's TTL. Pauses are global and can be set after the fact.|

The name comes from gold panning. A sluice box washes material down a channel, and the riffles along the bottom catch the gold.

### Riffles

Every bucket has the same fixed ladder:

|Riffle|TTL|
|---|---|
|24h|24 hours|
|72h|72 hours|
|1w|7 days|
|1mo|30 days|
|Stale|none|

Stale is the archive. Items there never go overdue. They stay searchable until I move or resolve them.

## Data model

```ts
type RiffleId = "24h" | "72h" | "1w" | "1mo" | "stale";

interface Bucket {
  id: string;
  name: string;
  order: number;
}

interface Item {
  id: string;
  url: string;              // original URL, used to open the item
  normUrl: string;          // normalized URL, used for matching
  title: string;
  favIconUrl?: string;
  bucketId: string;
  riffle: RiffleId;
  queuedAt: number;         // first queued, never changes
  riffleEnteredAt: number;  // set whenever the item moves riffles
  lastVisitedAt: number | null;
}

interface Pause {
  id: string;
  start: number;
  end: number | null;       // null while a pause is running
  label?: string;           // "Vacation", etc.
}
```

The extension computes overdue state on read and never stores it. Only unpaused time counts toward a TTL.

```ts
const TTL: Record<Exclude<RiffleId, "stale">, number> = {
  "24h": 24 * HOUR,
  "72h": 72 * HOUR,
  "1w": 7 * DAY,
  "1mo": 30 * DAY,
};

function anchor(item: Item): number {
  return Math.max(item.riffleEnteredAt, item.lastVisitedAt ?? 0);
}

// Wall-clock time since the anchor, minus any overlap with pauses.
function activeElapsed(item: Item, pauses: Pause[], now: number): number {
  const from = anchor(item);
  let paused = 0;
  for (const p of pauses) {
    const s = Math.max(p.start, from);
    const e = Math.min(p.end ?? now, now);
    if (e > s) paused += e - s;
  }
  return now - from - paused;
}

function remaining(item: Item, pauses: Pause[], now: number): number | null {
  if (item.riffle === "stale") return null;
  return TTL[item.riffle] - activeElapsed(item, pauses, now);
}
// Overdue when remaining <= 0.
```

Pauses never overlap. The store merges overlapping or touching ranges on write, so the sum above never double counts.

Each item shows two ages in the UI. Both use wall-clock time. Only the overdue status and "due in" use active time.

- Time in the current riffle, measured from `riffleEnteredAt`.
- Total age, measured from `queuedAt`. An item that has been deferred from 24h down to 1mo shows its real age, so I can see what I've been dodging.

### Uniqueness

`normUrl` is unique across all buckets. If I add a URL that's already queued, Sluice moves the existing item to the new bucket and riffle. It doesn't create a duplicate. `queuedAt` stays the same.

## Lifecycle

### Add

1. Press the add hotkey, or click the toolbar button, on the current tab.
2. A popup opens with the bucket and riffle already filled in. 72h is the default riffle. The default bucket is the last one I used.
3. Press Enter to save, or change either field first.

Proposed for v1 or later: domain rules that pick the bucket automatically, for example `github.com/dagger/*` goes to Dagger.

### Revisit

Sluice listens to `history.onVisited`. It normalizes each visited URL and looks it up among queued items. If it finds a match, it sets `lastVisitedAt = now`. Opening the page from the Sluice launcher, the URL bar, or a link elsewhere all count the same.

A revisit only resets the timer. The item stays in its riffle.

### Actions

Every item has these actions, whether or not it's overdue:

|Action|Effect|
|---|---|
|Open|Opens the URL. This counts as a revisit.|
|Defer|Moves the item one riffle down, from 24h to 72h, or from 1mo to Stale. Sets `riffleEnteredAt = now`.|
|Move|Moves the item to any riffle, up or down, including out of Stale. Sets `riffleEnteredAt = now`.|
|Change bucket|Moves the item to another bucket. The riffle and timestamps stay the same.|
|Resolve|Deletes the item.|

Defer is the fast path from the overdue indicator. Move covers reprioritizing.

## Pause

A week of vacation shouldn't turn every queue overdue. Pause stops the clock for every item in every bucket.

### Design choice

Two ways to do this were considered.

1. **Shift timestamps.** On resume, add the pause length to every item's `riffleEnteredAt` and `lastVisitedAt`. Due logic stays simple, but it rewrites data. A retroactive pause has to work out which items existed during the range, and editing or deleting a pause later means undoing the shift.
2. **Store pause ranges.** Keep a list of pauses and subtract their overlap when computing elapsed time. Item data never changes.

Sluice uses ranges. A retroactive pause is just a range with a start in the past. Editing or deleting a pause recomputes everything with no migration. Items added or visited during a pause work without special cases, because their anchor already falls inside the range.

### Behavior

- **Pause now.** Starts an open-ended pause with `start = now`. An optional end date schedules the resume.
- **Resume.** Sets `end = now` on the running pause.
- **Pause a past range.** I pick a start date, and an end date or "until now". Items that went overdue during that range stop being overdue once I save it.
- **Schedule a pause.** A start date in the future works too, since the model allows it.
- **Edit and delete.** A pauses list on the options page shows every range.
- Adding items, visiting, deferring, moving, and resolving all keep working while paused.
- Stale items have no TTL, so pauses don't affect them.
- Pauses are global. Per-bucket pauses, such as ignoring Dagger on weekends, are a possible later addition. A `bucketIds` field on `Pause` would support them.

### Catching a forgotten pause

The likely failure is coming back from a week off and only then remembering. Sluice detects the gap.

- The background alarm writes `lastActiveAt` every minute while Firefox runs. Alarms don't fire while Firefox is closed.
- On startup, if `now - lastActiveAt` is more than 48 hours, the new tab page shows a banner offering to pause the gap. The banner shows the gap's dates and how many items would stop being overdue. One click saves it.
- If I dismiss the banner, the gap isn't offered again.

This only catches time with Firefox closed. A week away with Firefox left running on a desktop won't show a gap, so a manual past-range pause is still needed. Idle time from the `idle` API could fill that hole later.

The banner has to appear before I start triaging, because deferring an item on return moves it for real. A pause saved afterwards doesn't undo those moves.

### Pruning

A pause that ended before the oldest anchor of every non-stale item can no longer affect anything. Sluice deletes these on the periodic alarm.

## URL normalization

Revisit matching and uniqueness both use the normalized URL.

Default rules:

- Lowercase the scheme and host.
- Drop the fragment.
- Drop tracking params, such as `utm_*`, `fbclid`, and `gclid`.
- Sort the remaining query params.
- Drop the trailing slash on the path.

Per-site rules:

- GitHub issues and PRs normalize to `github.com/{owner}/{repo}/{issues|pull}/{n}`. This drops sub-paths like `/files` and `/commits`, the query string, and anchors like `#issuecomment-…`.

The normalizer is a pure function with its own unit tests. New site rules go in a small table.

## Surfaces

### New tab page

Sluice sets `chrome_url_overrides.newtab`, so every new tab opens the launcher.

- A bucket switcher runs along the top, with an overdue count on each bucket.
- Each riffle is a column: 24h, 72h, 1w, 1mo, Stale. Stale is collapsed by default.
- Overdue items are highlighted and sort to the top of their column.
- Each item shows its favicon, title, domain, time in riffle, and total age.
- Item actions work by mouse and by keyboard.
- A search box filters every bucket and every riffle, Stale included.
- While a pause is running, a banner shows when it started and offers Resume. "Due in" times are frozen.
- The away-gap banner from the Pause section appears here.

Firefox asks me to confirm the new tab override the first time. Only one extension can own the new tab page at a time.

### Toolbar button and popup

- The badge shows the total overdue count across all buckets. While a pause is running, it shows a pause symbol instead.
- The popup has a Pause/Resume control.
- The popup is the add form for the current tab. If the tab is already queued, the popup shows where it is and offers Move and Resolve.

### Wash

A hotkey closes every tab in the current window.

1. Sluice opens a triage view on the new tab page. It lists the open tabs that aren't queued yet, with quick bucket and riffle buttons for each one.
2. I file what I want to keep, then confirm.
3. Sluice closes every tab and leaves one Sluice new tab open, since Firefox needs at least one tab in a window.

The triage step is skippable with a second press of the hotkey or a "wash now" button.

Proposed for later: auto-wash after the `idle` API reports N minutes idle. Skip triage in that mode and only close tabs.

### Keyboard commands

|Command|Default|
|---|---|
|Add current tab|`_execute_action`, which opens the popup|
|Wash|TBD|
|Open launcher|TBD|

Users can rebind these in Firefox's extension shortcuts settings.

## Architecture

- Manifest V3, Firefox only. Firefox MV3 uses a non-persistent background script, so the background script holds no state between events. All state lives in storage.
- Background script handles:
    - `history.onVisited` for revisit matching.
    - `alarms`, once a minute, to recompute the overdue count, update the badge, write `lastActiveAt`, end scheduled pauses, and prune old ones.
    - `runtime.onStartup`, to check for an away gap.
    - The wash command and tab closing.
- The new tab page and popup are extension pages. They read and write `storage.local` directly and listen to `storage.onChanged` to stay in sync.
- Storage is `storage.local`, with separate keys for buckets, items, pauses, and `lastActiveAt`. A few hundred items fit easily. Writes go through one small module so a later move to IndexedDB or `storage.sync` touches one file.

### Permissions

|Permission|Reason|
|---|---|
|`tabs`|Read the URL and title of the current tab, and close tabs on wash|
|`history`|`onVisited` for revisit matching|
|`storage`|Buckets and items|
|`alarms`|Periodic badge updates|
|`idle`|Only if auto-wash ships|

### Stack

TypeScript bundled with esbuild, and `web-ext` for running, linting, and signing. The UI is small enough for plain DOM or Preact. I'd skip a heavier framework.

### Buckets in v1

Sluice ships with three default buckets: Dagger, Side projects, Personal. A basic options page allows renaming and adding buckets. The riffle ladder is not configurable.

## Development and distribution

- Develop with `web-ext run`, which loads a temporary add-on and reloads on file changes.
- Set `browser_specific_settings.gecko.id` in the manifest, such as `sluice@<domain>`.
- Sign with `web-ext sign --channel=unlisted` using AMO API keys. The extension doesn't appear on AMO.
- Install the signed `.xpi` by dragging it into Firefox.
- Every release needs a version bump and a re-sign. A single script handles both.

## Later

- Per-site auto-resolve. GitHub issues and PRs resolve themselves when closed or merged. This needs a token and polling.
- `storage.sync` or JSON export and import, for use across machines.
- Domain rules for picking buckets.
- Auto-wash on idle.
- Per-bucket pauses.
- Using idle time to detect away gaps when Firefox stays open.
- Chrome port.

## Open questions

1. Should wash skip tabs playing audio or tabs with unsaved form input?
	1. answer: yes
2. Should wash act on the current window or all windows?
	1. answer: all windows
3. Should private windows count? `history.onVisited` doesn't fire there, so revisits in private windows won't register either way.
	1. answer: private windows do not count. I dont think an extension would be active anyway
4. What should Sluice do with Firefox's own tab restore on startup? Sluice's model works best when Firefox starts with a blank window.
	1. answer: best effort state restore. If restored tabs are not tracked, treat them as newly opened.
5. Is 48 hours the right threshold for the away-gap banner, or should it be a setting?
	1. answer: 72 hours is better because a user may not use their computer over a weekend, which covers that 48 hours

## Amendments
1. Tab auto-close timer should be configurable and should start as soon as a tab is unfocused (i leave the tab for another tab). There should be some visual cue on each tabs remaining time. Revisiting the tab should reset the timer. Default timer should be 2h. A focused tab in any window cannot get auto-closed
2. All closed tabs (auto or by user) that did not get put into a bucket before getting closed should be in a "recently closed" list on the new tab page. This is *only* uncategorized tabs, not all closed tabs. From there I can re-open the tab or move it to bucket
3. I should be able to set an open tab to not get auto-closed