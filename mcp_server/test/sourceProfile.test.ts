import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeSourceProfile } from "../src/tools/sourceProfile.js";

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

describe("executeSourceProfile", () => {
  it("profiles official documentation sources with trust signals", async () => {
    const fetchMock = async () =>
      new Response(
        `<!doctype html>
          <html lang="en">
            <head>
              <title>Developer Guide</title>
              <meta name="author" content="PKWS Docs">
              <meta property="article:published_time" content="2026-04-01T10:00:00Z">
              <link rel="canonical" href="https://docs.example.com/guide">
            </head>
            <body>
              <main>
                <h1>Developer Guide</h1>
                <p>${"Reliable guide content. ".repeat(80)}</p>
              </main>
            </body>
          </html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8"
          }
        }
      );

    const result = await executeSourceProfile(
      {
        url: "https://docs.example.com/guide",
        rendered: false
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.url).toBe("https://docs.example.com/guide");
    expect(result.title).toBe("Developer Guide");
    expect(result.source_type).toBe("official");
    expect(result.trust_score).toBeGreaterThanOrEqual(80);
    expect(result.signals).toMatchObject({
      official_domain: true,
      has_author: true,
      has_published_at: true,
      has_canonical: true
    });
    expect(result.quality?.content_quality_score).toBeGreaterThan(0);
    expect(result.notes.length).toBeGreaterThan(0);
  });
});
