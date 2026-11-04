import type { ClosedTab } from "../lib/lifecycle";
import type { Bucket, Item, RiffleId } from "../lib/model";
import type { Store } from "../lib/store";
import type { TriageRow, TriageView } from "./model";

/** Resolves a selector's choice, falling back to the first bucket in display order. */
export function captureBucketId(buckets: Bucket[], choice?: string | null): string {
  return buckets.find((bucket) => bucket.id === choice)?.id
    ?? [...buckets].sort((a, b) => a.order - b.order)[0]?.id
    ?? "";
}

/** The row's explicit choice takes precedence over the remembered bucket. */
export function triageBucketChoice(
  row: TriageRow,
  view: TriageView,
  choices?: Map<number, string>,
): string {
  return captureBucketId(view.buckets, choices?.get(row.tabId) ?? view.defaultBucketId);
}

/** Queues a triage row using the bucket control and the clicked riffle. */
export function captureTriage(
  store: Store,
  row: TriageRow,
  bucketId: string,
  riffle: RiffleId,
): Promise<Item> {
  return store.addItem({ url: row.url, title: row.title, favIconUrl: row.favIconUrl, bucketId, riffle });
}

/** Queues a closed entry; the store removes its Recently closed record in the same write. */
export function fileClosed(
  store: Store,
  entry: ClosedTab,
  bucketId: string,
  riffle: RiffleId,
): Promise<Item> {
  return store.addItem({ url: entry.url, title: entry.title, favIconUrl: entry.favIconUrl, bucketId, riffle });
}
