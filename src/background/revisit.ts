import type { Store } from "../lib/store";

/** The fields of a `history.onVisited` event that revisit matching needs. */
export interface Visit {
  url?: string;
}

/**
 * Records a revisit when `visit` carries a URL, delegating normalization and matching
 * to `store.recordVisit`. Does nothing when `visit.url` is absent.
 */
export function handleVisited(store: Store, visit: Visit): Promise<void> {
  if (visit.url === undefined) return Promise.resolve();
  return store.recordVisit(visit.url).then(() => undefined);
}
