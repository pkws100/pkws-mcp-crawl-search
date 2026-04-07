import { createServer, type Server as HttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeInspectSitemap } from "../src/tools/inspectSitemap.js";

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

    if (path === "/sitemap.xml") {
      res.writeHead(302, { Location: "/root-sitemap.xml" });
      res.end();
      return;
    }

    if (path === "/root-sitemap.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>/nested-index.xml</loc></sitemap>
          <sitemap><loc>https://external.example.com/external-index.xml</loc></sitemap>
          <sitemap><loc>/direct-urlset.xml</loc></sitemap>
        </sitemapindex>
      `;
      const gz = gzipSync(Buffer.from(body, "utf8"));
      res.writeHead(200, {
        "content-type": "application/xml",
        "content-encoding": "gzip"
      });
      res.end(gz);
      return;
    }

    if (path === "/nested-index.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>/deep-urlset.xml</loc></sitemap>
        </sitemapindex>
      `;
      const gz = gzipSync(Buffer.from(body, "utf8"));
      res.writeHead(200, {
        "content-type": "application/xml",
        "content-encoding": "gzip"
      });
      res.end(gz);
      return;
    }

    if (path === "/direct-urlset.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/blog/launch</loc><lastmod>2026-04-01</lastmod></url>
          <url><loc>/privacy-policy</loc></url>
        </urlset>
      `);
      return;
    }

    if (path === "/deep-urlset.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/docs/intro</loc></url>
          <url><loc>/docs/reference</loc></url>
          <url><loc>/products/widget</loc></url>
          <url><loc>/category/tools</loc></url>
          <url><loc>/other/page</loc></url>
        </urlset>
      `);
      return;
    }

    if (path === "/huge-urlset.xml") {
      const filler = "x".repeat(20_000);
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>/docs/truncated</loc></url>
          <url><loc>/blog/truncated</loc></url>
          <url><loc>/product/truncated</loc></url>
        </urlset>
        <!-- ${filler} -->
      `);
      return;
    }

    res.writeHead(404);
    res.end("not found");
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

describe("executeInspectSitemap", () => {
  it("follows nested sitemap indexes, handles gzip and redirects, and groups url types", async () => {
    const baseUrl = await startSite();

    const result = await executeInspectSitemap(
      {
        sitemap_url: `${baseUrl}/sitemap.xml`,
        follow_indexes: true,
        max_depth: 3,
        max_sitemaps: 10,
        max_urls: 20,
        same_domain_only: true,
        timeout_ms: 10_000,
        max_xml_bytes: 200_000,
        sample_limit: 2
      },
      config
    );

    expect(result.source_url).toBe(`${baseUrl}/sitemap.xml`);
    expect(result.final_url).toBe(`${baseUrl}/root-sitemap.xml`);
    expect(result.sitemap_type).toBe("sitemapindex");
    expect(result.resolved_sitemaps).toEqual(
      expect.arrayContaining([
        `${baseUrl}/root-sitemap.xml`,
        `${baseUrl}/nested-index.xml`,
        `${baseUrl}/direct-urlset.xml`,
        `${baseUrl}/deep-urlset.xml`
      ])
    );
    expect(result.entries.map((entry) => entry.url)).toEqual(
      expect.arrayContaining([
        `${baseUrl}/docs/intro`,
        `${baseUrl}/docs/reference`,
        `${baseUrl}/blog/launch`,
        `${baseUrl}/products/widget`,
        `${baseUrl}/category/tools`,
        `${baseUrl}/privacy-policy`,
        `${baseUrl}/other/page`
      ])
    );
    expect(result.entries.some((entry) => entry.url.includes("external.example.com"))).toBe(false);
    expect(result.groups.find((group) => group.label === "docs")?.sample_urls).toEqual(
      expect.arrayContaining([`${baseUrl}/docs/intro`, `${baseUrl}/docs/reference`])
    );
    expect(result.groups.find((group) => group.label === "blog")?.sample_urls).toContain(`${baseUrl}/blog/launch`);
    expect(result.groups.find((group) => group.label === "product")?.sample_urls).toContain(`${baseUrl}/products/widget`);
    expect(result.groups.find((group) => group.label === "category")?.sample_urls).toContain(`${baseUrl}/category/tools`);
    expect(result.groups.find((group) => group.label === "policy")?.sample_urls).toContain(`${baseUrl}/privacy-policy`);
    expect(result.groups.find((group) => group.label === "other")?.sample_urls).toContain(`${baseUrl}/other/page`);
    expect(result.stats.nested_indexes_followed).toBeGreaterThanOrEqual(2);
    expect(result.stats.skipped_same_domain).toBeGreaterThanOrEqual(1);
    expect(result.stats.skipped_duplicates).toBeGreaterThanOrEqual(0);
    expect(result.stats.truncated).toBe(false);
  });

  it("marks truncation when the xml budget is exhausted", async () => {
    const baseUrl = await startSite();

    const result = await executeInspectSitemap(
      {
        url: `${baseUrl}/huge-urlset.xml`,
        follow_indexes: false,
        max_depth: 0,
        max_sitemaps: 2,
        max_urls: 10,
        same_domain_only: true,
        timeout_ms: 10_000,
        max_xml_bytes: 4096,
        sample_limit: 3
      },
      config
    );

    expect(result.stats.truncated).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.groups.some((group) => group.count > 0)).toBe(true);
  });
});
