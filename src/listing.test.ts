import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";

test("AMO metadata provides English listing copy, the tabs category and the project's MIT license", async () => {
  const metadata = JSON.parse(await readFile(new URL("../scripts/amo-metadata.json", import.meta.url), "utf8"));
  expect(metadata.summary["en-US"].length).toBeGreaterThan(0);
  expect(metadata.summary["en-US"].length).toBeLessThanOrEqual(250);
  expect(metadata.description["en-US"].length).toBeGreaterThan(0);
  expect(metadata.categories).toEqual(["tabs"]);
  expect(metadata.version.license).toBe("MIT");
  expect(await readFile(new URL("../LICENSE", import.meta.url), "utf8")).toMatch(/^MIT License/);
  expect(metadata.version.approval_notes).toContain("README.md");
  expect(metadata).not.toHaveProperty("homepage");
  expect(metadata).not.toHaveProperty("support_email");

  const listing = await readFile(new URL("../docs/listing.md", import.meta.url), "utf8");
  for (const paragraph of [metadata.summary["en-US"], ...metadata.description["en-US"].split("\n\n")]) {
    expect(listing).toContain(`> ${paragraph}`);
  }
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  for (const permission of manifest.permissions) expect(listing).toContain(`| \`${permission}\` |`);
  expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required).toEqual(["none"]);
});
