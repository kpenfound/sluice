import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createStore } from "../lib/store";
import { TestStorage } from "../lib/test-storage";
import { parsePauseForm, pauseRows, savePauseEdit } from "./model";
import type { PauseEditUI } from "./model";

const now = new Date(2024, 2, 15, 12).getTime();

function parsed(label: string) {
  const result = parsePauseForm({ start: "2024-03-01T09:00", endMode: "date", end: "2024-03-02T09:00", label }, now);
  if (!result.ok) throw new Error(result.error);
  return result.input;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(deferEvents = false) {
  const storage = new TestStorage(deferEvents);
  const store = createStore(storage, { now: () => now, newId: () => "pause" });
  const pause = await store.addPause(parsed("Vacation"));
  storage.flushChanges();
  const state = { editingId: pause.id as string | null, error: null as string | null,
    rendered: { mode: "edit", error: null as string | null, label: "Vacation" as string | undefined } };
  const ui: PauseEditUI = {
    editingId: () => state.editingId,
    setEditingId: (id) => { state.editingId = id; },
    setError: (error) => { state.error = error; },
    refresh: async () => {
      const row = pauseRows(await store.getPauses(), now)[0]!;
      state.rendered = { mode: state.editingId === row.id ? "edit" : "display", error: state.error, label: row.label };
    },
  };
  const refreshes: Array<Promise<void>> = [];
  store.subscribe((changes) => {
    if ("pauses" in changes) refreshes.push(ui.refresh());
  });
  return { storage, store, pause, state, ui, refreshes };
}

describe("pause edit Save", () => {
  test.each(["", "   ", "  Time off  "])("saves the form label %j through JSON-like storage", async (label) => {
    const { store, pause, ui, state } = await fixture();
    await savePauseEdit(store, pause.id, parsed(label), ui);
    const [saved] = await store.getPauses();
    expect(saved!.label).toBe(label.trim() || undefined);
    if (label.trim() === "") expect(saved).not.toHaveProperty("label");
    expect(state.rendered).toMatchObject({ mode: "display", error: null, label: label.trim() || undefined });
  });

  test.each(["before", "after"])("returns to display when storage refresh arrives %s Save completes", async (order) => {
    const { store, storage, pause, state, ui, refreshes } = await fixture(order === "after");
    const wrote = deferred();
    const complete = deferred();
    const saving = savePauseEdit({
      editPause: async (id, patch) => {
        const saved = await store.editPause(id, patch);
        wrote.resolve();
        await complete.promise;
        return saved;
      },
    }, pause.id, parsed("Saved label"), ui);
    await wrote.promise;
    await Promise.all(refreshes);
    expect(state.editingId).toBe(pause.id);
    expect(state.rendered.mode).toBe("edit");
    if (order === "before") {
      expect(refreshes).toHaveLength(1);
      expect(state.rendered.label).toBe("Saved label");
    } else {
      expect(refreshes).toHaveLength(0);
    }
    complete.resolve();
    await saving;
    expect(state.editingId).toBeNull();
    expect(state.rendered).toEqual({ mode: "display", error: null, label: "Saved label" });
    storage.flushChanges();
    await Promise.all(refreshes);
    expect(refreshes).toHaveLength(1);
    expect(state.rendered.mode).toBe("display");
    expect((await store.getPauses())[0]!.label).toBe("Saved label");
  });

  test("a rejected Save stays in edit mode and displays the error across refreshes", async () => {
    const { store, pause, state, ui } = await fixture();
    const before = await store.getPauses();
    await savePauseEdit(store, pause.id, { start: 20, end: 10 }, ui);
    expect(state.editingId).toBe(pause.id);
    expect(state.rendered).toMatchObject({ mode: "edit", error: "Invalid pause: end must be null or after start." });
    expect(await store.getPauses()).toEqual(before);
    await ui.refresh();
    expect(state.rendered).toMatchObject({ mode: "edit", error: "Invalid pause: end must be null or after start." });
  });

  test("completion of an older Save leaves another pause's edit mode intact", async () => {
    const { store, pause, state, ui } = await fixture();
    const wrote = deferred();
    const complete = deferred();
    const saving = savePauseEdit({ editPause: async (id, patch) => {
      const saved = await store.editPause(id, patch);
      wrote.resolve();
      await complete.promise;
      return saved;
    } }, pause.id, parsed("Saved"), ui);
    await wrote.promise;
    state.editingId = "another-pause";
    complete.resolve();
    await saving;
    expect(state.editingId).toBe("another-pause");
  });
});

test("options Save uses the tested transition and renders persistent edit errors", async () => {
  const source = await readFile(new URL("index.ts", import.meta.url), "utf8");
  expect(source).toContain("savePauseEdit(store, row.id, result.input");
  expect(source).toContain("editingId: () => editingPauseId");
  expect(source).toContain("setEditingId: (id) => { editingPauseId = id; }");
  expect(source).toContain("setError: (error) => { pauseEditError = error; }");
  expect(source).toContain("refresh: renderApp");
  expect(source).toContain("message.textContent = pauseEditError");
  expect(source).not.toContain("store.editPause(");
});
