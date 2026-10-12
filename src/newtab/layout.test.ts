import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

// Finds the declaration block for a selector, by locating its opening brace and
// then the matching closing one (so nested @media blocks don't confuse a plain
// regex match on the first "}" that follows).
function declarationsFor(cssText: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(cssText);
  if (!match) {
    throw new Error(`selector not found: ${selectorPattern}`);
  }
  const openBrace = cssText.indexOf("{", match.index);
  let depth = 0;
  let i = openBrace;
  for (; i < cssText.length; i++) {
    if (cssText[i] === "{") depth++;
    else if (cssText[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return cssText.slice(openBrace + 1, i);
}

describe("new tab page main-content layout split", () => {
  test("above the narrow-window breakpoint, the queue column is about one third and Recently closed about two thirds", async () => {
    const html = await read("index.html");
    const mainContentCss = declarationsFor(html, /\.main-content\s*{/);

    const columnsValue = mainContentCss.match(/grid-template-columns:\s*([^;]+);/)?.[1];
    if (columnsValue === undefined) {
      throw new Error("expected a grid-template-columns declaration on .main-content");
    }
    const columns = columnsValue.trim();

    // Accept either a bare "1fr 2fr" split or the zero-minimum form
    // "minmax(0, 1fr) minmax(0, 2fr)" (or equivalent), which keeps wide content
    // in either section from pulling the queue column past its one-third share.
    const trackPattern = /^(?:minmax\(0(?:px)?,\s*1fr\)|1fr)\s+(?:minmax\(0(?:px)?,\s*2fr\)|2fr)$/;
    expect(columns, `.main-content grid-template-columns was "${columns}", expected a 1:2 split`).toMatch(
      trackPattern,
    );
  });

  test("below the narrow-window breakpoint, the two sections stack into a single column", async () => {
    const html = await read("index.html");
    const narrowBlockCss = declarationsFor(html, /@media\s*\(max-width:\s*900px\)\s*{/);
    const mainContentCss = declarationsFor(narrowBlockCss, /\.main-content\s*{/);

    const columnsValue = mainContentCss.match(/grid-template-columns:\s*([^;]+);/)?.[1];
    if (columnsValue === undefined) {
      throw new Error("expected a grid-template-columns declaration on the narrow .main-content rule");
    }
    expect(columnsValue.trim()).toBe("1fr");
  });

  test("the queue section is appended before the right column, so it stays first and on the left", async () => {
    const indexTs = await read("index.ts");
    const queueIndex = indexTs.indexOf("renderQueueSection");
    expect(queueIndex).toBeGreaterThan(-1);

    const queueAppendOrder = indexTs.indexOf("mainContent.append(renderQueueSection");
    const rightColumnAppendOrder = indexTs.indexOf("mainContent.append(rightColumn)");
    expect(queueAppendOrder).toBeGreaterThan(-1);
    expect(rightColumnAppendOrder).toBeGreaterThan(-1);
    expect(queueAppendOrder).toBeLessThan(rightColumnAppendOrder);
  });

  test("Open tabs is appended into the right column directly above Recently closed", async () => {
    const indexTs = await read("index.ts");
    const openTabsIndex = indexTs.indexOf("renderOpenTabsPanel");
    const closedIndex = indexTs.indexOf("renderRecentlyClosedPanel");
    expect(openTabsIndex).toBeGreaterThan(-1);
    expect(closedIndex).toBeGreaterThan(-1);

    const openTabsAppendOrder = indexTs.indexOf("rightColumn.append(renderOpenTabsPanel");
    const closedAppendOrder = indexTs.indexOf("rightColumn.append(renderRecentlyClosedPanel");
    expect(openTabsAppendOrder).toBeGreaterThan(-1);
    expect(closedAppendOrder).toBeGreaterThan(-1);
    expect(openTabsAppendOrder).toBeLessThan(closedAppendOrder);
  });

  test("no full-width Open tabs panel is appended directly to the page between the banners and the split", async () => {
    const indexTs = await read("index.ts");
    expect(indexTs.indexOf("app.append(renderOpenTabsPanel")).toBe(-1);
  });
});
