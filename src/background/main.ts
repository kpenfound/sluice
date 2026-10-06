import { createStore } from "../lib/store";
import type { Store, StorageNamespace } from "../lib/store";
import { badgeText } from "./badge";
import { handleVisited } from "./revisit";
import { tick } from "./tick";

const ALARM_NAME = "sluice-tick";
const LAUNCHER_PAGE = "newtab.html";

/** The `browser` members the background script's event wiring uses. */
export interface BackgroundApi {
  storage: StorageNamespace;
  alarms: {
    get(name: string): Promise<browser.alarms.Alarm | undefined>;
    create(name: string, alarmInfo: browser.alarms._CreateAlarmInfo): Promise<void>;
    onAlarm: typeof browser.alarms.onAlarm;
  };
  commands: {
    onCommand: typeof browser.commands.onCommand;
  };
  history: {
    onVisited: typeof browser.history.onVisited;
  };
  runtime: {
    onInstalled: typeof browser.runtime.onInstalled;
    onStartup: typeof browser.runtime.onStartup;
    getURL: typeof browser.runtime.getURL;
  };
  tabs: {
    create: typeof browser.tabs.create;
  };
  action: {
    setBadgeText: typeof browser.action.setBadgeText;
  };
}

/** Creates the repeating alarm named `ALARM_NAME`, unless one is already registered. */
function ensureAlarm(api: BackgroundApi): Promise<void> {
  return api.alarms.get(ALARM_NAME).then((existing) => {
    if (existing !== undefined) return;
    return api.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  });
}

/** Runs the per-minute duties: writes `lastActiveAt`, prunes pauses, and sets the badge. */
function runTick(api: BackgroundApi, store: Store): Promise<void> {
  return tick({ store, setBadgeText: (text) => api.action.setBadgeText({ text }), now: Date.now });
}

/** Recomputes the badge from fresh store reads and sets it. */
async function refreshBadge(api: BackgroundApi, store: Store): Promise<void> {
  const [buckets, items, pauses] = await Promise.all([
    store.getBuckets(),
    store.getItems(),
    store.getPauses(),
  ]);
  await api.action.setBadgeText({ text: badgeText(buckets, items, pauses, Date.now()) });
}

/**
 * Registers every background listener synchronously against `api`, then ensures the
 * per-minute alarm exists. Carries no state between events: each handler reads
 * whatever it needs from storage through a store built fresh from `api.storage`.
 */
export function start(api: BackgroundApi): void {
  const store = createStore(api.storage);

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runTick(api, store);
  });

  api.history.onVisited.addListener((item) => {
    void handleVisited(store, item);
  });

  api.commands.onCommand.addListener((command) => {
    if (command !== "open-launcher") return;
    void api.tabs.create({ url: api.runtime.getURL(LAUNCHER_PAGE) });
  });

  api.runtime.onInstalled.addListener(() => {
    void ensureAlarm(api).then(() => runTick(api, store));
  });
  api.runtime.onStartup.addListener(() => {
    void store.recordAwayGap().then(() => ensureAlarm(api).then(() => runTick(api, store)));
  });

  store.subscribe(() => {
    void refreshBadge(api, store);
  });

  void ensureAlarm(api);
}
