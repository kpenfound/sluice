// New tab page: the launcher. See "Surfaces > New tab page" in docs/design.md.
// All ordering and grouping decisions live in ./model; this file only renders
// DOM, holds page state (the selected bucket, search query and Stale's
// expanded/collapsed state) and wires store actions to mouse events.
import type { AwayGap } from "../lib/away";
import type { Bucket, Item, Pause, RiffleId } from "../lib/model";
import { RIFFLES } from "../lib/model";
import { createStore } from "../lib/store";
import { dueLabel, formatDuration, launcherView } from "./model";
import type { Column, ItemView, LauncherView } from "./model";

const store = createStore(browser.storage);
const app = document.getElementById("app")!;

interface PageState {
  buckets: Bucket[];
  items: Item[];
  pauses: Pause[];
  awayGap: AwayGap | null;
  selectedBucketId: string | null;
  query: string;
  staleExpanded: boolean;
  searchFocused: boolean;
  message: string | null;
}

// Null until the first read of buckets, items, pauses and awayGap completes,
// so render() can show nothing actionable before then.
let state: PageState | null = null;

async function loadData(): Promise<void> {
  const [buckets, items, pauses, awayGap] = await Promise.all([
    store.getBuckets(),
    store.getItems(),
    store.getPauses(),
    store.getAwayGap(),
  ]);
  if (state === null) {
    state = {
      buckets,
      items,
      pauses,
      awayGap,
      selectedBucketId: null,
      query: "",
      staleExpanded: false,
      searchFocused: false,
      message: null,
    };
  } else {
    state.buckets = buckets;
    state.items = items;
    state.pauses = pauses;
    state.awayGap = awayGap;
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
  if (state === null) return;
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

/** The bucket id to preselect in an item's Change bucket control: the item's own bucket when searching, otherwise the shown bucket. */
function bucketIdForItem(item: ItemView, view: LauncherView, searching: boolean): string {
  if (!searching) return view.selectedBucketId;
  return view.buckets.find((bucket) => bucket.name === item.bucketName)?.id ?? "";
}

function renderItemCard(item: ItemView, riffle: RiffleId, view: LauncherView, searching: boolean): HTMLElement {
  const card = document.createElement("div");
  card.className = item.overdue ? "item-card overdue" : "item-card";
  card.dataset.itemId = item.id;

  const header = document.createElement("div");
  header.className = "item-header";
  header.append(renderFavicon(item.favIconUrl));

  const titleLink = document.createElement("a");
  titleLink.className = "item-title";
  titleLink.href = item.url;
  titleLink.textContent = item.title;
  titleLink.addEventListener("click", (event) => {
    event.preventDefault();
    void openItem(item);
  });
  header.append(titleLink);
  card.append(header);

  if (searching) {
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

  const due = dueLabel(item.remaining);
  if (due !== "") {
    const dueEl = document.createElement("span");
    dueEl.className = "item-due";
    dueEl.textContent = due;
    card.append(dueEl);
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "Open";
  openButton.addEventListener("click", () => void openItem(item));
  actions.append(openButton);

  const deferButton = document.createElement("button");
  deferButton.type = "button";
  deferButton.textContent = "Defer";
  deferButton.addEventListener("click", () => void runAction(() => store.deferItem(item.id)));
  actions.append(deferButton);

  const moveSelect = document.createElement("select");
  moveSelect.setAttribute("aria-label", `Move ${item.title}`);
  for (const option of RIFFLES) {
    const optionEl = document.createElement("option");
    optionEl.value = option;
    optionEl.textContent = option;
    moveSelect.append(optionEl);
  }
  moveSelect.value = riffle;
  moveSelect.addEventListener("change", () => {
    void runAction(() => store.moveItem(item.id, moveSelect.value as RiffleId));
  });
  actions.append(moveSelect);

  const bucketSelect = document.createElement("select");
  bucketSelect.setAttribute("aria-label", `Change bucket for ${item.title}`);
  for (const bucket of view.buckets) {
    const optionEl = document.createElement("option");
    optionEl.value = bucket.id;
    optionEl.textContent = bucket.name;
    bucketSelect.append(optionEl);
  }
  bucketSelect.value = bucketIdForItem(item, view, searching);
  bucketSelect.addEventListener("change", () => {
    void runAction(() => store.changeBucket(item.id, bucketSelect.value));
  });
  actions.append(bucketSelect);

  const resolveButton = document.createElement("button");
  resolveButton.type = "button";
  resolveButton.textContent = "Resolve";
  resolveButton.addEventListener("click", () => void runAction(() => store.resolveItem(item.id)));
  actions.append(resolveButton);

  card.append(actions);
  return card;
}

function renderColumn(column: Column, view: LauncherView, searching: boolean): HTMLElement {
  const section = document.createElement("section");
  section.className = "column";
  section.dataset.riffle = column.riffle;

  if (column.riffle === "stale") {
    const expanded = searching || (state?.staleExpanded ?? false);
    const header = document.createElement("button");
    header.type = "button";
    header.className = "stale-header";
    header.textContent = `Stale (${column.items.length})`;
    header.addEventListener("click", () => {
      if (state === null) return;
      state.staleExpanded = !state.staleExpanded;
      render();
    });
    section.append(header);
    if (expanded) {
      const list = document.createElement("div");
      list.className = "item-list";
      for (const item of column.items) list.append(renderItemCard(item, column.riffle, view, searching));
      section.append(list);
    }
  } else {
    const heading = document.createElement("h2");
    heading.textContent = column.riffle;
    section.append(heading);
    const list = document.createElement("div");
    list.className = "item-list";
    for (const item of column.items) list.append(renderItemCard(item, column.riffle, view, searching));
    section.append(list);
  }

  return section;
}

function renderBucketSwitcher(view: LauncherView): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "bucket-switcher";
  for (const bucket of view.buckets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = bucket.selected ? "bucket-button selected" : "bucket-button";
    button.textContent = `${bucket.name} (${bucket.overdueCount})`;
    button.addEventListener("click", () => {
      if (state === null) return;
      state.selectedBucketId = bucket.id;
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

function render(): void {
  app.replaceChildren();

  if (state === null) {
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
  const searching = view.staleExpanded;

  if (state.message !== null) {
    const messageEl = document.createElement("p");
    messageEl.className = "message";
    messageEl.textContent = state.message;
    app.append(messageEl);
  }

  app.append(renderBucketSwitcher(view));

  const searchInput = renderSearch();
  app.append(searchInput);
  if (state.searchFocused) {
    searchInput.focus();
    const pos = searchInput.value.length;
    searchInput.setSelectionRange(pos, pos);
  }

  const columns = document.createElement("div");
  columns.className = "columns";
  for (const column of view.columns) columns.append(renderColumn(column, view, searching));
  app.append(columns);
}

async function init(): Promise<void> {
  await loadData();

  const unsubscribe = store.subscribe(() => {
    void loadData();
  });

  const timer = setInterval(() => render(), 60_000);

  window.addEventListener("unload", () => {
    unsubscribe();
    clearInterval(timer);
  });
}

void init();
