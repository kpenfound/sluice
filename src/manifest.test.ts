import { describe, expect, test } from "vitest";
import manifest from "./manifest.json";

describe("manifest", () => {
  test("is a Firefox Manifest V3 extension with a fixed gecko id", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.browser_specific_settings.gecko.id).toMatch(/^sluice@/);
  });

  test("requests only the permissions the design lists", () => {
    expect([...manifest.permissions].sort()).toEqual([
      "alarms",
      "history",
      "sessions",
      "storage",
      "tabs",
    ]);
  });

  test("owns the new tab page and the toolbar popup", () => {
    expect(manifest.chrome_url_overrides.newtab).toBe("newtab.html");
    expect(manifest.action.default_popup).toBe("popup.html");
  });

  test("declares the _execute_action command with a suggested key", () => {
    const command = manifest.commands._execute_action;
    expect(command.suggested_key.default).toBeTruthy();
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
