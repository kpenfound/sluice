import type { Store } from "../lib/store";
import { prunablePauses } from "../lib/pauses";
import { badgeText } from "./badge";

/** What one `tick` run needs: a store, a way to set the badge, and the current time. */
export interface TickDeps {
  store: Store;
  setBadgeText: (text: string) => void | Promise<void>;
  now: () => number;
}

/**
 * The per-minute background duties: mark the extension active, prune pauses that can
 * no longer affect any item, and refresh the badge. Makes no `pauses` write when
 * nothing is prunable.
 */
export async function tick(deps: TickDeps): Promise<void> {
  const { store, setBadgeText, now } = deps;

  await store.touchActive();

  const [buckets, items, pauses] = await Promise.all([
    store.getBuckets(),
    store.getItems(),
    store.getPauses(),
  ]);

  const whenNow = now();
  const prunable = prunablePauses(pauses, items, whenNow);
  const currentPauses = prunable.length > 0 ? await store.prunePauses() : pauses;

  await setBadgeText(badgeText(buckets, items, currentPauses, whenNow));
}
