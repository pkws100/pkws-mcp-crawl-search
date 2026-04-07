import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWebSearch } from "../src/tools/webSearch.js";
import type { AppConfig } from "../src/config.js";
import type { LookupFn } from "../src/util/ssrfGuard.js";

const config: AppConfig = {
  mcpPort: 8789,
  mcpBind: "0.0.0.0",
  searxngBase: "http://searxng:8080",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeWebSearch", () => {
  it("normalizes and trims SearXNG results", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Result A",
              url: "https://example.com/a",
              content: "x".repeat(600)
            },
            {
              title: "Result B",
              url: "https://example.com/b",
              content: "short"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });

    const result = await executeWebSearch(
      {
        query: "test",
        limit: 1,
        language: "de",
        time_range: "month"
      },
      config,
      fetchMock as typeof fetch
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      title: "Result A",
      url: "https://example.com/a",
      snippet: "x".repeat(500)
    });
  });

  it("returns a diagnostic error when SearXNG answers with 403", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("disabled format", {
        status: 403,
        headers: { "content-type": "text/plain" }
      });
    });

    await expect(
      executeWebSearch(
        {
          query: "was ist pow24.org",
          limit: 5,
          language: "de",
          time_range: "month"
        },
        config,
        fetchMock as typeof fetch
      )
    ).rejects.toThrow(/JSON search format is disabled|bot-detection/i);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        "accept-language": "de,de;q=0.9,en;q=0.6",
        "user-agent": "pkws-test/1.0"
      })
    });
  });

  it("tries query variants when the primary search is empty", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString());
      const query = url.searchParams.get("q");

      if (query === "pow24.org Erfahrung") {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (query === "site:pow24.org Erfahrung") {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "POW24 Erfahrungen",
                url: "https://pow24.org/erfahrungen",
                content: "Erfahrungsberichte und Einordnung."
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await executeWebSearch(
      {
        query: "pow24.org Erfahrung",
        limit: 1,
        language: "de",
        time_range: "month"
      },
      config,
      fetchMock as typeof fetch
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        title: "POW24 Erfahrungen",
        url: "https://pow24.org/erfahrungen",
        snippet: "Erfahrungsberichte und Einordnung."
      }
    ]);
  });

  it("falls back to a direct domain fetch when search variants stay empty", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const target = input.toString();

      if (target.includes("/search?")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      expect(init?.headers).toMatchObject({
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": "pkws-test/1.0"
      });

      return new Response(
        "<html><head><title>POW24</title><meta name=\"description\" content=\"POW24 hilft Teams beim Energiemanagement.\"></head><body><main><h1>POW24</h1><p>POW24 hilft Teams beim Energiemanagement.</p></main></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        }
      );
    });
    const lookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

    const result = await executeWebSearch(
      {
        query: "pow24.org competitors",
        limit: 5,
        language: "de",
        time_range: "month"
      },
      config,
      fetchMock as typeof fetch,
      lookupFn
    );

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result).toEqual([
      {
        title: "POW24",
        url: "https://pow24.org/",
        snippet: "POW24 hilft Teams beim Energiemanagement."
      }
    ]);
  });

  it("respects the total search budget and returns without hanging", async () => {
    const budgetConfig: AppConfig = {
      ...config,
      webSearchTotalBudgetMs: 1_000,
      webSearchAttemptTimeoutMs: 500,
      webSearchMaxVariants: 2
    };
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });

      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const startedAt = Date.now();
    const result = await executeWebSearch(
      {
        query: "pow24.org market position",
        limit: 5,
        language: "de",
        time_range: "month"
      },
      budgetConfig,
      fetchMock as typeof fetch
    );

    expect(result).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1_300);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
