import { describe, expect, test } from "vitest";
import manifest from "./manifest.json";

describe("manifest", () => {
  test("is a Firefox Manifest V3 extension with the fixed gecko id sluice@kylepenfound.com", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.browser_specific_settings.gecko.id).toBe(
      "sluice@kylepenfound.com",
    );
  });

  test("requests exactly alarms, history, sessions, storage, tabs and no host permissions, content scripts or incognito key", () => {
    expect([...manifest.permissions].sort()).toEqual([
      "alarms",
      "history",
      "sessions",
      "storage",
      "tabs",
    ]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("incognito");
  });

  test("owns the new tab page and the toolbar popup", () => {
    expect(manifest.chrome_url_overrides.newtab).toBe("newtab.html");
    expect(manifest.action.default_popup).toBe("popup.html");
  });

  test("binds _execute_action to Alt+Shift+S", () => {
    const command = manifest.commands._execute_action;
    expect(command.suggested_key.default).toBe("Alt+Shift+S");
    expect(command.description).toBeTruthy();
  });

  test("declares the open-launcher command with no suggested key", () => {
    const command = manifest.commands["open-launcher"];
    expect(command.description).toBe("Open launcher");
    expect(command).not.toHaveProperty("suggested_key");
  });

  test("declares the wash command with no suggested key", () => {
    const command = manifest.commands.wash;
    expect(command.description).toBeTruthy();
    expect(command).not.toHaveProperty("suggested_key");
  });
});
