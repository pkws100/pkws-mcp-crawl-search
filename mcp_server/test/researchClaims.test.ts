import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeResearchClaims } from "../src/tools/researchClaims.js";

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

describe("executeResearchClaims", () => {
  it("builds claims with support and contradictions from multiple sources", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "https://docs.example.com/release") {
        return new Response(
          `<!doctype html><html><head><title>Release Notes</title></head><body><main>
            <h1>Release Notes</h1>
            <p>Widget 3 launches on 15 May 2026 for all customers.</p>
            <p>The rollout starts globally on 15 May 2026.</p>
          </main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://support.example.com/announcement") {
        return new Response(
          `<!doctype html><html><head><title>Announcement</title></head><body><main>
            <h1>Announcement</h1>
            <p>Widget 3 launches on 15 May 2026 for all customers.</p>
          </main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://community.example.net/thread") {
        return new Response(
          `<!doctype html><html><head><title>Forum Thread</title></head><body><main>
            <h1>Forum Thread</h1>
            <p>Some users believe Widget 3 launches on 20 May 2026 instead.</p>
          </main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await executeResearchClaims(
      {
        query: "widget 3 launch date",
        source_urls: [
          "https://docs.example.com/release",
          "https://support.example.com/announcement",
          "https://community.example.net/thread"
        ],
        max_claims: 5
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims.some((claim) => claim.support.length >= 2)).toBe(true);
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.coverage.conflicting).toBeGreaterThan(0);
  });
});
