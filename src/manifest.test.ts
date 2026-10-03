import { describe, expect, test } from "vitest";
import manifest from "./manifest.json";

describe("manifest", () => {
  test("is a Firefox Manifest V3 extension with a fixed gecko id", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.browser_specific_settings.gecko.id).toMatch(/^sluice@/);
  });

  test("requests only the permissions the design lists", () => {
    expect([...manifest.permissions].sort()).toEqual(["alarms", "history", "storage", "tabs"]);
  });

  test("owns the new tab page and the toolbar popup", () => {
    expect(manifest.chrome_url_overrides.newtab).toBe("newtab.html");
    expect(manifest.action.default_popup).toBe("popup.html");
  });
});
