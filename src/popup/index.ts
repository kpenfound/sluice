// Toolbar popup: the add form and pause control. See "Surfaces > Toolbar
// button and popup" in docs/design.md. All state and action decisions live
// in ./model; this file only renders DOM and wires events.
import { RIFFLES } from "../lib/model";
import type { RiffleId } from "../lib/model";
import { createStore } from "../lib/store";
import { move, pause, popupState, resolve, resumePause, saveTab, setKeepOpen } from "./model";
import type { AddState, PopupState, QueuedState, Tab } from "./model";

const store = createStore(browser.storage);
const app = document.getElementById("app")!;

function showError(error: unknown): void {
  let message = document.getElementById("error");
  if (!message) {
    message = document.createElement("p");
    message.id = "error";
    message.setAttribute("role", "alert");
    app.append(message);
  }
  message.textContent = error instanceof Error ? error.message : String(error);
}

async function getActiveTab(): Promise<{ tab: Tab; tabId: number }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return {
    tab: {
      url: tab?.url ?? "",
      title: tab?.title ?? "",
      ...(tab?.favIconUrl !== undefined ? { favIconUrl: tab.favIconUrl } : {}),
    },
    tabId: tab?.id ?? -1,
  };
}

async function readState(tab: Tab, tabId: number): Promise<PopupState> {
  const [buckets, items, pauses, trackedTabs, lastBucketId] = await Promise.all([
    store.getBuckets(),
    store.getItems(),
    store.getPauses(),
    store.getTrackedTabs(),
    store.getLastBucketId(),
  ]);
  return popupState({ tab, tabId, buckets, items, pauses, trackedTabs, lastBucketId, now: Date.now() });
}

function renderAddForm(container: HTMLElement, tab: Tab, state: AddState): void {
  const form = document.createElement("form");

  const title = document.createElement("p");
  title.textContent = state.title;
  form.append(title);

  const bucketSelect = document.createElement("select");
  bucketSelect.setAttribute("aria-label", "Bucket");
  for (const bucket of state.buckets) {
    const option = document.createElement("option");
    option.value = bucket.id;
    option.textContent = bucket.name;
    bucketSelect.append(option);
  }
  bucketSelect.value = state.defaultBucketId;
  form.append(bucketSelect);

  const riffleSelect = document.createElement("select");
  riffleSelect.setAttribute("aria-label", "Riffle");
  for (const riffle of state.riffles) {
    const option = document.createElement("option");
    option.value = riffle;
    option.textContent = riffle;
    riffleSelect.append(option);
  }
  riffleSelect.value = state.defaultRiffle;
  form.append(riffleSelect);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Add";
  form.append(submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveTab(store, tab, bucketSelect.value, riffleSelect.value as RiffleId).then(() => {
      window.close();
    }).catch(showError);
  });

  container.append(form);
  submit.focus();
}

function renderQueued(container: HTMLElement, state: QueuedState): void {
  const info = document.createElement("p");
  info.textContent = `${state.bucketName} · ${state.riffle}`;
  container.append(info);

  const riffleSelect = document.createElement("select");
  riffleSelect.setAttribute("aria-label", "Riffle");
  for (const riffle of RIFFLES) {
    const option = document.createElement("option");
    option.value = riffle;
    option.textContent = riffle;
    riffleSelect.append(option);
  }
  riffleSelect.value = state.riffle;
  container.append(riffleSelect);

  const moveButton = document.createElement("button");
  moveButton.textContent = "Move";
  moveButton.addEventListener("click", () => {
    void move(store, state.item.id, riffleSelect.value as RiffleId).catch(showError);
  });
  container.append(moveButton);

  const resolveButton = document.createElement("button");
  resolveButton.textContent = "Resolve";
  resolveButton.addEventListener("click", () => {
    void resolve(store, state.item.id).catch(showError);
  });
  container.append(resolveButton);
}

function renderUnqueueable(container: HTMLElement): void {
  const message = document.createElement("p");
  message.textContent = "This page can't be queued.";
  container.append(message);
}

function renderKeepOpen(container: HTMLElement, tabId: number, state: PopupState): void {
  if (!state.keepOpen.tracked) {
    return;
  }

  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.keepOpen.keepOpen;
  checkbox.addEventListener("change", () => {
    void setKeepOpen(store, tabId, checkbox.checked).catch(showError);
  });
  label.append(checkbox, "Keep this tab open");
  container.append(label);
}

function renderPauseControl(container: HTMLElement, state: PopupState): void {
  const section = document.createElement("section");

  if (state.pause.status === "running") {
    const resumeButton = document.createElement("button");
    resumeButton.textContent = "Resume";
    resumeButton.addEventListener("click", () => {
      void resumePause(store).catch(showError);
    });
    section.append(resumeButton);

    if (state.pause.end !== null) {
      const end = document.createElement("span");
      end.textContent = `Ends ${new Date(state.pause.end).toLocaleString()}`;
      section.append(end);
    }
  } else {
    const pauseButton = document.createElement("button");
    pauseButton.textContent = "Pause";

    const endInput = document.createElement("input");
    endInput.type = "datetime-local";
    endInput.setAttribute("aria-label", "Pause until (optional)");
    const endLabel = document.createElement("label");
    endLabel.textContent = "Pause until (optional)";
    endLabel.append(endInput);

    const message = document.createElement("p");

    pauseButton.addEventListener("click", () => {
      const end = endInput.value === "" ? null : new Date(endInput.value).getTime();
      void pause(store, end, Date.now()).then((result) => {
        message.textContent = result.ok ? "" : result.error;
      }).catch(showError);
    });

    section.append(pauseButton, endLabel, message);
  }

  container.append(section);
}

async function render(tab: Tab, tabId: number): Promise<void> {
  const state = await readState(tab, tabId);
  app.replaceChildren();

  const container = document.createElement("div");
  // Attached before being filled in, so focus() calls made while building its
  // contents (the add form's submit button) land on an element the document
  // actually recognizes as focusable.
  app.append(container);

  if (state.kind === "add") {
    renderAddForm(container, tab, state);
  } else if (state.kind === "queued") {
    renderQueued(container, state);
  } else {
    renderUnqueueable(container);
  }
  renderKeepOpen(container, tabId, state);
  renderPauseControl(container, state);
}

async function init(): Promise<void> {
  const { tab, tabId } = await getActiveTab();
  await render(tab, tabId);

  const unsubscribe = store.subscribe((changes) => {
    if (["buckets", "items", "pauses", "trackedTabs", "lastBucketId"].some((key) => key in changes)) {
      void render(tab, tabId).catch(showError);
    }
  });
  window.addEventListener("unload", unsubscribe);
}

void init().catch(showError);
