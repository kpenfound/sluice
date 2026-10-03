# Workstream 1: Queue model and storage

Build the rules every Sluice surface depends on: buckets, riffles, items, pauses and URL normalization, all stored in `storage.local` behind one module. No UI ships in this workstream. Later workstreams add surfaces on top of this module and shouldn't need to change its rules.

Design sections: Concepts, Data model, Uniqueness, Lifecycle > Actions, Pause (Design choice, Behavior, Pruning), URL normalization, Architecture.

## Outcomes

- Buckets, items and pauses persist in `storage.local` under separate keys. Every read and write goes through one storage module, and extension pages can subscribe to its changes.
- A fresh install starts with three buckets: Dagger, Side projects, Personal. Buckets can be added and renamed.
- Items can be added, deferred, moved, moved to another bucket and resolved, with the timestamp effects in the Actions table. Adding a URL that's already queued moves the existing item and keeps its `queuedAt`.
- A visit can be recorded against the item whose normalized URL matches. It resets the item's timer and leaves the item in its riffle.
- Remaining time and overdue state are computed on read and count only unpaused time. Stale items never go overdue. Each item also reports its time in riffle and its total age, both in wall-clock time.
- Overdue counts are available per bucket and in total.
- Pauses can be started now, ended, set over a past range, scheduled for the future, edited and deleted. Overlapping or touching ranges merge on write. Pauses that can no longer affect any item can be pruned.
- URLs normalize by the default rules and the GitHub issue and PR rule. Site rules live in a small table.

## Out of scope

UI of any kind, background listeners, alarms, the badge, tab tracking, wash and auto-close.

## Done when

- Unit tests cover:
  - due-time math across running, retroactive and future pauses, including items queued or visited during a pause
  - pause merging and pruning
  - every action, including uniqueness on add
  - each normalization rule, including GitHub sub-paths, query strings and comment anchors
- `dagger check` passes.

## Unblocks

Workstream 2 adds and revisits items through this module. Every later surface reads from it.
