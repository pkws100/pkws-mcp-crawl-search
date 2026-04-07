import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeResolveBusinessWebsite } from "../src/tools/resolveBusinessWebsite.js";

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

describe("executeResolveBusinessWebsite", () => {
  it("prefers the likely official website over directory candidates", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "https://www.gelbeseiten.de/salon-alpha-sonneberg") {
        return new Response(
          `<!doctype html><html><head><title>Salon Alpha in Sonneberg - Gelbe Seiten</title></head><body><main><h1>Salon Alpha in Sonneberg</h1></main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://salon-alpha.de/") {
        return new Response(
          `<!doctype html><html><head><title>Salon Alpha | Friseur in Sonneberg</title><meta name="author" content="Salon Alpha"></head><body><main><h1>Salon Alpha</h1><p>Ihr Friseur in Sonneberg.</p></main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await executeResolveBusinessWebsite(
      {
        name: "Salon Alpha",
        location: "Sonneberg",
        postal_code: "96515",
        category: "Friseur",
        candidate_urls: ["https://www.gelbeseiten.de/salon-alpha-sonneberg", "https://salon-alpha.de/"]
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.best_website).toBe("https://salon-alpha.de/");
    expect(result.confidence).toBeGreaterThan(result.alternatives.length === 0 ? 20 : 0);
  });
});
