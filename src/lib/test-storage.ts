import type { StorageChange, StorageNamespace } from "./store";

type Listener = (changes: Record<string, StorageChange>, area: string) => void;

/** JSON-like in-memory storage for store integration tests; events can be delivered later. */
export class TestStorage implements StorageNamespace {
  private data: Record<string, unknown> = {};
  private listeners = new Set<Listener>();
  private pending: Array<Record<string, StorageChange>> = [];

  constructor(private deferEvents = false) {}

  local = {
    get: async (keys: string | string[]): Promise<Record<string, unknown>> => {
      const result: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in this.data) result[key] = this.data[key];
      }
      return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    },
    set: async (values: Record<string, unknown>): Promise<void> => {
      const serialized = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
      const changes: Record<string, StorageChange> = {};
      for (const [key, newValue] of Object.entries(serialized)) {
        changes[key] = { oldValue: this.data[key], newValue };
        this.data[key] = newValue;
      }
      this.pending.push(changes);
      if (!this.deferEvents) this.flushChanges();
    },
  };

  onChanged = {
    addListener: (listener: Listener): void => { this.listeners.add(listener); },
    removeListener: (listener: Listener): void => { this.listeners.delete(listener); },
  };

  flushChanges(): void {
    for (const changes of this.pending.splice(0)) {
      for (const listener of this.listeners) listener(changes, "local");
    }
  }
}
