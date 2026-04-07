import { createServer, request, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/server.js";
import {
  closeSharedBrowser,
  executeCrawlRendered,
  normalizeCrawlRenderedInput
} from "../src/tools/crawlRendered.js";
import { executeCrawlStatic } from "../src/tools/crawlStatic.js";
import { executeFetchUrlText } from "../src/tools/fetchUrlText.js";

function testConfig(): AppConfig {
  return {
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
    defaultUserAgent: "pkws-test/1.0",
    webSearchTotalBudgetMs: 10_000,
    webSearchAttemptTimeoutMs: 3_000,
    webSearchMaxVariants: 4
  };
}

const PROTOCOL_VERSION = "2025-03-26";

async function startSite(): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";

    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /blocked\n");
      return;
    }

    if (path === "/a") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Page A</title></head><body><p>Alpha page text.</p></body></html>");
      return;
    }

    if (path === "/blocked") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Blocked</title></head><body>Should not be crawled.</body></html>");
      return;
    }

    if (path === "/rendered") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`
        <html>
          <head><title>Rendered</title></head>
          <body>
            <div id="status">Loading</div>
            <script>
              setTimeout(() => {
                document.getElementById('status').innerText = 'Loaded via JavaScript';
              }, 100);
            </script>
          </body>
        </html>
      `);
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end(`
      <html>
        <head><title>Home</title></head>
        <body>
          <main>Hello smoke test home page.</main>
          <a href="/a">Page A</a>
          <a href="/blocked">Blocked</a>
        </body>
      </html>
    `);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function startApp(config: AppConfig): Promise<{ server: HttpServer; baseUrl: string }> {
  const app = createHttpApp(config);
  const server = await new Promise<HttpServer>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function startSearx(): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query = url.searchParams.get("q") ?? "";

    if (query.includes("pow24.org")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            {
              title: "PoW24.org",
              url: "https://pow24.org/",
              content: `Treffer fuer ${query}`
            }
          ]
        })
      );
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function postMcp(baseUrl: string, body: unknown, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION
  };

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function readMcpPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  if (contentType.includes("application/json")) {
    return JSON.parse(raw);
  }

  if (contentType.includes("text/event-stream")) {
    const dataChunks = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter(Boolean);
    const lastChunk = dataChunks.at(-1);
    return lastChunk ? JSON.parse(lastChunk) : undefined;
  }

  return raw;
}

const servers: HttpServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) {
      continue;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

afterAll(async () => {
  await closeSharedBrowser();
});

describe("smoke", () => {
  it("fetches text and crawls static pages with robots support", async () => {
    const site = await startSite();
    servers.push(site.server);

    const fetchResult = await executeFetchUrlText(
      {
        url: site.baseUrl,
        max_chars: 50,
        timeout_ms: 10_000
      },
      testConfig()
    );

    expect(fetchResult.status).toBe(200);
    expect(fetchResult.title).toBe("Home");
    expect(fetchResult.text).toContain("Hello smoke test home page.");

    const crawlResult = await executeCrawlStatic(
      {
        start_url: site.baseUrl,
        max_pages: 5,
        max_depth: 1,
        same_domain_only: true,
        obey_robots: true,
        delay_ms: 0,
        max_chars_per_page: 200
      },
      testConfig()
    );

    expect(crawlResult.pages.length).toBeGreaterThanOrEqual(2);
    expect(crawlResult.pages.some((page) => page.title === "Page A")).toBe(true);
    expect(crawlResult.pages.some((page) => page.title === "Blocked")).toBe(false);
    expect(crawlResult.pages.every((page) => page.quality.content_quality_score >= 0)).toBe(true);
    expect(crawlResult.stats.skipped_robots).toBeGreaterThanOrEqual(1);
  });

  it("renders javascript-loaded content with playwright", async () => {
    const site = await startSite();
    servers.push(site.server);

    const result = await executeCrawlRendered(
      {
        url: `${site.baseUrl}/rendered`,
        wait_until: "domcontentloaded",
        wait_ms: 300,
        max_chars: 500,
        timeout_ms: 10_000
      },
      testConfig()
    );

    expect(result.status).toBe(200);
    expect(result.title).toBe("Rendered");
    expect(result.text).toContain("Loaded via JavaScript");
    expect(result.network.requests).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("accepts start_url as an alias for crawl_rendered and ignores crawl-only fields", async () => {
    const site = await startSite();
    servers.push(site.server);

    const normalized = normalizeCrawlRenderedInput(
      {
        start_url: `${site.baseUrl}/rendered`,
        max_pages: 5,
        max_depth: 2,
        same_domain_only: true,
        obey_robots: true,
        delay_ms: 250,
        max_chars_per_page: 1_000,
        wait_until: "domcontentloaded",
        wait_ms: 300,
        max_chars: 500,
        timeout_ms: 10_000
      }
    );

    expect(normalized.input.url).toBe(`${site.baseUrl}/rendered`);
    expect(normalized.normalized_start_url_alias).toBe(true);
    expect(normalized.ignored_crawl_fields).toEqual([
      "max_pages",
      "max_depth",
      "same_domain_only",
      "obey_robots",
      "delay_ms",
      "max_chars_per_page"
    ]);

    const result = await executeCrawlRendered(
      {
        start_url: `${site.baseUrl}/rendered`,
        max_pages: 5,
        wait_until: "domcontentloaded",
        wait_ms: 300,
        max_chars: 500,
        timeout_ms: 10_000
      },
      testConfig()
    );

    expect(result.status).toBe(200);
    expect(result.title).toBe("Rendered");
    expect(result.text).toContain("Loaded via JavaScript");
  }, 30_000);

  it("accepts crawl_rendered alias inputs over the MCP transport", async () => {
    const site = await startSite();
    servers.push(site.server);

    const appServer = await startApp(testConfig());
    servers.push(appServer.server);

    const initializeResponse = await postMcp(appServer.baseUrl, {
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "smoke-test",
          version: "1.0.0"
        }
      }
    });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initializedResponse = await postMcp(
      appServer.baseUrl,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {}
      },
      sessionId ?? undefined
    );
    expect(initializedResponse.status).toBe(202);

    const toolCallResponse = await postMcp(
      appServer.baseUrl,
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "crawl_rendered",
          arguments: {
            start_url: `${site.baseUrl}/rendered`,
            max_pages: 5,
            wait_until: "domcontentloaded",
            wait_ms: 300,
            max_chars: 500,
            timeout_ms: 10_000
          }
        }
      },
      sessionId ?? undefined
    );

    expect(toolCallResponse.status).toBe(200);
    const payload = await readMcpPayload(toolCallResponse) as {
      error?: { message?: string };
      result?: { structuredContent?: { title?: string; text?: string; status?: number } };
    };
    expect(payload.error).toBeUndefined();
    expect(payload.result?.structuredContent?.status).toBe(200);
    expect(payload.result?.structuredContent?.title).toBe("Rendered");
    expect(payload.result?.structuredContent?.text).toContain("Loaded via JavaScript");
  }, 30_000);

  it("enforces auth on health and mcp routes when configured", async () => {
    const config = testConfig();
    config.mcpAuthToken = "secret-token";
    const appServer = await startApp(config);
    servers.push(appServer.server);

    const healthUnauthorized = await fetch(`${appServer.baseUrl}/health`);
    expect(healthUnauthorized.status).toBe(401);

    const healthAuthorized = await fetch(`${appServer.baseUrl}/health`, {
      headers: {
        Authorization: "Bearer secret-token"
      }
    });
    expect(healthAuthorized.status).toBe(200);
    expect(await healthAuthorized.text()).toBe("ok");

    const mcpUnauthorized = await fetch(`${appServer.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    expect(mcpUnauthorized.status).toBe(401);
  });

  it("rejects unexpected host headers", async () => {
    const appServer = await startApp(testConfig());
    servers.push(appServer.server);

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${appServer.baseUrl}/health`, {
        method: "GET",
        headers: {
          Host: "evil.example"
        }
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(403);
  });

  it("allows lan-style ip host headers", async () => {
    const config = testConfig();
    config.mcpBind = "0.0.0.0";
    const appServer = await startApp(config);
    servers.push(appServer.server);

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${appServer.baseUrl}/health`, {
        method: "GET",
        headers: {
          Host: "192.168.1.50"
        }
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(200);
  });

  it("reuses the same MCP session for sequential web_search calls", async () => {
    const searx = await startSearx();
    servers.push(searx.server);

    const config = testConfig();
    config.searxngBase = searx.baseUrl;
    const appServer = await startApp(config);
    servers.push(appServer.server);

    const initializeResponse = await postMcp(appServer.baseUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "smoke-test",
          version: "1.0.0"
        }
      }
    });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initializedResponse = await postMcp(appServer.baseUrl, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }, sessionId ?? undefined);
    expect(initializedResponse.status).toBe(202);

    const firstSearchResponse = await postMcp(appServer.baseUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: {
          query: "was ist pow24.org",
          limit: 1,
          language: "de",
          time_range: "month"
        }
      }
    }, sessionId ?? undefined);
    expect(firstSearchResponse.status).toBe(200);
    const firstSearchPayload = await readMcpPayload(firstSearchResponse) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(firstSearchPayload.result?.content?.[0]?.text).toContain("PoW24.org");

    const secondSearchResponse = await postMcp(appServer.baseUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: {
          query: "pow24.org erfahrungen bewertungen",
          limit: 1,
          language: "de",
          time_range: "month"
        }
      }
    }, sessionId ?? undefined);
    expect(secondSearchResponse.status).toBe(200);
    const secondSearchPayload = await readMcpPayload(secondSearchResponse) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(secondSearchPayload.result?.content?.[0]?.text).toContain("pow24.org/");
  });
});
