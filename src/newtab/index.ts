// New tab page: the launcher. See "Surfaces > New tab page" in docs/design.md.
// All ordering and grouping decisions live in ./model; this file only renders
// DOM, holds page state (the selected bucket and search query) and wires
// store actions to mouse events.
import type { AwayGap } from "../lib/away";
import type { ClosedTab, TrackedTab } from "../lib/lifecycle";
import type { Bucket, Item, Pause, RiffleId } from "../lib/model";
import { ENQUEUE_RIFFLES, RIFFLES } from "../lib/model";
import { createStore } from "../lib/store";
import type { WashTab } from "../lib/wash";
import { WASH_MESSAGE_TYPE } from "../lib/wash";
import {
  formatDuration,
  keyAction,
  launcherView,
  openTabsView,
  recentlyClosedPanelView,
  recentlyClosedView,
  triageView,
} from "./model";
import type {
  AwayGapBanner,
  ItemView,
  KeyAction,
  LauncherView,
  OpenTabRow,
  PauseBanner,
  QueueEntry,
  RecentlyClosedPanelView,
  SwitcherEntry,
  TabCue,
  TriageRow,
  TriageView,
} from "./model";

const store = createStore(browser.storage);
const app = document.getElementById("app")!;

/** True at `newtab.html?wash=1`, the triage view's own path (`WASH_PAGE` in `../lib/wash`). */
const TRIAGE_MODE = new URLSearchParams(window.location.search).get("wash") === "1";

// The most recently rendered view, so event handlers can check whether actions are currently
// allowed at call time rather than trusting a closure captured when their control was drawn.
let currentView: LauncherView | null = null;

/** Whether item actions are currently allowed, per the most recent render. False before the first render. */
export function actionsEnabled(): boolean {
  return currentView?.actionsEnabled ?? false;
}

interface PageState {
  buckets: Bucket[];
  items: Item[];
  pauses: Pause[];
  awayGap: AwayGap | null;
  trackedTabs: TrackedTab[];
  autoCloseAfter: number;
  recentlyClosed: ClosedTab[];
  selectedBucketId: string | null;
  query: string;
  searchFocused: boolean;
  message: string | null;
  /**
   * Whether the Recently closed panel is expanded. Lives only in this page's own memory: set to
   * false once, on the first load, and never touched again by loadData(), so it survives every
   * later re-render but never persists past a reload or a new launcher tab (docs/design.md
   * Amendment 9).
   */
  recentlyClosedExpanded: boolean;
}

// Null until the first read of buckets, items, pauses, awayGap, trackedTabs and autoCloseAfter
// completes, so render() can show nothing actionable before then.
let state: PageState | null = null;

async function loadData(): Promise<void> {
  const [buckets, items, pauses, awayGap, trackedTabs, autoCloseAfter, recentlyClosed] = await Promise.all([
    store.getBuckets(),
    store.getItems(),
    store.getPauses(),
    store.getAwayGap(),
    store.getTrackedTabs(),
    store.getAutoCloseAfter(),
    store.getRecentlyClosed(),
  ]);
  if (state === null) {
    state = {
      buckets,
      items,
      pauses,
      awayGap,
      trackedTabs,
      autoCloseAfter,
      recentlyClosed,
      selectedBucketId: null,
      query: "",
      searchFocused: false,
      message: null,
      recentlyClosedExpanded: false,
    };
  } else {
    state.buckets = buckets;
    state.items = items;
    state.pauses = pauses;
    state.awayGap = awayGap;
    state.trackedTabs = trackedTabs;
    state.autoCloseAfter = autoCloseAfter;
    state.recentlyClosed = recentlyClosed;
  }
  render();
}

function showError(err: unknown): void {
  if (state === null) return;
  state.message = err instanceof Error ? err.message : String(err);
  render();
}

/** Runs a store action, showing a rejection as an inline message instead of letting it go unhandled. */
async function runAction(fn: () => Promise<unknown>): Promise<void> {
  if (state === null) return;
  state.message = null;
  try {
    await fn();
  } catch (err) {
    showError(err);
  }
}

/** Records the visit, then loads the item's URL in this tab. A rejected recordVisit shows inline instead of navigating. */
async function openItem(item: ItemView): Promise<void> {
  if (state === null || !actionsEnabled()) return;
  state.message = null;
  try {
    await store.recordVisit(item.url);
  } catch (err) {
    showError(err);
    return;
  }
  window.location.href = item.url;
}

function renderFavicon(favIconUrl: string | undefined): HTMLElement {
  if (favIconUrl !== undefined) {
    const img = document.createElement("img");
    img.className = "favicon";
    img.src = favIconUrl;
    img.alt = "";
    return img;
  }
  const placeholder = document.createElement("span");
  placeholder.className = "favicon favicon-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  return placeholder;
}

/** One entry card: an item plus its riffle and due label. `showBucketName` is true for the Stale view and search results. */
function renderItemCard(item: QueueEntry, view: LauncherView, showBucketName: boolean): HTMLElement {
  const card = document.createElement("div");
  card.className = item.overdue ? "item-card overdue" : "item-card";
  card.dataset.itemId = item.id;
  card.tabIndex = 0;

  const header = document.createElement("div");
  header.className = "item-header";
  header.append(renderFavicon(item.favIconUrl));

  const titleLink = document.createElement("a");
  titleLink.className = view.actionsEnabled ? "item-title" : "item-title disabled";
  titleLink.href = item.url;
  titleLink.textContent = item.title;
  titleLink.setAttribute("aria-disabled", view.actionsEnabled ? "false" : "true");
  titleLink.addEventListener("click", (event) => {
    event.preventDefault();
    void openItem(item);
  });
  header.append(titleLink);

  const riffleLabel = document.createElement("span");
  riffleLabel.className = "item-riffle";
  riffleLabel.textContent = item.riffle;
  header.append(riffleLabel);

  card.append(header);

  if (showBucketName) {
    const bucketLabel = document.createElement("span");
    bucketLabel.className = "item-bucket";
    bucketLabel.textContent = item.bucketName;
    card.append(bucketLabel);
  }

  const domain = document.createElement("span");
  domain.className = "item-domain";
  domain.textContent = item.domain;
  card.append(domain);

  const meta = document.createElement("span");
  meta.className = "item-meta";
  meta.textContent = `In riffle ${formatDuration(item.timeInRiffle)} · Age ${formatDuration(item.totalAge)}`;
  card.append(meta);

  if (item.dueLabel !== "") {
    const dueEl = document.createElement("span");
    dueEl.className = "item-due";
    dueEl.textContent = item.dueLabel;
    card.append(dueEl);
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "Open";
  openButton.disabled = !view.actionsEnabled;
  openButton.addEventListener("click", () => void openItem(item));
  actions.append(openButton);

  const deferButton = document.createElement("button");
  deferButton.type = "button";
  deferButton.textContent = "Defer";
  deferButton.disabled = !view.actionsEnabled;
  deferButton.addEventListener("click", () => {
    if (!actionsEnabled()) return;
    void runAction(() => store.deferItem(item.id));
  });
  actions.append(deferButton);

  const moveSelect = document.createElement("select");
  moveSelect.className = "move-select";
  moveSelect.setAttribute("aria-label", `Move ${item.title}`);
  moveSelect.disabled = !view.actionsEnabled;
  for (const option of RIFFLES) {
    const optionEl = document.createElement("option");
    optionEl.value = option;
    optionEl.textContent = option;
    moveSelect.append(optionEl);
  }
  moveSelect.value = item.riffle;
  moveSelect.addEventListener("change", () => {
    if (!actionsEnabled()) return;
    void runAction(() => store.moveItem(item.id, moveSelect.value as RiffleId));
  });
  actions.append(moveSelect);

  const bucketSelect = document.createElement("select");
  bucketSelect.className = "bucket-select";
  bucketSelect.setAttribute("aria-label", `Change bucket for ${item.title}`);
  bucketSelect.disabled = !view.actionsEnabled;
  for (const bucket of view.switcher) {
    if (bucket.isStale) continue;
    const optionEl = document.createElement("option");
    optionEl.value = bucket.id;
    optionEl.textContent = bucket.name;
    bucketSelect.append(optionEl);
  }
  bucketSelect.value = item.bucketId;
  bucketSelect.addEventListener("change", () => {
    if (!actionsEnabled()) return;
    void runAction(() => store.changeBucket(item.id, bucketSelect.value));
  });
  actions.append(bucketSelect);

  const resolveButton = document.createElement("button");
  resolveButton.type = "button";
  resolveButton.textContent = "Resolve";
  resolveButton.disabled = !view.actionsEnabled;
  resolveButton.addEventListener("click", () => {
    if (!actionsEnabled()) return;
    void runAction(() => store.resolveItem(item.id));
  });
  actions.append(resolveButton);

  card.append(actions);
  return card;
}

/** The single queue, Stale view or search results: one list of item cards, with an empty-state message when it has none. */
function renderQueueSection(entries: QueueEntry[], view: LauncherView, showBucketName: boolean, emptyMessage: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "queue-section";

  const list = document.createElement("div");
  list.className = "item-list";
  for (const item of entries) list.append(renderItemCard(item, view, showBucketName));
  section.append(list);

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyMessage;
    section.append(empty);
  }

  return section;
}

function renderBucketSwitcher(view: LauncherView): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "bucket-switcher";
  for (const entry of view.switcher) {
    const button = document.createElement("button");
    button.type = "button";
    const classes = ["bucket-button"];
    if (entry.isStale) classes.push("stale");
    if (entry.selected) classes.push("selected");
    button.className = classes.join(" ");
    button.textContent = `${entry.name} (${entry.count})`;
    button.setAttribute("aria-pressed", String(entry.selected));
    button.addEventListener("click", () => {
      if (state === null) return;
      state.selectedBucketId = entry.id;
      render();
    });
    nav.append(button);
  }
  return nav;
}

function renderSearch(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "search";
  input.className = "search-input";
  input.placeholder = "Search every bucket and riffle";
  input.setAttribute("aria-label", "Search every bucket and riffle");
  input.value = state?.query ?? "";
  input.addEventListener("input", () => {
    if (state === null) return;
    state.query = input.value;
    render();
  });
  input.addEventListener("focus", () => {
    if (state !== null) state.searchFocused = true;
  });
  input.addEventListener("blur", () => {
    if (state !== null) state.searchFocused = false;
  });
  return input;
}

function renderPauseBanner(banner: PauseBanner): HTMLElement {
  const div = document.createElement("div");
  div.className = "banner pause-banner";
  const text = document.createElement("span");
  text.textContent = `Paused since ${new Date(banner.start).toLocaleString()}`;
  div.append(text);
  const resumeButton = document.createElement("button");
  resumeButton.type = "button";
  resumeButton.textContent = "Resume";
  resumeButton.addEventListener("click", () => void runAction(() => store.resume()));
  div.append(resumeButton);
  return div;
}

function renderAwayGapBanner(banner: AwayGapBanner): HTMLElement {
  const div = document.createElement("div");
  div.className = "banner away-gap-banner";
  const text = document.createElement("span");
  const itemWord = banner.freed === 1 ? "item" : "items";
  text.textContent =
    `Firefox was closed from ${new Date(banner.start).toLocaleString()} to ` +
    `${new Date(banner.end).toLocaleString()} · pausing this gap would free ${banner.freed} ${itemWord}`;
  div.append(text);
  const acceptButton = document.createElement("button");
  acceptButton.type = "button";
  acceptButton.textContent = "Pause this gap";
  acceptButton.addEventListener("click", () => void runAction(() => store.acceptAwayGap()));
  div.append(acceptButton);
  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.textContent = "Dismiss";
  dismissButton.addEventListener("click", () => void runAction(() => store.dismissAwayGap()));
  div.append(dismissButton);
  return div;
}

/** Formats a tab's remaining-time cue. */
function cueText(cue: TabCue): string {
  switch (cue.kind) {
    case "notTimed":
      return "not auto-closed";
    case "active":
      return "active";
    case "keptOpen":
      return "kept open";
    case "closing":
      return "timer expired";
    case "remaining":
      return cue.label;
  }
}

/**
 * One "Open tabs" row: favicon/title/domain, the cue text and a native Keep open checkbox wired
 * to `store.setKeepOpen` through `runAction`. Deliberately not a `.item-card`, so the launcher's
 * keydown keymap and focus restoration ignore it and the checkbox is reachable by Tab as a plain
 * native control. Not gated by `actionsEnabled()`, so it works while an away-gap banner is pending.
 */
function renderOpenTabRow(row: OpenTabRow): HTMLElement {
  const div = document.createElement("div");
  div.className = "open-tab-row";

  div.append(renderFavicon(row.favIconUrl));

  const title = document.createElement("span");
  title.className = "open-tab-title";
  title.textContent = row.title;
  div.append(title);

  const domain = document.createElement("span");
  domain.className = "open-tab-domain";
  domain.textContent = row.domain;
  div.append(domain);

  const cue = document.createElement("span");
  cue.className = "open-tab-cue";
  cue.textContent = cueText(row.cue);
  div.append(cue);

  const label = document.createElement("label");
  label.className = "open-tab-keep-open";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = row.keepOpen;
  checkbox.addEventListener("change", () => {
    void runAction(() => store.setKeepOpen(row.tabId, checkbox.checked));
  });
  label.append(checkbox);
  label.append(document.createTextNode(" Keep open"));
  div.append(label);

  return div;
}

/** Sends the wash message, so the background washes straight away with this tab as the kept tab. No confirmation step. */
function washNow(): void {
  void runAction(() => browser.runtime.sendMessage({ type: WASH_MESSAGE_TYPE }));
}

/**
 * The "Wash now" button: sends the wash runtime message with no confirmation step, through the
 * existing `runAction` so a rejection shows the inline message. Not gated by `actionsEnabled()`
 * and deliberately not a `.item-card`, the same as the Recently closed panel's controls.
 */
function renderWashNowButton(): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wash-now-button";
  button.textContent = "Wash now";
  button.addEventListener("click", washNow);
  return button;
}

function renderOpenTabsPanel(rows: OpenTabRow[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "open-tabs-panel";

  const header = document.createElement("div");
  header.className = "open-tabs-header";
  const heading = document.createElement("h2");
  heading.textContent = "Open tabs";
  header.append(heading);
  header.append(renderWashNowButton());
  section.append(header);

  const list = document.createElement("div");
  list.className = "open-tabs-list";
  for (const row of rows) list.append(renderOpenTabRow(row));
  section.append(list);

  return section;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * One "Recently closed" row: favicon/title/domain/close time, a Reopen button, a bucket and
 * riffle `<select>` and a File button. Deliberately not a `.item-card`, so the launcher's keydown
 * keymap and focus restoration ignore it and its controls are reachable by Tab as plain native
 * controls. Not gated by `actionsEnabled()`, so it works while an away-gap banner is pending.
 */
function renderClosedRow(entry: ClosedTab, buckets: Bucket[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "closed-tab-row";

  div.append(renderFavicon(entry.favIconUrl));

  const title = document.createElement("span");
  title.className = "closed-tab-title";
  title.textContent = entry.title;
  div.append(title);

  const domain = document.createElement("span");
  domain.className = "closed-tab-domain";
  domain.textContent = domainOf(entry.url);
  div.append(domain);

  const closedAt = document.createElement("span");
  closedAt.className = "closed-tab-time";
  closedAt.textContent = new Date(entry.closedAt).toLocaleString();
  div.append(closedAt);

  const reopenButton = document.createElement("button");
  reopenButton.type = "button";
  reopenButton.textContent = "Reopen";
  reopenButton.addEventListener("click", () => {
    void runAction(async () => {
      await browser.tabs.create({ url: entry.url });
      await store.removeClosed(entry.id);
    });
  });
  div.append(reopenButton);

  const bucketSelect = document.createElement("select");
  bucketSelect.className = "closed-bucket-select";
  bucketSelect.setAttribute("aria-label", `Bucket for ${entry.title}`);
  for (const bucket of buckets) {
    const option = document.createElement("option");
    option.value = bucket.id;
    option.textContent = bucket.name;
    bucketSelect.append(option);
  }
  div.append(bucketSelect);

  const riffleSelect = document.createElement("select");
  riffleSelect.className = "closed-riffle-select";
  riffleSelect.setAttribute("aria-label", `Riffle for ${entry.title}`);
  for (const riffle of ENQUEUE_RIFFLES) {
    const option = document.createElement("option");
    option.value = riffle;
    option.textContent = riffle;
    riffleSelect.append(option);
  }
  riffleSelect.value = "72h";
  div.append(riffleSelect);

  const fileButton = document.createElement("button");
  fileButton.type = "button";
  fileButton.textContent = "File";
  fileButton.addEventListener("click", () => {
    void runAction(async () => {
      await store.addItem({
        url: entry.url,
        title: entry.title,
        favIconUrl: entry.favIconUrl,
        bucketId: bucketSelect.value,
        riffle: riffleSelect.value as RiffleId,
      });
      await store.removeClosed(entry.id);
    });
  });
  div.append(fileButton);

  return div;
}

/**
 * The "Recently closed" panel: a heading and a native expand/collapse button, always. Collapsed
 * (the default on every load, per docs/design.md Amendment 9), the list of rows is left out of
 * the DOM entirely, so no entry title, domain, URL, favicon, close time or row control is ever
 * rendered. The button toggles `state.recentlyClosedExpanded` and re-renders; its `aria-expanded`
 * reflects the current state, and being a plain `<button>`, it keeps native Tab/Enter/Space
 * behavior with no keymap change (`handleKeydown` ignores targets inside a button).
 */
function renderRecentlyClosedPanel(panel: RecentlyClosedPanelView, buckets: Bucket[], expanded: boolean): HTMLElement {
  const section = document.createElement("section");
  section.className = "recently-closed-panel";

  const header = document.createElement("div");
  header.className = "recently-closed-header";

  const heading = document.createElement("h2");
  heading.textContent = "Recently closed";
  header.append(heading);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "recently-closed-toggle";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-controls", "recently-closed-list");
  toggle.textContent = expanded ? "Hide" : `Show (${panel.count})`;
  toggle.addEventListener("click", () => {
    if (state === null) return;
    state.recentlyClosedExpanded = !state.recentlyClosedExpanded;
    render();
  });
  header.append(toggle);

  section.append(header);

  if (expanded) {
    const list = document.createElement("div");
    list.className = "closed-tabs-list";
    list.id = "recently-closed-list";
    for (const entry of panel.entries) list.append(renderClosedRow(entry, buckets));
    if (panel.entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "keyboard-help";
      empty.textContent = "Unqueued web tabs appear here after closing, for up to 7 days or 100 entries.";
      list.append(empty);
    }
    section.append(list);
  }

  return section;
}

/** The focused item card's id and index within the displayed list, so a re-render can restore focus. */
interface FocusedCardInfo {
  itemId: string;
  index: number;
}

/** Reads which item card (if any) currently holds focus, before render() tears down the DOM. */
function captureFocusedCardInfo(): FocusedCardInfo | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const card = active.closest<HTMLElement>(".item-card");
  if (card === null) return null;
  const itemId = card.dataset.itemId;
  if (itemId === undefined) return null;
  const cards = Array.from(app.querySelectorAll<HTMLElement>(".item-card"));
  return { itemId, index: cards.indexOf(card) };
}

/**
 * Restores focus after a render: the same item id if it's still visible, otherwise the item at
 * the nearest index in the displayed list, otherwise focus is left alone.
 */
function restoreFocusedCard(info: FocusedCardInfo | null): void {
  if (info === null) return;
  const cards = Array.from(app.querySelectorAll<HTMLElement>(".item-card"));
  if (cards.length === 0) return;
  const exact = cards.find((card) => card.dataset.itemId === info.itemId);
  if (exact !== undefined) {
    exact.focus();
    return;
  }
  cards[Math.min(info.index, cards.length - 1)]!.focus();
}

function render(): void {
  const focusInfo = captureFocusedCardInfo();
  const focused = document.activeElement;
  const searchSelection = focused instanceof HTMLInputElement && focused.type === "search"
    ? [focused.selectionStart, focused.selectionEnd] as const : null;
  app.replaceChildren();

  if (state === null) {
    currentView = null;
    const loading = document.createElement("p");
    loading.className = "loading";
    loading.textContent = "Loading…";
    app.append(loading);
    return;
  }

  const view = launcherView({
    buckets: state.buckets,
    items: state.items,
    pauses: state.pauses,
    awayGap: state.awayGap,
    selectedBucketId: state.selectedBucketId,
    query: state.query,
    now: Date.now(),
  });
  currentView = view;

  if (state.message !== null) {
    const messageEl = document.createElement("p");
    messageEl.className = "message";
    messageEl.textContent = state.message;
    app.append(messageEl);
  }

  const header = document.createElement("header");
  header.className = "page-header";
  const heading = document.createElement("h1");
  heading.textContent = "Sluice";
  const settings = document.createElement("button");
  settings.textContent = "Settings";
  settings.addEventListener("click", () => void runAction(() => browser.runtime.openOptionsPage()));
  header.append(heading, settings);
  app.append(header);

  const topRow = document.createElement("div");
  topRow.className = "top-row";
  topRow.append(renderBucketSwitcher(view));

  const searchInput = renderSearch();
  topRow.append(searchInput);
  app.append(topRow);
  if (searchSelection !== null || state.searchFocused) {
    searchInput.focus();
    const pos = searchInput.value.length;
    searchInput.setSelectionRange(searchSelection?.[0] ?? pos, searchSelection?.[1] ?? pos);
  }

  if (view.pauseBanner !== null) app.append(renderPauseBanner(view.pauseBanner));
  if (view.awayGapBanner !== null) app.append(renderAwayGapBanner(view.awayGapBanner));

  const openTabRows = openTabsView({
    trackedTabs: state.trackedTabs,
    autoCloseAfter: state.autoCloseAfter,
    now: Date.now(),
  });
  app.append(renderOpenTabsPanel(openTabRows));

  const searching = state.query.trim() !== "";
  let entries: QueueEntry[];
  let showBucketName: boolean;
  let emptyMessage: string;
  if (searching) {
    entries = view.searchResults;
    showBucketName = true;
    emptyMessage = "No items match your search.";
  } else if (view.staleSelected) {
    entries = view.staleItems;
    showBucketName = true;
    emptyMessage = "Nothing is Stale yet.";
  } else {
    entries = view.queue;
    showBucketName = false;
    emptyMessage = "Nothing queued here yet. Use Alt+Shift+S or the toolbar button on a page to save it for later.";
  }

  const mainContent = document.createElement("div");
  mainContent.className = "main-content";
  mainContent.append(renderQueueSection(entries, view, showBucketName, emptyMessage));

  const closedEntries = recentlyClosedView({ recentlyClosed: state.recentlyClosed, items: state.items });
  const closedPanel = recentlyClosedPanelView(closedEntries, state.recentlyClosedExpanded);
  mainContent.append(renderRecentlyClosedPanel(closedPanel, state.buckets, state.recentlyClosedExpanded));
  app.append(mainContent);

  const help = document.createElement("p");
  help.className = "keyboard-help";
  help.textContent =
    "Keyboard: / search · ↑↓ or j k navigate items · Enter open · d defer · m move · b change bucket · x resolve · [ ] switch buckets";
  app.append(help);

  restoreFocusedCard(focusInfo);
}

/** True when `target` is a form control or editable element the keymap must not fire over. */
function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  return target.isContentEditable;
}

function isSearchInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.classList.contains("search-input");
}

/** The currently displayed list: search results, the Stale view or the selected bucket's queue. */
function currentEntries(): QueueEntry[] {
  if (state === null || currentView === null) return [];
  if (state.query.trim() !== "") return currentView.searchResults;
  if (currentView.staleSelected) return currentView.staleItems;
  return currentView.queue;
}

function findItemViewById(id: string): QueueEntry | null {
  return currentEntries().find((item) => item.id === id) ?? null;
}

/** Moves focus to the previous/next item card within the displayed list. No-op at either end. */
function moveFocusInList(card: HTMLElement, delta: number): void {
  const list = card.parentElement;
  if (list === null) return;
  const cards = Array.from(list.children) as HTMLElement[];
  const index = cards.indexOf(card);
  const target = cards[index + delta];
  target?.focus();
}

/** Cycles the bucket row's selection, including the Stale entry, by `delta` positions. */
function switchBucket(delta: number): void {
  if (state === null || currentView === null) return;
  const entries: SwitcherEntry[] = currentView.switcher;
  const index = entries.findIndex((entry) => entry.selected);
  const target = entries[Math.min(Math.max(index + delta, 0), entries.length - 1)];
  if (target === undefined || target.selected) return;
  state.selectedBucketId = target.id;
  render();
}

function clearSearchAndFocusFirst(): void {
  if (state === null) return;
  state.query = "";
  render();
  app.querySelector<HTMLElement>(".item-card")?.focus();
}

/** Acts on the card an item-action key targets: open/defer/resolve via the store, move/changeBucket by focusing its select. */
function dispatchCardAction(action: KeyAction, card: HTMLElement): void {
  const itemId = card.dataset.itemId;
  if (itemId === undefined) return;
  switch (action) {
    case "nextItem":
      moveFocusInList(card, 1);
      return;
    case "prevItem":
      moveFocusInList(card, -1);
      return;
    case "open": {
      if (!actionsEnabled()) return;
      const item = findItemViewById(itemId);
      if (item !== null) void openItem(item);
      return;
    }
    case "defer":
      if (actionsEnabled()) void runAction(() => store.deferItem(itemId));
      return;
    case "resolve":
      if (actionsEnabled()) void runAction(() => store.resolveItem(itemId));
      return;
    case "move":
      if (actionsEnabled()) card.querySelector<HTMLSelectElement>(".move-select")?.focus();
      return;
    case "changeBucket":
      if (actionsEnabled()) card.querySelector<HTMLSelectElement>(".bucket-select")?.focus();
      return;
    default:
      return;
  }
}

/**
 * The launcher's single keydown handler. Browser shortcuts (Ctrl/Meta/Alt) are left alone.
 * Every other key goes through model.ts's keymap, so typing in the search box or a select does
 * nothing but Escape, and every handled key is prevented so it has no other effect (e.g. typing
 * "/" into a focused control). A card-scoped action that finds no focused card (for example the
 * Stale header, a native button outside any card) is left untouched, so Enter/Space still toggle
 * Stale natively.
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // Native controls keep Enter, Space and arrow-key behavior.
  if (event.target instanceof Element && event.target.closest("button, a, input[type=checkbox]")) return;

  const action = keyAction(event.key, isTextInputTarget(event.target));
  if (action === null) return;

  switch (action) {
    case "focusSearch": {
      event.preventDefault();
      app.querySelector<HTMLInputElement>(".search-input")?.focus();
      return;
    }
    case "prevBucket":
    case "nextBucket": {
      event.preventDefault();
      switchBucket(action === "nextBucket" ? 1 : -1);
      return;
    }
    case "clearSearch": {
      if (isSearchInput(event.target)) {
        event.preventDefault();
        clearSearchAndFocusFirst();
      } else if (event.target instanceof HTMLSelectElement) {
        const card = event.target.closest<HTMLElement>(".item-card");
        if (card !== null) {
          event.preventDefault();
          card.focus();
        }
      }
      return;
    }
    default: {
      const card = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".item-card") : null;
      if (card === null) return;
      event.preventDefault();
      dispatchCardAction(action, card);
    }
  }
}

async function init(): Promise<void> {
  await loadData();

  document.addEventListener("keydown", handleKeydown);

  const unsubscribe = store.subscribe((changes) => {
    if (Object.keys(changes).some((key) => key !== "lastActiveAt" && key !== "lastBucketId")) {
      void loadData().catch(showError);
    }
  });

  const timer = setInterval(() => render(), 60_000);

  window.addEventListener("unload", () => {
    document.removeEventListener("keydown", handleKeydown);
    unsubscribe();
    clearInterval(timer);
  });
}

/**
 * The triage view's own page state: the live reads `triageView` needs, plus which bucket each
 * row currently has selected (keyed by tabId, independent of `triageView`'s `defaultBucketId` so
 * a row's choice survives a re-render) and any inline action-rejection message.
 */
interface TriagePageState {
  buckets: Bucket[];
  items: Item[];
  trackedTabs: TrackedTab[];
  lastBucketId: string | null;
  tabs: WashTab[];
  selfTabId: number | null;
  bucketChoices: Map<number, string>;
  message: string | null;
}

let triageState: TriagePageState | null = null;

async function loadTriageData(): Promise<void> {
  const [buckets, items, trackedTabs, lastBucketId, tabs, currentTab] = await Promise.all([
    store.getBuckets(),
    store.getItems(),
    store.getTrackedTabs(),
    store.getLastBucketId(),
    browser.tabs.query({ windowType: "normal" }),
    browser.tabs.getCurrent(),
  ]);
  const selfTabId = currentTab?.id ?? null;
  if (triageState === null) {
    triageState = {
      buckets,
      items,
      trackedTabs,
      lastBucketId,
      tabs,
      selfTabId,
      bucketChoices: new Map(),
      message: null,
    };
  } else {
    triageState.buckets = buckets;
    triageState.items = items;
    triageState.trackedTabs = trackedTabs;
    triageState.lastBucketId = lastBucketId;
    triageState.tabs = tabs;
    triageState.selfTabId = selfTabId;
  }
  renderTriage();
}

/** Runs a triage action, showing a rejection as an inline message, the same pattern `runAction` uses for the launcher. */
async function runTriageAction(fn: () => Promise<unknown>): Promise<void> {
  if (triageState === null) return;
  triageState.message = null;
  try {
    await fn();
  } catch (err) {
    triageState.message = err instanceof Error ? err.message : String(err);
    renderTriage();
  }
}

/** The bucket a row's selector currently shows: its own stored choice, else `defaultBucketId`. */
function bucketChoiceForRow(row: TriageRow, view: TriageView): string {
  return triageState?.bucketChoices.get(row.tabId) ?? view.defaultBucketId ?? "";
}

function renderTriageRow(row: TriageRow, view: TriageView): HTMLElement {
  const div = document.createElement("div");
  div.className = "triage-row";

  div.append(renderFavicon(row.favIconUrl));

  const title = document.createElement("span");
  title.className = "triage-title";
  title.textContent = row.title;
  div.append(title);

  const domain = document.createElement("span");
  domain.className = "triage-domain";
  domain.textContent = row.domain;
  div.append(domain);

  const selectedBucketId = bucketChoiceForRow(row, view);

  const bucketButtons = document.createElement("div");
  bucketButtons.className = "triage-bucket-buttons";
  for (const bucket of view.buckets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = bucket.id === selectedBucketId ? "triage-bucket-button selected" : "triage-bucket-button";
    button.textContent = bucket.name;
    button.addEventListener("click", () => {
      if (triageState === null) return;
      triageState.bucketChoices.set(row.tabId, bucket.id);
      renderTriage();
    });
    bucketButtons.append(button);
  }
  div.append(bucketButtons);

  const riffleButtons = document.createElement("div");
  riffleButtons.className = "triage-riffle-buttons";
  for (const riffle of view.riffles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "triage-riffle-button";
    button.textContent = riffle;
    button.addEventListener("click", () => {
      void runTriageAction(() =>
        store.addItem({
          url: row.url,
          title: row.title,
          favIconUrl: row.favIconUrl,
          bucketId: bucketChoiceForRow(row, view),
          riffle,
        }),
      );
    });
    riffleButtons.append(button);
  }
  div.append(riffleButtons);

  return div;
}

/** Sends the wash message, so the background washes with this (triage) tab as the kept tab. */
function confirmWash(): void {
  void runTriageAction(() => browser.runtime.sendMessage({ type: WASH_MESSAGE_TYPE }));
}

/** Returns this tab to the launcher. Sends no message and closes nothing. */
function cancelTriage(): void {
  window.location.href = "newtab.html";
}

function renderTriage(): void {
  app.replaceChildren();

  if (triageState === null) {
    const loading = document.createElement("p");
    loading.className = "loading";
    loading.textContent = "Loading…";
    app.append(loading);
    return;
  }

  const view = triageView({
    tabs: triageState.tabs,
    trackedTabs: triageState.trackedTabs,
    items: triageState.items,
    buckets: triageState.buckets,
    lastBucketId: triageState.lastBucketId,
    selfTabId: triageState.selfTabId,
  });

  if (triageState.message !== null) {
    const messageEl = document.createElement("p");
    messageEl.className = "message";
    messageEl.textContent = triageState.message;
    app.append(messageEl);
  }

  const heading = document.createElement("h1");
  heading.textContent = "Wash";
  app.append(heading);

  if (view.rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "triage-empty";
    empty.textContent = "Nothing to triage.";
    app.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "triage-list";
    for (const row of view.rows) list.append(renderTriageRow(row, view));
    app.append(list);
  }

  const footer = document.createElement("div");
  footer.className = "triage-footer";

  const countEl = document.createElement("p");
  countEl.className = "triage-close-count";
  countEl.textContent = `${view.closeCount} tab${view.closeCount === 1 ? "" : "s"} will close.`;
  footer.append(countEl);

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "triage-confirm";
  confirmButton.textContent = "Confirm wash";
  confirmButton.addEventListener("click", confirmWash);
  footer.append(confirmButton);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "triage-cancel";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", cancelTriage);
  footer.append(cancelButton);

  app.append(footer);
}

async function initTriage(): Promise<void> {
  await loadTriageData();

  const unsubscribe = store.subscribe((changes) => {
    if (Object.keys(changes).some((key) => key !== "lastActiveAt")) void loadTriageData();
  });

  const timer = setInterval(() => {
    void loadTriageData();
  }, 60_000);

  window.addEventListener("unload", () => {
    unsubscribe();
    clearInterval(timer);
  });
}

void (TRIAGE_MODE ? initTriage() : init()).catch((error: unknown) => {
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = `Unable to load Sluice: ${error instanceof Error ? error.message : String(error)}`;
  app.replaceChildren(message);
});
