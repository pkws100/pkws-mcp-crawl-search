import { z } from "zod";
import type { AppConfig } from "../config.js";
import { clampNumber } from "../util/limits.js";
import { type InferredUrlType, inferredUrlTypeValues } from "../util/quality.js";
import type { LookupFn } from "../util/ssrfGuard.js";
import { inspectSitemap } from "../util/sitemap.js";
import { shouldIncludeUrl } from "../util/urlFilter.js";
import { executeFetchDocumentText } from "./fetchDocumentText.js";
import { executeFetchUrlChunks } from "./fetchUrlChunks.js";
import { executeFetchUrlMarkdown } from "./fetchUrlMarkdown.js";
import { fetchPageSnapshot } from "./fetchUrlText.js";

const chunkSchema = z.object({
  chunk_id: z.string(),
  heading_path: z.array(z.string()),
  text: z.string()
});

export const crawlSitemapTargetsInputSchema = z.object({
  sitemap_url: z.string().url(),
  include_patterns: z.array(z.string().min(1).max(200)).optional(),
  exclude_patterns: z.array(z.string().min(1).max(200)).optional(),
  url_type: z.enum(inferredUrlTypeValues).optional(),
  sort_by: z.enum(["lastmod_desc", "lastmod_asc", "path"]).default("lastmod_desc"),
  limit: z.number().int().min(1).max(50).default(20),
  fetch_mode: z.enum(["text", "markdown", "chunks"]).default("markdown"),
  max_chars_per_page: z.number().int().min(1).max(20_000).default(12_000),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(15_000)
});

export const crawlSitemapTargetsResultSchema = z.object({
  selected_urls: z.array(z.string().url()),
  pages: z.array(
    z.object({
      url: z.string().url(),
      title: z.string().optional(),
      status: z.number().int().nonnegative(),
      mode: z.enum(["text", "markdown", "chunks"]),
      content: z.union([z.string(), z.array(chunkSchema)])
    })
  ),
  stats: z.object({
    selected: z.number().int().nonnegative(),
    fetched: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative()
  })
});

export type CrawlSitemapTargetsInput = z.infer<typeof crawlSitemapTargetsInputSchema>;
export type CrawlSitemapTargetsResult = z.infer<typeof crawlSitemapTargetsResultSchema>;

function sortEntries(
  entries: Array<{ url: string; lastmod?: string; inferred_type: InferredUrlType }>,
  sortBy: CrawlSitemapTargetsInput["sort_by"]
) {
  const toTimestamp = (value?: string) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  return [...entries].sort((a, b) => {
    if (sortBy === "path") {
      return a.url.localeCompare(b.url);
    }

    const delta = toTimestamp(a.lastmod) - toTimestamp(b.lastmod);
    if (delta === 0) {
      return a.url.localeCompare(b.url);
    }

    return sortBy === "lastmod_asc" ? delta : -delta;
  });
}

function shouldUseDocumentFetch(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

export async function executeCrawlSitemapTargets(
  input: CrawlSitemapTargetsInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<CrawlSitemapTargetsResult> {
  const limit = clampNumber(input.limit, 1, 50);
  const maxChars = clampNumber(input.max_chars_per_page, 1, config.maxCharsPerPage);

  const sitemap = await inspectSitemap(
    {
      url: input.sitemap_url,
      follow_indexes: true,
      max_sitemaps: 20,
      max_urls: Math.max(limit * 25, 500),
      same_domain_only: true
    },
    config,
    options
  );

  const filtered = sortEntries(
    sitemap.entries.filter((entry) => {
      if (input.url_type && entry.inferred_type !== input.url_type) {
        return false;
      }

      return shouldIncludeUrl(entry.url, {
        includePatterns: input.include_patterns,
        excludePatterns: input.exclude_patterns
      }).allowed;
    }),
    input.sort_by
  ).slice(0, limit);

  const selectedUrls = filtered.map((entry) => entry.url);
  const pages: CrawlSitemapTargetsResult["pages"] = [];
  const seenCanonical = new Set<string>();
  let skipped = 0;
  let errors = 0;

  for (const targetUrl of selectedUrls) {
    try {
      if (input.fetch_mode === "chunks") {
        const result = await executeFetchUrlChunks(
          {
            url: targetUrl,
            chunk_size: 1_200,
            overlap: 150,
            max_chunks: 20,
            strategy: "heading",
            rendered: false,
            timeout_ms: input.timeout_ms
          },
          config,
          options
        );

        const canonical = result.metadata.canonical_url ?? result.final_url;
        if (seenCanonical.has(canonical)) {
          skipped += 1;
          continue;
        }
        seenCanonical.add(canonical);

        pages.push({
          url: result.final_url,
          title: result.title,
          status: result.status,
          mode: "chunks",
          content: result.chunks.map((chunk) => ({
            chunk_id: chunk.chunk_id,
            heading_path: chunk.heading_path,
            text: chunk.text
          }))
        });
        continue;
      }

      if (input.fetch_mode === "markdown" && !shouldUseDocumentFetch(targetUrl)) {
        const result = await executeFetchUrlMarkdown(
          {
            url: targetUrl,
            max_chars: maxChars,
            timeout_ms: input.timeout_ms,
            include_links: true
          },
          config,
          options
        );

        const canonical = result.metadata.canonical_url ?? result.final_url;
        if (seenCanonical.has(canonical)) {
          skipped += 1;
          continue;
        }
        seenCanonical.add(canonical);

        pages.push({
          url: result.final_url,
          title: result.title,
          status: result.status,
          mode: "markdown",
          content: result.markdown
        });
        continue;
      }

      if (shouldUseDocumentFetch(targetUrl)) {
        const result = await executeFetchDocumentText(
          {
            url: targetUrl,
            max_chars: maxChars,
            timeout_ms: input.timeout_ms
          },
          config,
          options
        );

        if (seenCanonical.has(result.final_url)) {
          skipped += 1;
          continue;
        }
        seenCanonical.add(result.final_url);

        pages.push({
          url: result.final_url,
          title: result.title,
          status: result.status,
          mode: "text",
          content: result.text
        });
        continue;
      }

      const snapshot = await fetchPageSnapshot(
        {
          url: targetUrl,
          max_chars: maxChars,
          timeout_ms: input.timeout_ms
        },
        config,
        options
      );

      const canonical = snapshot.extracted.metadata.canonical_url ?? snapshot.final_url;
      if (seenCanonical.has(canonical)) {
        skipped += 1;
        continue;
      }
      seenCanonical.add(canonical);

      pages.push({
        url: snapshot.final_url,
        title: snapshot.title,
        status: snapshot.status,
        mode: "text",
        content: snapshot.text
      });
    } catch {
      errors += 1;
    }
  }

  return crawlSitemapTargetsResultSchema.parse({
    selected_urls: selectedUrls,
    pages,
    stats: {
      selected: selectedUrls.length,
      fetched: pages.length,
      skipped,
      errors
    }
  });
}
