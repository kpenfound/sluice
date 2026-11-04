import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createStore } from "../lib/store";
import type { Store } from "../lib/store";
import { TestStorage } from "../lib/test-storage";
import { bucketList } from "../options/model";
import { popupState, saveTab } from "../popup/model";
import { captureBucketId, captureTriage, fileClosed, triageBucketChoice } from "./actions";
import { launcherView, recentlyClosedView, STALE_SELECTION_ID, triageView } from "./model";

const now = 1_000_000;
const tab = { id: 1, url: "https://example.com/article", title: "Article", favIconUrl: "https://example.com/icon.png" };

function fixture() {
  const storage = new TestStorage();
  let id = 0;
  const store = createStore(storage, { now: () => now, newId: () => `id-${id++}` });
  return { store, storage };
}

async function launcher(store: Store, selectedBucketId: string | null = null, query = "") {
  return launcherView({
    buckets: await store.getBuckets(), items: await store.getItems(), pauses: await store.getPauses(),
    awayGap: null, selectedBucketId, query, now,
  });
}

async function popup(store: Store, url = tab.url) {
  return popupState({
    tab: { ...tab, url }, tabId: tab.id, buckets: await store.getBuckets(), items: await store.getItems(),
    pauses: await store.getPauses(), trackedTabs: await store.getTrackedTabs(),
    lastBucketId: await store.getLastBucketId(), now,
  });
}

describe("capture with only Default", () => {
  test("the launcher switcher lists Default followed by Stale", async () => {
    const { store } = fixture();
    const view = await launcher(store);
    expect(view.switcher.map((entry) => entry.name)).toEqual(["Default", "Stale"]);
    expect(view.switcher.map((entry) => entry.isStale)).toEqual([false, true]);
  });

  test.each(["popup", "triage", "File"])("%s queues into Default and remembers it", async (surface) => {
    const { store } = fixture();
    const buckets = await store.getBuckets();
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0]!;
    expect(bucket.name).toBe("Default");
    if (surface === "popup") {
      const state = await popup(store);
      if (state.kind !== "add") throw new Error("Expected add form");
      expect(state.buckets).toEqual(buckets);
      expect(state.defaultBucketId).toBe(bucket.id);
      await saveTab(store, tab, state.defaultBucketId, state.defaultRiffle);
    } else if (surface === "triage") {
      const view = triageView({ tabs: [tab], trackedTabs: [], items: await store.getItems(), buckets,
        lastBucketId: await store.getLastBucketId(), selfTabId: null });
      const row = view.rows[0]!;
      expect(view.buckets).toEqual(buckets);
      expect(triageBucketChoice(row, view)).toBe(bucket.id);
      expect(triageBucketChoice(row, view, new Map([[row.tabId, bucket.id]]))).toBe(bucket.id);
      await captureTriage(store, row, triageBucketChoice(row, view), "72h");
    } else {
      await store.trackTab({ tabId: tab.id, windowId: 1, trackId: "track", url: tab.url,
        title: tab.title, favIconUrl: tab.favIconUrl, keepOpen: false, inactiveSince: null });
      await store.recordTabClosed(tab.id);
      const entries = recentlyClosedView({ recentlyClosed: await store.getRecentlyClosed(), items: await store.getItems() });
      expect(entries).toHaveLength(1);
      const chosen = captureBucketId(buckets);
      expect(chosen).toBe(bucket.id);
      await fileClosed(store, entries[0]!, chosen, "72h");
      expect(await store.getRecentlyClosed()).toEqual([]);
      expect(recentlyClosedView({ recentlyClosed: await store.getRecentlyClosed(), items: await store.getItems() })).toEqual([]);
    }
    const items = await store.getItems();
    expect(items).toEqual([expect.objectContaining({ bucketId: bucket.id, url: tab.url, title: tab.title,
      favIconUrl: tab.favIconUrl, riffle: "72h" })]);
    expect(await store.getLastBucketId()).toBe(bucket.id);
    expect((await launcher(store)).queue.map((item) => item.id)).toEqual([items[0]!.id]);
  });
});

describe("bucket rename across surfaces", () => {
  test.each([false, true])("renames a %s added bucket with identity and restart persistence", async (added) => {
    const { store, storage } = fixture();
    const [seed] = await store.getBuckets();
    const bucket = added ? await store.addBucket("Reading") : seed!;
    const queued = await saveTab(store, tab, bucket.id, "72h");
    const stale = await store.addItem({ url: "https://example.com/stale", title: "Article archived", bucketId: bucket.id, riffle: "stale" });
    const itemsBefore = await store.getItems();
    const renamed = await store.renameBucket(bucket.id, "  Work  ");
    expect(renamed).toEqual({ ...bucket, name: "Work" });
    const buckets = await store.getBuckets();
    expect(bucketList(buckets).find((entry) => entry.id === bucket.id)?.name).toBe("Work");
    const view = await launcher(store, STALE_SELECTION_ID, "Article");
    expect(view.switcher.find((entry) => entry.id === bucket.id)?.name).toBe("Work");
    expect(view.staleSelected).toBe(true);
    expect(view.staleItems).toEqual([expect.objectContaining({ id: stale.id, bucketName: "Work" })]);
    expect(view.searchResults.map((entry) => [entry.id, entry.bucketName])).toEqual([[queued.id, "Work"], [stale.id, "Work"]]);
    const queuedPopup = await popup(store);
    expect(queuedPopup).toMatchObject({ kind: "queued", bucketName: "Work" });
    const addPopup = await popup(store, "https://example.com/new");
    expect(addPopup).toMatchObject({ kind: "add", defaultBucketId: bucket.id });
    if (addPopup.kind !== "add") throw new Error("Expected add form");
    expect(addPopup.buckets.find((entry) => entry.id === bucket.id)?.name).toBe("Work");
    expect(await store.getItems()).toEqual(itemsBefore);
    expect(await store.getLastBucketId()).toBe(bucket.id);
    const fresh = createStore(storage);
    expect(await fresh.getBuckets()).toEqual(buckets);
    expect((await fresh.getBuckets()).filter((entry) => entry.name === "Default")).toHaveLength(added ? 1 : 0);
    expect(await fresh.getItems()).toEqual(itemsBefore);
    expect(await fresh.getLastBucketId()).toBe(bucket.id);
  });
});

test("capture controls call the actions exercised with the real store", async () => {
  const newtab = await readFile(new URL("index.ts", import.meta.url), "utf8");
  expect(newtab).toContain('from "./actions"');
  expect(newtab).toContain("bucketSelect.value = captureBucketId(buckets)");
  expect(newtab).toContain("fileClosed(store, entry, bucketSelect.value, riffleSelect.value as RiffleId)");
  expect(newtab).toContain("triageBucketChoice(row, view, triageState?.bucketChoices)");
  expect(newtab).toContain("captureTriage(store, row, bucketChoiceForRow(row, view), riffle)");
  expect(newtab).not.toContain("store.addItem(");
  const popup = await readFile(new URL("../popup/index.ts", import.meta.url), "utf8");
  expect(popup).toMatch(/saveTab\(store,\s*tab,/);
  expect(popup).not.toContain("store.addItem(");
});
