import type { Store } from "../lib/store";
import { tabsToWash } from "../lib/wash";

/**
 * What a wash needs: a store, the `tabs` members it calls, and the two already-resolved
 * extension page URLs (`runtime.getURL` has no browser-free fake, so callers resolve these
 * once and pass the strings in).
 */
export interface WashDeps {
  store: Store;
  tabs: {
    query: typeof browser.tabs.query;
    remove: typeof browser.tabs.remove;
    create: typeof browser.tabs.create;
    update: (
      tabId: number,
      updateProperties: browser.tabs._UpdateUpdateProperties,
    ) => Promise<browser.tabs.Tab>;
  };
  launcherUrl: string;
  washUrl: string;
}

/**
 * Runs a wash. With no `keptTabId`, first creates a Sluice new tab and keeps that one.
 * Otherwise closes every tab `lib/wash.ts`'s `tabsToWash` selects (one `tabs.remove` call,
 * none when there is nothing to close), then navigates the kept tab to the launcher and
 * makes it active.
 */
export async function runWash(deps: WashDeps, options: { keptTabId?: number }): Promise<void> {
  const { store, tabs, launcherUrl } = deps;

  let keptTabId = options.keptTabId;
  if (keptTabId === undefined) {
    const created = await tabs.create({ url: launcherUrl });
    keptTabId = created.id;
  }

  const [liveTabs, trackedTabs] = await Promise.all([
    tabs.query({ windowType: "normal" }),
    store.getTrackedTabs(),
  ]);

  const toClose = tabsToWash(liveTabs, trackedTabs, keptTabId ?? null);
  if (toClose.length > 0) await tabs.remove(toClose);

  await tabs.update(keptTabId!, { url: launcherUrl, active: true });
}

/**
 * Handles the `wash` command. With no non-incognito tab open at `washUrl`, opens one and
 * closes nothing (the first press). Otherwise runs a wash straight away, keeping the active
 * one of those tabs, or the first `tabs.query` returned when none is active (the second
 * press).
 */
export async function handleWashCommand(deps: WashDeps): Promise<void> {
  const { tabs, washUrl } = deps;

  const liveTabs = await tabs.query({});
  const triageTabs = liveTabs.filter((tab) => !tab.incognito && tab.url === washUrl);

  if (triageTabs.length === 0) {
    await tabs.create({ url: washUrl });
    return;
  }

  const keptTab = triageTabs.find((tab) => tab.active) ?? triageTabs[0]!;
  await runWash(deps, { keptTabId: keptTab.id });
}
