import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("new tab page dark-scheme support", () => {
  test("declares color-scheme so native controls and scrollbars follow the active theme", async () => {
    const html = await read("index.html");
    expect(html).toMatch(/color-scheme:\s*light dark/);
  });

  test("overrides the light palette under a prefers-color-scheme: dark media query", async () => {
    const html = await read("index.html");
    const darkBlockMatch = html.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*{([\s\S]*)}\s*<\/style>/);
    expect(darkBlockMatch).not.toBeNull();
    const darkBlock = darkBlockMatch![1];

    for (const selector of [
      "body",
      ".column",
      ".open-tabs-panel",
      ".recently-closed-panel",
      ".triage-row",
      ".banner",
      ".item-card.overdue",
      "button",
    ]) {
      expect(darkBlock, `expected dark-mode rules for ${selector}`).toContain(selector);
    }
  });

  test("popup and options pages are not opted into a forced colour scheme", async () => {
    const popupHtml = await read("../popup/index.html");
    const optionsHtml = await read("../options/index.html");
    expect(popupHtml).not.toMatch(/color-scheme/);
    expect(optionsHtml).not.toMatch(/color-scheme/);
  });

  test("shared common.css does not declare a page-wide colour scheme", async () => {
    const commonCss = await read("../common.css");
    expect(commonCss).not.toMatch(/color-scheme/);
  });
});
