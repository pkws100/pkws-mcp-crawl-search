import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeCrawlSitemapTargets } from "../src/tools/crawlSitemapTargets.js";

const config: AppConfig = {
  mcpPort: 8789,
  mcpBind: "127.0.0.1",
  searxngBase: "http://searxng:8080",
  mcpAuthToken: undefined,
  blockPrivateNet: true,
  allowPrivateNet: true,
  maxHtmlBytes: 2_000_000,
  maxPageCount: 50,
  maxDepth: 3,
  maxCharsPerPage: 20_000,
  maxToolTimeoutMs: 30_000,
  maxRedirects: 5,
  robotsMaxBytes: 100_000,
  defaultUserAgent: "pkws-test/1.0"
};

function response(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType
    }
  });
}

describe("executeCrawlSitemapTargets", () => {
  it("selects sitemap targets by inferred type and returns markdown pages", async () => {
    const base = "http://127.0.0.1";

    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/sitemap.xml")) {
        return response(
          `<?xml version="1.0" encoding="UTF-8"?>
            <sitemapindex>
              <sitemap><loc>${base}/sitemaps/docs.xml</loc></sitemap>
              <sitemap><loc>${base}/sitemaps/blog.xml</loc></sitemap>
            </sitemapindex>`,
          "application/xml"
        );
      }

      if (url.endsWith("/sitemaps/docs.xml")) {
        return response(
          `<?xml version="1.0" encoding="UTF-8"?>
            <urlset>
              <url><loc>${base}/docs/guide</loc><lastmod>2026-04-04</lastmod></url>
              <url><loc>${base}/docs/reference</loc><lastmod>2026-04-05</lastmod></url>
            </urlset>`,
          "application/xml"
        );
      }

      if (url.endsWith("/sitemaps/blog.xml")) {
        return response(
          `<?xml version="1.0" encoding="UTF-8"?>
            <urlset>
              <url><loc>${base}/blog/post</loc><lastmod>2026-04-03</lastmod></url>
            </urlset>`,
          "application/xml"
        );
      }

      if (url.endsWith("/docs/guide")) {
        return response(
          `<!doctype html><html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>${"guide ".repeat(80)}</p></main></body></html>`,
          "text/html; charset=utf-8"
        );
      }

      if (url.endsWith("/docs/reference")) {
        return response(
          `<!doctype html><html><head><title>Reference</title></head><body><main><h1>Reference</h1><p>${"reference ".repeat(80)}</p></main></body></html>`,
          "text/html; charset=utf-8"
        );
      }

      if (url.endsWith("/blog/post")) {
        return response(
          `<!doctype html><html><head><title>Blog</title></head><body><main><h1>Blog</h1><p>blog post</p></main></body></html>`,
          "text/html; charset=utf-8"
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await executeCrawlSitemapTargets(
      {
        sitemap_url: `${base}/sitemap.xml`,
        url_type: "docs",
        sort_by: "lastmod_desc",
        limit: 2,
        fetch_mode: "markdown",
        max_chars_per_page: 4000,
        timeout_ms: 10000
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch
      }
    );

    expect(result.selected_urls).toEqual([`${base}/docs/reference`, `${base}/docs/guide`]);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].mode).toBe("markdown");
    expect(typeof result.pages[0].content).toBe("string");
    expect(result.pages[0].title).toBe("Reference");
    expect(result.stats).toEqual({
      selected: 2,
      fetched: 2,
      skipped: 0,
      errors: 0
    });
  });
});
