import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeResearchSources } from "../src/tools/researchSources.js";

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

describe("executeResearchSources", () => {
  it("builds a trust-aware source pack and discovers sitemap candidates for official sources", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/search?")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Widget API Guide",
                url: "https://docs.example.com/guide",
                content: "Official guide for the widget api"
              },
              {
                title: "Forum discussion about widget api",
                url: "https://community.example.net/thread/widget-api",
                content: "Community impressions and guesses"
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url === "https://docs.example.com/guide") {
        return new Response(
          `<!doctype html>
            <html lang="en">
              <head>
                <title>Widget API Guide</title>
                <meta name="author" content="PKWS Docs">
                <link rel="canonical" href="https://docs.example.com/guide">
              </head>
              <body>
                <main>
                  <h1>Widget API Guide</h1>
                  <p>${"Official and detailed documentation. ".repeat(70)}</p>
                </main>
              </body>
            </html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://community.example.net/thread/widget-api") {
        return new Response(
          `<!doctype html>
            <html>
              <head><title>Forum Thread</title></head>
              <body>
                <main>
                  <h1>Forum Thread</h1>
                  <p>People are guessing how the widget API behaves.</p>
                </main>
              </body>
            </html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://docs.example.com/sitemap.xml") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
            <urlset>
              <url><loc>https://docs.example.com/guide</loc></url>
              <url><loc>https://docs.example.com/reference</loc></url>
            </urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await executeResearchSources(
      {
        query: "widget api",
        max_sources: 2,
        language: "en",
        time_range: "month",
        prefer_official_sources: true,
        include_sitemaps: true
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        searchFetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].url).toBe("https://docs.example.com/guide");
    expect(result.sources[0].source_type).toBe("official");
    expect(result.sources[0].trust_score).toBeGreaterThan(result.sources[1].trust_score);
    expect(result.sources[0].sitemap_candidates).toEqual(["https://docs.example.com/sitemap.xml"]);
    expect(result.stats.returned).toBe(2);
  });
});
