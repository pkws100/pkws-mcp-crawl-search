import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeDeepResearch } from "../src/tools/deepResearch.js";

const config: AppConfig = {
  mcpPort: 8789,
  mcpBind: "127.0.0.1",
  searxngBase: "http://searxng:8080",
  mcpAuthToken: undefined,
  blockPrivateNet: true,
  allowPrivateNet: false,
  maxHtmlBytes: 2_000_000,
  maxPageCount: 50,
  maxDepth: 3,
  maxCharsPerPage: 20_000,
  maxToolTimeoutMs: 30_000,
  maxRedirects: 5,
  robotsMaxBytes: 100_000,
  defaultUserAgent: "pkws-test/1.0"
};

describe("executeDeepResearch", () => {
  it("builds a trust-aware research result and deepens official sources via sitemap", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/search?")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Widget Release Notes",
                url: "https://docs.example.com/overview",
                content: "Official widget release overview"
              },
              {
                title: "Forum speculation about widget release",
                url: "https://community.example.net/thread/widget-release",
                content: "Community speculation on the widget release date"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url === "https://docs.example.com/overview") {
        return new Response(
          `<!doctype html><html><head>
            <title>Widget Release Notes</title>
            <meta name="author" content="PKWS Docs">
            <link rel="canonical" href="https://docs.example.com/overview">
          </head><body><main>
            <h1>Widget Release Notes</h1>
            <p>Widget 3 launches on 15 May 2026 for all customers.</p>
          </main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://community.example.net/thread/widget-release") {
        return new Response(
          `<!doctype html><html><head><title>Forum Thread</title></head><body><main>
            <h1>Forum Thread</h1>
            <p>Some users believe Widget 3 launches on 20 May 2026 instead.</p>
          </main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://docs.example.com/sitemap.xml") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
            <urlset>
              <url><loc>https://docs.example.com/release-notes</loc><lastmod>2026-04-06</lastmod></url>
            </urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } }
        );
      }

      if (url === "https://docs.example.com/release-notes") {
        return new Response(
          `<!doctype html><html><head><title>Detailed Release Notes</title></head><body><main>
            <h1>Detailed Release Notes</h1>
            <p>Widget 3 launches on 15 May 2026 for all customers.</p>
            <p>The rollout starts globally on 15 May 2026.</p>
          </main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await executeDeepResearch(
      {
        query: "widget 3 release date",
        mode: "evidence_first",
        max_sources: 4,
        max_claims: 6,
        language: "en",
        time_range: "month",
        include_sitemaps: true,
        prefer_official_sources: true,
        allow_rendered: false
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        searchFetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.summary.answered).toBe(true);
    expect(result.sources.some((source) => source.extracted_via === "sitemap")).toBe(true);
    expect(result.sources[0].source_type).toBe("official");
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.stats.sitemap_sources_added).toBeGreaterThan(0);
  });
});
