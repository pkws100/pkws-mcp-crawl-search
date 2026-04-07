import { describe, expect, it } from "vitest";
import { checkDuplicate, createDedupeState, isDuplicate } from "../src/util/dedupe.js";
import { normalizeUrlForCrawl, shouldIncludeUrl } from "../src/util/urlFilter.js";

describe("urlFilter", () => {
  it("strips excluded query params and keeps normalized url", () => {
    const result = normalizeUrlForCrawl("https://example.com/docs?a=1&utm_source=test#frag", {
      excludeQueryParams: ["utm_source"]
    });

    expect(result.normalizedUrl).toBe("https://example.com/docs?a=1");
    expect(result.strippedQueryParams).toEqual(["utm_source"]);
  });

  it("applies include/exclude and same-domain rules", () => {
    expect(
      shouldIncludeUrl("https://example.com/docs/guide", {
        includePatterns: ["docs"],
        startUrl: "https://example.com",
        sameDomainOnly: true
      }).allowed
    ).toBe(true);

    expect(
      shouldIncludeUrl("https://example.com/admin", {
        excludePaths: ["/admin"]
      }).allowed
    ).toBe(false);

    expect(
      shouldIncludeUrl("https://other.example.com/path", {
        startUrl: "https://example.com",
        sameDomainOnly: true
      }).allowed
    ).toBe(false);
  });
});

describe("dedupe", () => {
  it("detects duplicate canonical and content hash entries", () => {
    const canonicalState = createDedupeState("canonical");
    expect(
      checkDuplicate(
        {
          url: "https://example.com/post?id=1",
          canonicalUrl: "https://example.com/post"
        },
        canonicalState
      ).duplicate
    ).toBe(false);
    expect(
      isDuplicate(
        {
          url: "https://example.com/post?id=2",
          canonicalUrl: "https://example.com/post"
        },
        canonicalState
      )
    ).toBe(true);

    const hashState = createDedupeState("content_hash");
    expect(
      checkDuplicate(
        {
          url: "https://example.com/a",
          contentHash: "abc123"
        },
        hashState
      ).duplicate
    ).toBe(false);
    expect(
      isDuplicate(
        {
          url: "https://example.com/b",
          contentHash: "abc123"
        },
        hashState
      )
    ).toBe(true);
  });
});
