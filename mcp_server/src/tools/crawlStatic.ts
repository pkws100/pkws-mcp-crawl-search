import robotsParserModule from "robots-parser";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { checkDuplicate, createDedupeState, type DedupeMode } from "../util/dedupe.js";
import { extractLinks } from "../util/htmlToText.js";
import { clampNumber, sleep } from "../util/limits.js";
import { computeContentQuality } from "../util/quality.js";
import type { LookupFn } from "../util/ssrfGuard.js";
import { normalizeUrlForCrawl, shouldIncludeUrl } from "../util/urlFilter.js";
import { fetchPageSnapshot } from "./fetchUrlText.js";

export const crawlStaticInputSchema = z.object({
  start_url: z.string().url(),
  max_pages: z.number().int().min(1).max(50).default(10),
  max_depth: z.number().int().min(0).max(3).default(1),
  same_domain_only: z.boolean().default(true),
  obey_robots: z.boolean().default(true),
  delay_ms: z.number().int().min(0).max(5_000).default(250),
  max_chars_per_page: z.number().int().min(1).max(20_000).default(8_000),
  include_patterns: z.array(z.string().min(1).max(200)).optional(),
  exclude_patterns: z.array(z.string().min(1).max(200)).optional(),
  exclude_paths: z.array(z.string().min(1).max(200)).optional(),
  exclude_query_params: z.array(z.string().min(1).max(100)).optional(),
  dedupe_mode: z.enum(["canonical", "content_hash", "canonical_and_hash", "none"]).default("canonical_and_hash")
});

export const crawlStaticResultSchema = z.object({
  pages: z.array(
    z.object({
      url: z.string().url(),
      status: z.number().int().nonnegative(),
      title: z.string().optional(),
      text: z.string(),
      links: z.array(z.string().url()),
      quality: z.object({
        content_quality_score: z.number().int().min(0).max(100),
        boilerplate_ratio: z.number().min(0).max(1).optional(),
        word_count: z.number().int().nonnegative()
      })
    })
  ),
  stats: z.object({
    start_url: z.string().url(),
    pages_fetched: z.number().int().nonnegative(),
    pages_visited: z.number().int().nonnegative(),
    max_depth_reached: z.number().int().nonnegative(),
    skipped_same_domain: z.number().int().nonnegative(),
    skipped_robots: z.number().int().nonnegative(),
    duplicates_skipped: z.number().int().nonnegative(),
    filtered_skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative()
  })
});

export type CrawlStaticInput = z.infer<typeof crawlStaticInputSchema>;
export type CrawlStaticResult = z.infer<typeof crawlStaticResultSchema>;

type RobotsPolicy = {
  isAllowed(url: string, ua?: string): boolean | undefined;
};

const robotsParser = robotsParserModule as unknown as (url: string, robotstxt: string) => RobotsPolicy;

async function getRobotsPolicy(
  origin: string,
  config: AppConfig,
  cache: Map<string, RobotsPolicy>,
  fetchImpl: typeof fetch,
  lookupFn?: LookupFn
): Promise<RobotsPolicy> {
  const cached = cache.get(origin);
  if (cached) {
    return cached;
  }

  const robotsUrl = new URL("/robots.txt", origin).toString();

  try {
    const response = await fetchPageSnapshot(
      {
        url: robotsUrl,
        max_chars: config.robotsMaxBytes,
        timeout_ms: 10_000,
        user_agent: config.defaultUserAgent
      },
      config,
      { fetchImpl, lookupFn, maxBytes: config.robotsMaxBytes }
    );
    const parser = robotsParser(robotsUrl, response.html);
    cache.set(origin, parser);
    return parser;
  } catch {
    const parser = robotsParser(robotsUrl, "");
    cache.set(origin, parser);
    return parser;
  }
}

export async function executeCrawlStatic(
  input: CrawlStaticInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<CrawlStaticResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const lookupFn = options?.lookupFn;
  const maxPages = clampNumber(input.max_pages, 1, config.maxPageCount);
  const maxDepth = clampNumber(input.max_depth, 0, config.maxDepth);
  const maxCharsPerPage = clampNumber(input.max_chars_per_page, 1, config.maxCharsPerPage);
  const filterOptions = {
    includePatterns: input.include_patterns,
    excludePatterns: input.exclude_patterns,
    excludePaths: input.exclude_paths,
    excludeQueryParams: input.exclude_query_params,
    sameDomainOnly: input.same_domain_only,
    startUrl: input.start_url
  };
  const startUrl = normalizeUrlForCrawl(input.start_url, filterOptions).normalizedUrl;
  const startHost = new URL(startUrl).hostname;
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const seen = new Set<string>([startUrl]);
  const pages: CrawlStaticResult["pages"] = [];
  const robotsCache = new Map<string, RobotsPolicy>();
  const lastRequestAt = new Map<string, number>();
  const dedupe = createDedupeState(input.dedupe_mode as DedupeMode);

  let pagesVisited = 0;
  let skippedSameDomain = 0;
  let skippedRobots = 0;
  let duplicatesSkipped = 0;
  let filteredSkipped = 0;
  let errors = 0;
  let maxDepthReached = 0;
  const startedAt = Date.now();

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift();
    if (!next) {
      break;
    }

    pagesVisited += 1;
    maxDepthReached = Math.max(maxDepthReached, next.depth);
    const pageUrl = new URL(next.url);

    if (input.same_domain_only && pageUrl.hostname !== startHost) {
      skippedSameDomain += 1;
      continue;
    }

    if (!shouldIncludeUrl(next.url, filterOptions).allowed) {
      filteredSkipped += 1;
      continue;
    }

    if (input.obey_robots) {
      const parser = await getRobotsPolicy(pageUrl.origin, config, robotsCache, fetchImpl, lookupFn);
      if (!parser.isAllowed(next.url, config.defaultUserAgent)) {
        skippedRobots += 1;
        continue;
      }
    }

    const now = Date.now();
    const waitUntil = (lastRequestAt.get(pageUrl.host) ?? 0) + input.delay_ms;
    if (waitUntil > now) {
      await sleep(waitUntil - now);
    }
    lastRequestAt.set(pageUrl.host, Date.now());

    try {
      const snapshot = await fetchPageSnapshot(
        {
          url: next.url,
          max_chars: maxCharsPerPage,
          timeout_ms: 15_000,
          user_agent: config.defaultUserAgent
        },
        config,
        { fetchImpl, lookupFn }
      );

      const duplicateDecision = checkDuplicate(
        {
          url: snapshot.final_url,
          canonicalUrl: snapshot.extracted.metadata.canonical_url,
          contentHash: snapshot.extracted.content_hash
        },
        dedupe
      );
      if (duplicateDecision.duplicate) {
        duplicatesSkipped += 1;
        continue;
      }

      const links = extractLinks(snapshot.html, snapshot.final_url);
      pages.push({
        url: snapshot.final_url,
        status: snapshot.status,
        title: snapshot.title,
        text: snapshot.text,
        links,
        quality: computeContentQuality(snapshot.extracted)
      });

      if (next.depth >= maxDepth) {
        continue;
      }

      for (const link of links) {
        const normalized = normalizeUrlForCrawl(link, filterOptions).normalizedUrl;
        if (seen.has(normalized)) {
          continue;
        }

        if (input.same_domain_only && new URL(normalized).hostname !== startHost) {
          skippedSameDomain += 1;
          continue;
        }

        if (!shouldIncludeUrl(normalized, filterOptions).allowed) {
          filteredSkipped += 1;
          continue;
        }

        seen.add(normalized);
        queue.push({ url: normalized, depth: next.depth + 1 });
      }
    } catch {
      errors += 1;
    }
  }

  return crawlStaticResultSchema.parse({
    pages,
    stats: {
      start_url: startUrl,
      pages_fetched: pages.length,
      pages_visited: pagesVisited,
      max_depth_reached: maxDepthReached,
      skipped_same_domain: skippedSameDomain,
      skipped_robots: skippedRobots,
      duplicates_skipped: duplicatesSkipped,
      filtered_skipped: filteredSkipped,
      errors,
      duration_ms: Date.now() - startedAt
    }
  });
}
