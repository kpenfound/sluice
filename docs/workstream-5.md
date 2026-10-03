# Workstream 5: Wash

Close everything at once. One hotkey shows me the tabs I haven't queued, lets me file the ones I want to keep, then closes every tab in every window. With wash in place, v1 is complete.

Builds on workstream 4. Design sections: Surfaces > Wash, Keyboard commands, Open questions 1 and 2, Amendment 2.

## Outcomes

- A wash hotkey exists and can be rebound in Firefox's shortcut settings.
- Wash opens a triage view on the new tab page. It lists open tabs from all windows that aren't queued yet, with quick bucket and riffle buttons on each. I file what I want to keep, then confirm.
- Confirming closes every tab in every window, except tabs playing audio and tabs with unsaved form input. One Sluice new tab stays open.
- A second press of the hotkey, or a "wash now" button, skips triage and washes straight away.
- Unqueued tabs closed by a wash appear in the recently closed list.

## Open questions

The architect should raise these with me rather than pick an answer:

1. Does wash close tabs marked to never auto-close?
2. Detecting unsaved form input likely needs access to page content, which the design's permission table doesn't grant. Which permission does it need, or should that exemption be dropped? The table and `src/manifest.test.ts` change together.

## Out of scope

Auto-wash on idle, and everything else under Later in the design.

## Done when

- The choice of which tabs a wash closes, keeps or lists in triage has unit tests that run without Firefox.
- `dagger check` passes.
