# Workstream 3: Launcher and options

Give queued items a home. Every new tab opens the launcher, where I see every bucket and riffle, act on items by mouse or keyboard, and manage pauses. The options page handles buckets and the pause list.

Builds on workstream 2. Design sections: Surfaces > New tab page, Lifecycle > Actions, Pause (Behavior, Catching a forgotten pause), Keyboard commands, Buckets in v1, Open questions 5.

## Outcomes

- Sluice owns the new tab page, and every new tab opens the launcher.
- A bucket switcher runs along the top, with each bucket's overdue count.
- Each riffle is a column: 24h, 72h, 1w, 1mo, Stale. Stale starts collapsed. Overdue items are highlighted and sort to the top of their column.
- Each item shows its favicon, title, domain, time in riffle, total age and when it's due.
- Open, Defer, Move, Change bucket and Resolve all work by mouse and by keyboard. Opening an item counts as a revisit.
- A search box filters every bucket and every riffle, Stale included.
- While a pause is running, a banner shows when it started and offers Resume, and due times stay frozen.
- On startup, if Firefox has been closed for more than 72 hours (the answer to open question 5, which replaces the 48 hours in the Pause section), the launcher shows a banner offering to pause the gap. The banner shows the gap's dates and how many items would stop being overdue. One click saves the pause. Once dismissed, that gap isn't offered again. The banner appears before I can act on any item.
- The launcher, popup and badge stay in sync when any of them changes data.
- The options page renames and adds buckets. It lists every pause, and lets me add a past or scheduled range, edit one or delete one.
- An "Open launcher" keyboard command exists and can be rebound in Firefox's shortcut settings.

## Out of scope

Tab tracking, the recently closed list, auto-close and wash.

## Done when

- Ordering and grouping in the launcher, search filtering and the away-gap decision have unit tests.
- `dagger check` passes.

## Unblocks

Workstream 4 adds a recently closed list to the launcher and an auto-close setting to the options page.
