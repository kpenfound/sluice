import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function darkModeBlock(): Promise<string> {
  const html = await read("index.html");
  const match = html.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*{([\s\S]*)}\s*<\/style>/);
  const darkCss = match?.[1];
  if (darkCss === undefined) {
    throw new Error("no prefers-color-scheme: dark block found in index.html");
  }
  return darkCss;
}

// Finds the declaration block for a selector that appears as its own token (not
// as a substring of a longer class name, e.g. "button" inside ".bucket-button"),
// so generic element selectors can be told apart from classes that merely contain them.
function declarationsFor(cssText: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w.-])${escaped}(?=[\\s,{:])`);
  const match = pattern.exec(cssText);
  if (!match) {
    throw new Error(`selector not found: ${selector}`);
  }
  const openBrace = cssText.indexOf("{", match.index);
  const closeBrace = cssText.indexOf("}", openBrace);
  return cssText.slice(openBrace + 1, closeBrace);
}

function colorFor(cssText: string, selector: string, property: string): string {
  const block = declarationsFor(cssText, selector);
  // (?<![\w-]) rather than \b: a plain word boundary would match "color:" as a
  // suffix of "border-color:" too, since "-" is a non-word character.
  const match = block.match(new RegExp(`(?<![\\w-])${property}:\\s*(#[0-9a-fA-F]{3,8})`));
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`no ${property} colour for ${selector} in: ${block}`);
  }
  return value;
}

function hexToRgb(hex: string): [number, number, number] {
  let value = hex.replace("#", "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(value.slice(0, 6), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// WCAG relative luminance and contrast ratio: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function linearize(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

// Plain Euclidean RGB distance. Two dark, similarly-bright colours of different
// hue (e.g. a reddish-dark overdue background next to a neutral-dark card) have a
// contrast ratio near 1 because that ratio only measures luminance, yet they are
// plainly different colours to a reader. This catches that case; contrastRatio
// above is used instead wherever foreground-on-background readability matters.
function colorDistance(hexA: string, hexB: string): number {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

describe("new tab page dark-scheme support", () => {
  test("declares color-scheme so native controls and scrollbars follow the active theme", async () => {
    const html = await read("index.html");
    expect(html).toMatch(/color-scheme:\s*light dark/);
  });

  test("overrides the light palette under a prefers-color-scheme: dark media query", async () => {
    const darkBlock = await darkModeBlock();

    for (const selector of [
      "body",
      ".queue-section",
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

  test("index.ts has no JS theme detection, so the scheme stays driven only by CSS", async () => {
    const indexTs = await read("index.ts");
    expect(indexTs).not.toMatch(/matchMedia/);
    expect(indexTs).not.toMatch(/prefers-color-scheme/);
    expect(indexTs).not.toMatch(/theme-preference/);
  });
});

describe("dark-mode colour distinctness and readability", () => {
  // These thresholds sit comfortably below the current palette's measured
  // values, leaving headroom for a future palette tweak, while still failing
  // if two states collapse to the same or a near-identical colour.
  const AA_TEXT_CONTRAST = 4.5;
  const NON_TEXT_CONTRAST = 3;
  const DISTINCT_ACCENT = 60;
  const DISTINCT_BACKGROUND = 10;

  test("body and control text stay readable (WCAG AA) against their dark backgrounds", async () => {
    const dark = await darkModeBlock();
    const bodyText = colorFor(dark, "body", "color");
    const bodyBg = colorFor(dark, "body", "background");
    expect(contrastRatio(bodyText, bodyBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);

    const dueText = colorFor(dark, ".item-due", "color");
    const cardBg = colorFor(dark, ".item-card", "background");
    expect(contrastRatio(dueText, cardBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);

    const controlText = colorFor(dark, "button", "color");
    const controlBg = colorFor(dark, "button", "background");
    expect(contrastRatio(controlText, controlBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });

  test("overdue cards stay distinct from regular cards and their due text stays readable", async () => {
    const dark = await darkModeBlock();
    const regularBorder = colorFor(dark, ".item-card", "border-color");
    const overdueBorder = colorFor(dark, ".item-card.overdue", "border-color");
    expect(colorDistance(regularBorder, overdueBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const regularBg = colorFor(dark, ".item-card", "background");
    const overdueBg = colorFor(dark, ".item-card.overdue", "background");
    expect(colorDistance(regularBg, overdueBg)).toBeGreaterThanOrEqual(DISTINCT_BACKGROUND);

    const overdueDueText = colorFor(dark, ".item-card.overdue .item-due", "color");
    expect(contrastRatio(overdueDueText, overdueBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });

  test("selected bucket and triage buttons stay distinct from unselected ones", async () => {
    const dark = await darkModeBlock();
    const bucketBorder = colorFor(dark, ".bucket-button", "border-color");
    const bucketSelectedBorder = colorFor(dark, ".bucket-button.selected", "border-color");
    expect(colorDistance(bucketBorder, bucketSelectedBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const triageBorder = colorFor(dark, ".triage-bucket-button", "border-color");
    const triageSelectedBorder = colorFor(dark, ".triage-bucket-button.selected", "border-color");
    expect(colorDistance(triageBorder, triageSelectedBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);
  });

  test("the pause/away-gap banner stays distinct from the panels around it and reads clearly", async () => {
    const dark = await darkModeBlock();
    const bannerBg = colorFor(dark, ".banner", "background");
    const columnBg = colorFor(dark, ".queue-section", "background");
    expect(colorDistance(bannerBg, columnBg)).toBeGreaterThanOrEqual(DISTINCT_BACKGROUND);

    const bodyText = colorFor(dark, "body", "color");
    expect(contrastRatio(bodyText, bannerBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });

  test("focus outlines stay distinct from the surfaces they appear over, including overdue cards", async () => {
    const dark = await darkModeBlock();
    const focusColor = colorFor(dark, ".item-card:focus", "outline-color");
    const cardBg = colorFor(dark, ".item-card", "background");
    const overdueBg = colorFor(dark, ".item-card.overdue", "background");

    expect(contrastRatio(focusColor, cardBg)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST);
    expect(contrastRatio(focusColor, overdueBg)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST);
    expect(colorDistance(focusColor, overdueBg)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);
  });

  test("the destructive triage-confirm button stays distinct from triage-cancel and reads clearly", async () => {
    const dark = await darkModeBlock();
    const confirmBg = colorFor(dark, ".triage-confirm", "background");
    const cancelBg = colorFor(dark, ".triage-cancel", "background");
    expect(colorDistance(confirmBg, cancelBg)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const confirmText = colorFor(dark, ".triage-confirm", "color");
    expect(contrastRatio(confirmText, confirmBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });

  test("disabled controls keep a theme-independent, opacity-based distinction from enabled ones", async () => {
    const commonCss = await read("../common.css");
    const disabled = declarationsFor(commonCss, "button:disabled");
    const opacityMatch = disabled.match(/opacity:\s*([\d.]+)/);
    expect(opacityMatch).not.toBeNull();
    const opacity = Number(opacityMatch![1]);
    // A fractional opacity dims whatever the active theme's enabled button
    // colour is, so disabled controls stay visually distinct in dark mode too
    // without needing a dark-specific disabled colour of their own.
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
  });
});
