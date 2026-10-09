import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("favicon", () => {
  test("declares the Sluice icon as a static SVG favicon", async () => {
    const html = await read("index.html");
    const match = html.match(/<link\s+[^>]*rel=["']icon["'][^>]*>/i);
    if (!match) {
      throw new Error("no favicon <link> found in index.html");
    }
    const tag = match[0];
    expect(tag).toMatch(/type=["']image\/svg\+xml["']/);
    expect(tag).toMatch(/href=["']icon\.svg["']/);
  });
});
