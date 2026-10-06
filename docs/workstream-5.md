# Workstream 5: Wash

Close everything at once. One hotkey shows me the tabs I haven't queued, lets me file the ones I want to keep, then closes every tab in every window. With wash in place, v1 is complete.

Builds on workstream 4. Design sections: Surfaces > Wash, Keyboard commands, Open questions 1 and 2, Amendment 2.

## Outcomes

- A wash hotkey exists and can be rebound in Firefox's shortcut settings.
- Wash opens a triage view on the new tab page. It lists open tabs from all windows that aren't queued yet, with quick bucket and riffle buttons on each. I file what I want to keep, then confirm.
- Confirming closes every tab in every normal window, except tabs playing audio and tabs marked never to auto-close (keep-open tabs). One Sluice new tab stays open.
- A second press of the hotkey, or a "wash now" button, skips triage and washes straight away.
- Unqueued tabs closed by a wash appear in the recently closed list.

## Open questions

The architect raised these with the owner, who has answered:

1. Does wash close tabs marked to never auto-close? Answer: no. Wash skips keep-open tabs (`keepOpen: true`), the same way it skips tabs playing audio, and triage does not list them.
2. Detecting unsaved form input likely needs access to page content, which the design's permission table doesn't grant. Which permission does it need, or should that exemption be dropped? The table and `src/manifest.test.ts` change together. Answer: dropped. Wash skips only tabs playing audio. No new permission is added — no `scripting`, no host access, required or optional — so the Permissions table and `src/manifest.test.ts` don't change.
3. Scope. Answer: confirming a wash closes tabs in all normal windows, not only the current one. Private windows are left untouched.
4. Default key. Answer: the wash command ships with no default key (no `suggested_key`), the same as "Open launcher". It is bound in Firefox's shortcut settings.

## Out of scope

Auto-wash on idle, and everything else under Later in the design.

## Done when

- The choice of which tabs a wash closes, keeps or lists in triage has unit tests that run without Firefox.
- `dagger check` passes.
