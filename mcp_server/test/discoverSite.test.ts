import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeDiscoverSite } from "../src/tools/discoverSite.js";

const servers: HttpServer[] = [];

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

async function startSite(): Promise<string> {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";

    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /blocked\nSitemap: /sitemap.xml\n");
      return;
    }

    if (path === "/blog") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Blog</title></head><body><main><h1>Blog</h1></main></body></html>");
      return;
    }

    if (path === "/blocked") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Blocked</title></head><body><main><h1>Blocked</h1></main></body></html>");
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end(`
      <html>
        <head>
          <title>Home</title>
          <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
        </head>
        <body>
          <nav><a href="/blog">Blog</a><a href="/blocked">Blocked</a><a href="/login">Login</a></nav>
          <form action="/search"><input type="search" /></form>
          <main><h1>Home</h1><p>Welcome home.</p></main>
        </body>
      </html>
    `);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) {
      continue;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

describe("executeDiscoverSite", () => {
  it("discovers navigation, sitemaps, rss, login and search signals", async () => {
    const baseUrl = await startSite();
    const result = await executeDiscoverSite(
      {
        start_url: baseUrl,
        max_pages: 5,
        same_domain_only: true,
        include_sitemaps: true,
        obey_robots: true,
        delay_ms: 0
      },
      config
    );

    expect(result.sitemaps).toContain(`${baseUrl}/sitemap.xml`);
    expect(result.rss).toContain(`${baseUrl}/feed.xml`);
    expect(result.navigation_links).toContain(`${baseUrl}/blog`);
    expect(result.login_detected).toBe(true);
    expect(result.search_detected).toBe(true);
    expect(result.important_pages.some((page) => page.url === `${baseUrl}/blog`)).toBe(true);
    expect(result.important_pages.some((page) => page.url === `${baseUrl}/blocked`)).toBe(false);
  });
});
