// Holds the light theme of src/newtab/index.html to the same standard
// darkmode.test.ts holds the dark theme to, plus the rounded-corner minimums.
// Helpers below are copied from darkmode.test.ts rather than imported, per that
// file's own convention of keeping each guard test self-contained.
import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function styleBlock(): Promise<string> {
  const html = await read("index.html");
  const match = html.match(/<style>([\s\S]*)<\/style>/);
  const css = match?.[1];
  if (css === undefined) {
    throw new Error("no <style> block found in index.html");
  }
  return css;
}

// Everything before the dark media query, so a selector that appears in both
// themes (e.g. .item-card) resolves to its light-theme declaration.
async function lightModeBlock(): Promise<string> {
  const css = await styleBlock();
  const darkIndex = css.indexOf("@media");
  if (darkIndex === -1) {
    throw new Error("no @media block found, cannot isolate the light rules");
  }
  return css.slice(0, darkIndex);
}

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

// Falls back to the `border`/`outline` shorthand when a selector sets its colour that
// way (e.g. `border: 1px solid #c7d3d2;`) rather than the longhand `border-color`.
const SHORTHAND_FOR: Record<string, string> = {
  "border-color": "border",
  "outline-color": "outline",
};

function colorFor(cssText: string, selector: string, property: string): string {
  const block = declarationsFor(cssText, selector);
  const direct = block.match(new RegExp(`(?<![\\w-])${property}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (direct?.[1] !== undefined) return direct[1];

  const shorthandProp = SHORTHAND_FOR[property];
  if (shorthandProp !== undefined) {
    const shorthand = block.match(new RegExp(`(?<![\\w-])${shorthandProp}:\\s*[^;]*?(#[0-9a-fA-F]{3,8})`));
    if (shorthand?.[1] !== undefined) return shorthand[1];
  }

  throw new Error(`no ${property} colour for ${selector} in: ${block}`);
}

function radiusFor(cssText: string, selector: string): number {
  const block = declarationsFor(cssText, selector);
  const match = block.match(/border-radius:\s*([\d.]+)px/);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`no border-radius (in px) for ${selector} in: ${block}`);
  }
  return Number(value);
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

function colorDistance(hexA: string, hexB: string): number {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

// Same thresholds as darkmode.test.ts: 4.5:1 text, 3:1 focus/non-text, 60 RGB
// distance for accents/borders, 10 RGB distance for backgrounds.
const AA_TEXT_CONTRAST = 4.5;
const NON_TEXT_CONTRAST = 3;
const DISTINCT_ACCENT = 60;
const DISTINCT_BACKGROUND = 10;

describe("new tab page light theme: rounded corners", () => {
  test("boxed surfaces have at least an 8px radius", async () => {
    const light = await lightModeBlock();
    for (const selector of [
      ".open-tabs-panel",
      ".queue-section",
      ".recently-closed-panel",
      ".item-card",
      ".banner",
      ".triage-row",
    ]) {
      expect(radiusFor(light, selector), selector).toBeGreaterThanOrEqual(8);
    }

    // .empty-state is a shared rule in common.css, not index.html's own stylesheet.
    const commonCss = await read("../common.css");
    expect(radiusFor(commonCss, ".empty-state")).toBeGreaterThanOrEqual(8);
  });

  test("controls have at least a 6px radius (a pill shape also qualifies)", async () => {
    const light = await lightModeBlock();
    for (const selector of [
      ".bucket-button",
      ".bucket-button.stale",
      ".search-input",
      ".item-riffle",
      ".recently-closed-toggle",
      ".wash-now-button",
      ".triage-bucket-button",
      ".triage-riffle-button",
      ".triage-confirm",
      ".triage-cancel",
      "button",
    ]) {
      expect(radiusFor(light, selector), selector).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("new tab page light theme: readability and distinctness", () => {
  test("body, secondary and control text stay readable (WCAG AA) against their light backgrounds", async () => {
    const light = await lightModeBlock();

    const bodyText = colorFor(light, "body", "color");
    const bodyBg = colorFor(light, "body", "background");
    expect(contrastRatio(bodyText, bodyBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);

    // Secondary text (domain/age/due labels) sits on the item card's background.
    const secondaryText = colorFor(light, ".item-domain", "color");
    const cardBg = colorFor(light, ".item-card", "background");
    expect(contrastRatio(secondaryText, cardBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);

    const controlText = colorFor(light, "button", "color");
    const controlBg = colorFor(light, "button", "background");
    expect(contrastRatio(controlText, controlBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);

    // The Stale entry's background comes from the ordinary .bucket-button rule it shares.
    const staleText = colorFor(light, ".bucket-button.stale", "color");
    const bucketBg = colorFor(light, ".bucket-button", "background");
    expect(contrastRatio(staleText, bucketBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);

    const riffleText = colorFor(light, ".item-riffle", "color");
    const riffleBg = colorFor(light, ".item-riffle", "background");
    expect(contrastRatio(riffleText, riffleBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);

    const bannerText = colorFor(light, ".banner", "color");
    const bannerBg = colorFor(light, ".banner", "background");
    expect(contrastRatio(bannerText, bannerBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });

  test("overdue cards stay distinct from regular cards and their due text stays readable", async () => {
    const light = await lightModeBlock();

    const regularBorder = colorFor(light, ".item-card", "border-color");
    const overdueBorder = colorFor(light, ".item-card.overdue", "border-color");
    expect(colorDistance(regularBorder, overdueBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const regularBg = colorFor(light, ".item-card", "background");
    const overdueBg = colorFor(light, ".item-card.overdue", "background");
    expect(colorDistance(regularBg, overdueBg)).toBeGreaterThanOrEqual(DISTINCT_BACKGROUND);

    const overdueDueText = colorFor(light, ".item-card.overdue .item-due", "color");
    expect(contrastRatio(overdueDueText, overdueBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });

  test("selected bucket and triage buttons, and the Stale entry, stay distinct from ordinary ones", async () => {
    const light = await lightModeBlock();

    const bucketBorder = colorFor(light, ".bucket-button", "border-color");
    const bucketSelectedBorder = colorFor(light, ".bucket-button.selected", "border-color");
    expect(colorDistance(bucketBorder, bucketSelectedBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const triageBorder = colorFor(light, ".triage-bucket-button", "border-color");
    const triageSelectedBorder = colorFor(light, ".triage-bucket-button.selected", "border-color");
    expect(colorDistance(triageBorder, triageSelectedBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const staleBorder = colorFor(light, ".bucket-button.stale", "border-color");
    expect(colorDistance(bucketBorder, staleBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const staleSelectedBorder = colorFor(light, ".bucket-button.stale.selected", "border-color");
    expect(colorDistance(bucketSelectedBorder, staleSelectedBorder)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);
  });

  test("the banner stays distinct from the panel background around it and reads clearly", async () => {
    const light = await lightModeBlock();

    const bannerBg = colorFor(light, ".banner", "background");
    const panelBg = colorFor(light, ".queue-section", "background");
    expect(colorDistance(bannerBg, panelBg)).toBeGreaterThanOrEqual(DISTINCT_BACKGROUND);

    const bodyText = colorFor(light, "body", "color");
    expect(contrastRatio(bodyText, bannerBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });

  test("focus outlines stay distinct from the surfaces they appear over, including overdue cards", async () => {
    const light = await lightModeBlock();

    const focusColor = colorFor(light, ".item-card:focus", "outline-color");
    const cardBg = colorFor(light, ".item-card", "background");
    const overdueBg = colorFor(light, ".item-card.overdue", "background");

    expect(contrastRatio(focusColor, cardBg)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST);
    expect(contrastRatio(focusColor, overdueBg)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST);
  });

  test("the destructive triage-confirm button stays distinct from triage-cancel and reads clearly", async () => {
    const light = await lightModeBlock();

    const confirmBg = colorFor(light, ".triage-confirm", "background");
    const cancelBg = colorFor(light, ".triage-cancel", "background");
    expect(colorDistance(confirmBg, cancelBg)).toBeGreaterThanOrEqual(DISTINCT_ACCENT);

    const confirmText = colorFor(light, ".triage-confirm", "color");
    expect(contrastRatio(confirmText, confirmBg)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });
});
