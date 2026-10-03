# Workstream 2: Capture, revisit and badge

Make Sluice usable day to day: I can queue the current tab, revisits register however I reach a page, and the toolbar badge tells me when something is overdue. This is the first build worth installing, so it also ships the release script.

Builds on workstream 1. Design sections: Lifecycle > Add and Revisit, Surfaces > Toolbar button and popup, Pause > Behavior, Architecture, Development and distribution.

## Outcomes

- The toolbar popup adds the current tab. Bucket and riffle come prefilled: 72h, and the last bucket I used. Enter saves. The `_execute_action` hotkey opens the popup.
- If the current tab is already queued, the popup shows its bucket and riffle and offers Move and Resolve instead of the add form.
- The popup has a Pause/Resume control. Pause starts a pause now, with an optional end date.
- A visit to a queued URL in a normal window counts as a revisit, whether it came from the URL bar, a link or anywhere else. Visits in private windows don't count.
- Once a minute the background script refreshes the badge, writes `lastActiveAt`, ends scheduled pauses when their end passes, and prunes old pauses. The badge shows the total overdue count, or a pause symbol while a pause is running.
- All of this keeps working after Firefox suspends and restarts the background script.
- One script bumps the version and signs an unlisted `.xpi` with `web-ext`. It reads the AMO API keys from environment variables, and the README says how to run it and install the result.

## Out of scope

The new tab page, the options page, the away-gap banner, tab tracking, auto-close and wash.

## Done when

- Revisit matching, badge text and the per-minute duties have unit tests that run without Firefox.
- `dagger check` passes.

## Unblocks

Workstream 3 builds the launcher over queues this workstream fills, and reuses its pause control and badge.
