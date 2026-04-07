import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeSearchAndExtract } from "../src/tools/searchAndExtract.js";
import { scoreSearchCandidate, scoreSearchResultCandidate } from "../src/util/quality.js";

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

describe("quality helpers", () => {
  it("scores stronger guide-style matches above weak generic pages", () => {
    const weak = scoreSearchCandidate("search extract guide", {
      title: "General Page",
      url: "https://example.com/a",
      snippet: "background information"
    }).total;
    const strong = scoreSearchResultCandidate(
      "search extract guide",
      {
        title: "Search Extract Guide",
        url: "https://example.com/docs/guide",
        snippet: "A guide about search and extract"
      },
      "en"
    );

    expect(strong).toBeGreaterThan(weak);
  });
});

describe("executeSearchAndExtract", () => {
  it("reranks and extracts markdown for the best matching result", async () => {
    const base = "http://127.0.0.1";
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/search?")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Background Page",
                url: `${base}/short`,
                content: "Generic background text"
              },
              {
                title: "Developer Guide Search Extract",
                url: `${base}/guide`,
                content: "A guide about search and extract"
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url.endsWith("/guide")) {
        return new Response(
          `<!doctype html>
            <html lang="en">
              <head>
                <title>Developer Guide Search Extract</title>
                <meta name="description" content="A guide for extracting and searching content." />
              </head>
              <body>
                <main>
                  <h1>Developer Guide</h1>
                  <p>${"This guide explains search and extract. ".repeat(60)}</p>
                  <h2>Details</h2>
                  <p>${"More details here. ".repeat(60)}</p>
                  <a href="/short">Related page</a>
                </main>
              </body>
            </html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }

      if (url.endsWith("/short")) {
        return new Response(
          "<html><head><title>Short Note</title></head><body><main><h1>Short note</h1><p>Concise content.</p></main></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }

      return new Response("not found", { status: 404 });
    };

    const result = await executeSearchAndExtract(
      {
        query: "search extract guide",
        search_limit: 2,
        language: "en",
        time_range: "month",
        extract_mode: "markdown",
        per_result_max_chars: 4000
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }] as never
      }
    );

    expect(result.stats.searched).toBe(2);
    expect(result.results[0].url).toBe(`${base}/guide`);
    expect(result.results[0].quality?.relevance_score).toBeGreaterThan(0);
    expect(result.results[0].extraction?.mode).toBe("markdown");
    expect(typeof result.results[0].extraction?.content).toBe("string");
    expect(result.results[0].extraction?.content).toContain("# Developer Guide");
  });

  it("extracts chunks for long-form pages", async () => {
    const base = "http://127.0.0.1";
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/search?")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Long Reference Guide",
                url: `${base}/guide`,
                content: "reference guide and tutorial content " + "x".repeat(220)
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url.endsWith("/guide")) {
        return new Response(
          `<!doctype html>
            <html>
              <head><title>Long Reference Guide</title></head>
              <body>
                <main>
                  <h1>Long Reference Guide</h1>
                  <p>${"Chunk worthy content. ".repeat(200)}</p>
                  <h2>More</h2>
                  <p>${"Additional chunk content. ".repeat(180)}</p>
                </main>
              </body>
            </html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }

      return new Response("not found", { status: 404 });
    };

    const result = await executeSearchAndExtract(
      {
        query: "long reference guide",
        search_limit: 1,
        language: "en",
        time_range: "month",
        extract_mode: "chunks",
        per_result_max_chars: 6000
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }] as never
      }
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].extraction?.mode).toBe("chunks");
    expect(Array.isArray(result.results[0].extraction?.content)).toBe(true);
    expect((result.results[0].extraction?.content as Array<{ text: string }>).length).toBeGreaterThan(1);
  });
});
