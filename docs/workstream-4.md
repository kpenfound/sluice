# Workstream 4: Tab lifecycle

Make open tabs disposable on their own. Tabs I've left behind close after a timeout unless I mark them to stay, and anything closed without being queued waits in a recently closed list, so closing a tab never loses it.

Builds on workstream 3. Design sections: Amendments 1–3, Open questions 3 and 4, Architecture > Permissions.

## Outcomes

- Sluice tracks the open tabs in normal windows. Private windows are ignored.
- A tab's auto-close timer starts when I leave it for another tab and resets when I return to it. The default is 2 hours, and it can be changed on the options page.
- The focused tab in any window is never auto-closed.
- Every tab shows a cue for its remaining time. The design doesn't name the mechanism, so the plan should propose one.
- I can mark an open tab to never auto-close, and unmark it.
- Tabs closed without being queued, whether auto-closed or closed by me, appear in a "Recently closed" list on the new tab page. From there I can reopen a tab or file it into a bucket and riffle. Queued tabs never appear in the list.
- When Firefox restores tabs on startup, Sluice restores what tracking state it can. Restored tabs it wasn't tracking are treated as newly opened.
- Tracking survives the background script being suspended.

## Open questions

The architect should raise these with me rather than pick an answer:

1. How long do entries stay in the recently closed list, and does it have a size limit?
2. Should auto-close skip tabs playing audio, the way wash does?
3. If this needs a permission beyond the design's table, which one and why? The table and `src/manifest.test.ts` change together.

## Out of scope

Wash and its triage view.

## Done when

- Timer start, reset and expiry, the focused-tab and keep-open exemptions, recently closed membership and restore handling have unit tests that run without Firefox.
- `dagger check` passes.

## Unblocks

Workstream 5 closes tabs in bulk, sending what it closes to the recently closed list and honoring the tracking built here.
