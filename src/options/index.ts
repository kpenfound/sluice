// Options page: buckets and pauses. See "Buckets in v1" and "Pause" in
// docs/design.md. All state and action decisions live in ./model; this file
// only renders DOM and wires events.
import type { Bucket } from "../lib/model";
import { createStore } from "../lib/store";
import {
  autoCloseMinutes,
  bucketList,
  parseAutoCloseMinutes,
  parsePauseForm,
  pauseRows,
  toDateTimeLocal,
  validBucketName,
} from "./model";
import type { PauseFormInput, PauseRow } from "./model";

const store = createStore(browser.storage);
const app = document.getElementById("app")!;

// Which pause row (if any) is showing its inline edit form. Local UI state,
// not store state, so it survives a re-render triggered by some other write.
let editingPauseId: string | null = null;

function showError(err: unknown): void {
  let message = document.getElementById("error");
  if (!message) {
    message = document.createElement("p");
    message.id = "error";
    message.setAttribute("role", "alert");
    app.append(message);
  }
  message.textContent = errorMessage(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderBucketRow(list: HTMLElement, bucket: Bucket): void {
  const li = document.createElement("li");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = bucket.name;
  nameInput.setAttribute("aria-label", `Name for ${bucket.name}`);
  li.append(nameInput);

  const message = document.createElement("p");
  li.append(message);

  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.textContent = "Rename";
  renameButton.addEventListener("click", () => {
    const name = nameInput.value;
    if (!validBucketName(name)) {
      message.textContent = "Bucket name must not be empty.";
      return;
    }
    message.textContent = "";
    store.renameBucket(bucket.id, name).catch((err: unknown) => {
      message.textContent = errorMessage(err);
    });
  });
  li.append(renameButton);

  list.append(li);
}

function renderAddBucketForm(container: HTMLElement): void {
  const form = document.createElement("form");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "New bucket name";
  nameInput.setAttribute("aria-label", "New bucket name");
  form.append(nameInput);

  const message = document.createElement("p");

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Add bucket";
  form.append(submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value;
    if (!validBucketName(name)) {
      message.textContent = "Bucket name must not be empty.";
      return;
    }
    message.textContent = "";
    store.addBucket(name).catch((err: unknown) => {
      message.textContent = errorMessage(err);
    });
  });

  form.append(message);
  container.append(form);
}

function renderBuckets(container: HTMLElement, buckets: Bucket[]): void {
  const section = document.createElement("section");

  const heading = document.createElement("h2");
  heading.textContent = "Buckets";
  section.append(heading);

  const list = document.createElement("ul");
  for (const bucket of bucketList(buckets)) {
    renderBucketRow(list, bucket);
  }
  section.append(list);

  renderAddBucketForm(section);

  container.append(section);
}

/** Builds the shared start/end-mode/end/label fields used by both the add and edit pause forms. */
function buildPauseFields(prefill?: { start: number; end: number | "until resumed"; label?: string }): {
  fieldset: HTMLElement;
  read: () => PauseFormInput;
} {
  const fieldset = document.createElement("div");

  const startInput = document.createElement("input");
  startInput.type = "datetime-local";
  if (prefill !== undefined) startInput.value = toDateTimeLocal(prefill.start);
  const startInputLabel = document.createElement("label");
  startInputLabel.textContent = "Start";
  startInputLabel.append(startInput);
  fieldset.append(startInputLabel);

  const endModeSelect = document.createElement("select");
  const modes: Array<{ value: PauseFormInput["endMode"]; label: string }> = [
    { value: "date", label: "Specific date and time" },
    { value: "now", label: "Until now" },
    { value: "none", label: "No end (until resumed)" },
  ];
  for (const mode of modes) {
    const option = document.createElement("option");
    option.value = mode.value;
    option.textContent = mode.label;
    endModeSelect.append(option);
  }
  const endModeSelectLabel = document.createElement("label");
  endModeSelectLabel.textContent = "End";
  endModeSelectLabel.append(endModeSelect);
  fieldset.append(endModeSelectLabel);

  const endInput = document.createElement("input");
  endInput.type = "datetime-local";
  const endInputLabel = document.createElement("label");
  endInputLabel.textContent = "End date and time";
  endInputLabel.append(endInput);
  fieldset.append(endInputLabel);

  if (prefill !== undefined) {
    if (prefill.end === "until resumed") {
      endModeSelect.value = "none";
      endInput.disabled = true;
    } else {
      endModeSelect.value = "date";
      endInput.value = toDateTimeLocal(prefill.end);
    }
  } else {
    endModeSelect.value = "none";
    endInput.disabled = true;
  }

  endModeSelect.addEventListener("change", () => {
    endInput.disabled = endModeSelect.value !== "date";
  });

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.placeholder = "Label (optional)";
  labelInput.value = prefill?.label ?? "";
  const labelInputLabel = document.createElement("label");
  labelInputLabel.textContent = "Label (optional)";
  labelInputLabel.append(labelInput);
  fieldset.append(labelInputLabel);

  return {
    fieldset,
    read: () => ({
      start: startInput.value,
      endMode: endModeSelect.value as PauseFormInput["endMode"],
      end: endInput.value,
      label: labelInput.value,
    }),
  };
}

function renderPauseEditForm(list: HTMLElement, row: PauseRow): void {
  const li = document.createElement("li");

  const { fieldset, read } = buildPauseFields({
    start: row.start,
    end: row.end,
    ...(row.label !== undefined ? { label: row.label } : {}),
  });
  li.append(fieldset);

  const message = document.createElement("p");

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => {
    const result = parsePauseForm(read(), Date.now());
    if (!result.ok) {
      message.textContent = result.error;
      return;
    }
    message.textContent = "";
    store.editPause(row.id, result.input).catch((err: unknown) => {
      message.textContent = errorMessage(err);
    });
  });
  li.append(saveButton);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => {
    editingPauseId = null;
    void renderApp().catch(showError);
  });
  li.append(cancelButton);

  li.append(message);
  list.append(li);
}

function renderPauseRow(list: HTMLElement, row: PauseRow): void {
  if (editingPauseId === row.id) {
    renderPauseEditForm(list, row);
    return;
  }

  const li = document.createElement("li");

  const text = document.createElement("span");
  const endText = row.end === "until resumed" ? "until resumed" : new Date(row.end).toLocaleString();
  const labelText = row.label !== undefined ? ` · ${row.label}` : "";
  const runningText = row.running ? " · running" : "";
  text.textContent = `${new Date(row.start).toLocaleString()} – ${endText}${labelText}${runningText}`;
  li.append(text);

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => {
    editingPauseId = row.id;
    void renderApp().catch(showError);
  });
  li.append(editButton);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => {
    void store.deletePause(row.id).catch(showError);
  });
  li.append(deleteButton);

  list.append(li);
}

function renderAddPauseForm(container: HTMLElement): void {
  const form = document.createElement("form");

  const { fieldset, read } = buildPauseFields();
  form.append(fieldset);

  const message = document.createElement("p");

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Add pause";
  form.append(submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = parsePauseForm(read(), Date.now());
    if (!result.ok) {
      message.textContent = result.error;
      return;
    }
    message.textContent = "";
    store.addPause(result.input).catch((err: unknown) => {
      message.textContent = errorMessage(err);
    });
  });

  form.append(message);
  container.append(form);
}

function renderWeekendPauseSetting(container: HTMLElement, enabled: boolean): void {
  const label = document.createElement("label");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = enabled;
  checkbox.addEventListener("change", () => {
    void store.setWeekendPauseEnabled(checkbox.checked).catch(showError);
  });
  label.append(checkbox);
  label.append(document.createTextNode(" Pause automatically on weekends"));

  container.append(label);
}

function renderPauses(container: HTMLElement, rows: PauseRow[], weekendPauseEnabled: boolean): void {
  const section = document.createElement("section");

  const heading = document.createElement("h2");
  heading.textContent = "Pauses";
  section.append(heading);

  renderWeekendPauseSetting(section, weekendPauseEnabled);

  const list = document.createElement("ul");
  for (const row of rows) {
    renderPauseRow(list, row);
  }
  section.append(list);

  renderAddPauseForm(section);

  container.append(section);
}

function renderTabs(container: HTMLElement, autoCloseAfter: number): void {
  const section = document.createElement("section");

  const heading = document.createElement("h2");
  heading.textContent = "Tabs";
  section.append(heading);

  const form = document.createElement("form");

  const label = document.createElement("label");
  label.textContent = "Auto-close inactive tabs after (minutes)";
  form.append(label);

  const minutesInput = document.createElement("input");
  minutesInput.type = "number";
  minutesInput.min = "1";
  minutesInput.step = "1";
  minutesInput.value = String(autoCloseMinutes(autoCloseAfter));
  label.append(minutesInput);

  const message = document.createElement("p");

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Save";
  form.append(submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = parseAutoCloseMinutes(minutesInput.value);
    if (!result.ok) {
      message.textContent = result.error;
      return;
    }
    message.textContent = "";
    store.setAutoCloseAfter(result.ms).catch((err: unknown) => {
      message.textContent = errorMessage(err);
    });
  });

  form.append(message);
  section.append(form);

  container.append(section);
}

async function renderApp(): Promise<void> {
  const [buckets, pauses, autoCloseAfter, weekendPauseEnabled] = await Promise.all([
    store.getBuckets(),
    store.getPauses(),
    store.getAutoCloseAfter(),
    store.getWeekendPauseEnabled(),
  ]);
  const rows = pauseRows(pauses, Date.now());

  app.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "Sluice settings";
  app.append(heading);
  const container = document.createElement("div");
  app.append(container);

  renderBuckets(container, buckets);
  renderPauses(container, rows, weekendPauseEnabled);
  renderTabs(container, autoCloseAfter);
}

void renderApp().catch(showError);
const unsubscribe = store.subscribe((changes) => {
  if (["buckets", "pauses", "autoCloseAfter", "weekendPauseEnabled"].some((key) => key in changes)) {
    void renderApp().catch(showError);
  }
});
window.addEventListener("unload", unsubscribe);
