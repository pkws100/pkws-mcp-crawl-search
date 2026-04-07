import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeFetchUrlMarkdown } from "../src/tools/fetchUrlMarkdown.js";

const config: AppConfig = {
  mcpPort: 8789,
  mcpBind: "0.0.0.0",
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

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
}

describe("executeFetchUrlMarkdown", () => {
  it("extracts markdown, metadata, headings and links", async () => {
    const fetchMock = async () =>
      htmlResponse(`<!doctype html>
        <html lang="de">
          <head>
            <title>Example Article</title>
            <meta name="description" content="Short description">
            <meta name="author" content="Ada Lovelace">
            <meta property="og:title" content="OG Example">
            <meta property="og:description" content="OG Description">
            <meta property="article:published_time" content="2024-05-01T10:00:00Z">
            <meta property="article:modified_time" content="2024-05-02T10:00:00Z">
            <link rel="canonical" href="https://example.com/article">
          </head>
          <body>
            <header>Top nav</header>
            <main>
              <article>
                <h1 id="intro">Intro</h1>
                <p>Hello <strong>world</strong> with <a href="/docs">docs</a>.</p>
                <h2>Details</h2>
                <ul>
                  <li>One</li>
                  <li>Two</li>
                </ul>
              </article>
            </main>
            <footer>Footer text</footer>
          </body>
        </html>`);

    const result = await executeFetchUrlMarkdown(
      {
        url: "https://example.com/article",
        max_chars: 4000,
        timeout_ms: 10000,
        include_links: true
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.title).toBe("Example Article");
    expect(result.markdown).toContain("# Intro");
    expect(result.markdown).toContain("[docs](https://example.com/docs)");
    expect(result.markdown).toContain("## Details");
    expect(result.markdown).toContain("- One");
    expect(result.markdown).toContain("- Two");
    expect(result.links).toEqual(["https://example.com/docs"]);
    expect(result.headings).toEqual([
      { level: 1, text: "Intro", id: "intro" },
      { level: 2, text: "Details", id: undefined }
    ]);
    expect(result.metadata).toMatchObject({
      canonical_url: "https://example.com/article",
      meta_description: "Short description",
      lang: "de",
      author: "Ada Lovelace",
      published_at: "2024-05-01T10:00:00Z",
      modified_at: "2024-05-02T10:00:00Z",
      og_title: "OG Example",
      og_description: "OG Description"
    });
    expect(result.metadata.content_hash).toHaveLength(64);
    expect(result.quality.content_quality_score).toBeGreaterThan(0);
    expect(result.quality.word_count).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("omits markdown links when include_links is false but keeps extracted links", async () => {
    const fetchMock = async () =>
      htmlResponse(`<!doctype html>
        <html>
          <head><title>Plain</title></head>
          <body>
            <main>
              <h1>Headline</h1>
              <p>Visit <a href="https://example.com/x">this page</a>.</p>
            </main>
          </body>
        </html>`);

    const result = await executeFetchUrlMarkdown(
      {
        url: "https://example.com/plain",
        max_chars: 4000,
        timeout_ms: 10000,
        include_links: false
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.markdown).toContain("Headline");
    expect(result.markdown).toContain("Visit this page.");
    expect(result.markdown).not.toContain("https://example.com/x");
    expect(result.links).toEqual(["https://example.com/x"]);
  });

  it("falls back to plain text for minimal html", async () => {
    const fetchMock = async () =>
      htmlResponse(`<!doctype html>
        <html>
          <head><title>Tiny</title></head>
          <body>   Just some text   </body>
        </html>`);

    const result = await executeFetchUrlMarkdown(
      {
        url: "https://example.com/tiny",
        max_chars: 50,
        timeout_ms: 10000,
        include_links: true
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.markdown).toContain("Just some text");
    expect(result.title).toBe("Tiny");
  });
});
