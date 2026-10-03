import { describe, expect, test } from "vitest";
import { normalize, SITE_RULES } from "./normalize";

describe("normalize", () => {
  test("lowercases the scheme and host", () => {
    expect(normalize("HTTPS://EXAMPLE.COM/path")).toBe("https://example.com/path");
  });

  test("preserves path case", () => {
    expect(normalize("https://example.com/FooBar")).toBe("https://example.com/FooBar");
  });

  test("drops the fragment", () => {
    expect(normalize("https://example.com/path#section")).toBe("https://example.com/path");
  });

  test("drops utm_source and utm_campaign", () => {
    expect(normalize("https://example.com/?utm_source=a&utm_campaign=b&x=1")).toBe(
      "https://example.com?x=1",
    );
  });

  test("drops fbclid and gclid", () => {
    expect(normalize("https://example.com/?fbclid=abc&gclid=def&x=1")).toBe(
      "https://example.com?x=1",
    );
  });

  test("sorts the remaining query parameters by key, preserving their values", () => {
    expect(normalize("https://example.com/?b=foo&a=bar")).toBe("https://example.com?a=bar&b=foo");
  });

  test("sorts stably, keeping repeated keys in their original relative order", () => {
    expect(normalize("https://example.com/?a=1&b=2&a=3")).toBe("https://example.com?a=1&a=3&b=2");
  });

  test("drops a trailing slash from the path", () => {
    expect(normalize("https://example.com/foo/")).toBe("https://example.com/foo");
  });

  test("normalizes the root with and without a trailing slash to the same value", () => {
    expect(normalize("https://example.com/")).toBe(normalize("https://example.com"));
  });

  test("leaves no dangling ? when the query becomes empty", () => {
    expect(normalize("https://example.com/?utm_source=a")).toBe("https://example.com");
  });

  test("returns unparseable input unchanged without throwing", () => {
    expect(() => normalize("not a url")).not.toThrow();
    expect(normalize("not a url")).toBe("not a url");
  });

  describe("GitHub issue and PR URLs", () => {
    test("normalizes an issue URL with a /files sub-path, a query and a comment anchor", () => {
      expect(
        normalize("https://github.com/acme/widgets/issues/42/files?x=1#issuecomment-123"),
      ).toBe("https://github.com/acme/widgets/issues/42");
    });

    test("normalizes a PR URL with a /commits/<sha> sub-path, a query and a comment anchor", () => {
      expect(
        normalize(
          "https://github.com/acme/widgets/pull/7/commits/abc123def?x=1#issuecomment-456",
        ),
      ).toBe("https://github.com/acme/widgets/pull/7");
    });

    test("normalizes a bare issue URL", () => {
      expect(normalize("https://github.com/acme/widgets/issues/1")).toBe(
        "https://github.com/acme/widgets/issues/1",
      );
    });

    test("normalizes a bare PR URL", () => {
      expect(normalize("https://github.com/acme/widgets/pull/1")).toBe(
        "https://github.com/acme/widgets/pull/1",
      );
    });

    test("applies only the default rules to a non-issue GitHub URL", () => {
      expect(normalize("https://github.com/acme/widgets/tree/main/src#readme")).toBe(
        "https://github.com/acme/widgets/tree/main/src",
      );
    });
  });

  test("SITE_RULES is an exported array containing the GitHub rule, consulted before the default rules", () => {
    expect(Array.isArray(SITE_RULES)).toBe(true);
    expect(SITE_RULES.length).toBeGreaterThan(0);

    const url = new URL("https://github.com/acme/widgets/issues/42/files?x=1#issuecomment-123");
    const matching = SITE_RULES.find((rule) => rule.match(url));
    expect(matching).toBeDefined();
    expect(matching!.normalize(url)).toBe("https://github.com/acme/widgets/issues/42");
  });
});
