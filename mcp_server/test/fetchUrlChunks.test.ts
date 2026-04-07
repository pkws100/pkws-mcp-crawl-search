import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeFetchUrlChunks } from "../src/tools/fetchUrlChunks.js";

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

describe("executeFetchUrlChunks", () => {
  it("builds heading-based chunks with stable metadata", async () => {
    const fetchMock = async () =>
      new Response(
        `
          <html>
            <head><title>Chunked</title></head>
            <body>
              <main>
                <h1>Intro</h1>
                <p>${"intro ".repeat(60)}</p>
                <h2>Details</h2>
                <p>${"details ".repeat(80)}</p>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "content-type": "text/html"
          }
        }
      );

    const result = await executeFetchUrlChunks(
      {
        url: "http://127.0.0.1/chunked",
        chunk_size: 300,
        overlap: 50,
        max_chunks: 10,
        strategy: "heading",
        rendered: false,
        timeout_ms: 10_000
      },
      config,
      { fetchImpl: fetchMock as typeof fetch }
    );

    expect(result.title).toBe("Chunked");
    expect(result.metadata.content_hash).toHaveLength(64);
    expect(result.quality.content_quality_score).toBeGreaterThan(0);
    expect(result.quality.word_count).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks[0].chunk_id).toBe("chunk-1");
    expect(result.chunks.some((chunk) => chunk.heading_path.includes("Details"))).toBe(true);
  });
});
