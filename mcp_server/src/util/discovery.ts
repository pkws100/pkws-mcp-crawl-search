import * as cheerio from "cheerio";
import robotsParserModule from "robots-parser";
import type { AppConfig } from "../config.js";
import { fetchPageSnapshot } from "../tools/fetchUrlText.js";
import { clampNumber, sleep } from "./limits.js";
import type { LookupFn } from "./ssrfGuard.js";
import { normalizeUrlForCrawl, shouldIncludeUrl } from "./urlFilter.js";

export interface DiscoveryInput {
  start_url: string;
  max_pages: number;
  same_domain_only: boolean;
  include_sitemaps: boolean;
  obey_robots: boolean;
  delay_ms: number;
}

export interface DiscoveryResult {
  important_pages: Array<{ url: string; title?: string; reason: "nav" | "sitemap" | "rss" | "content" }>;
  navigation_links: string[];
  sitemaps: string[];
  rss: string[];
  login_detected: boolean;
  search_detected: boolean;
  stats: {
    pages_scanned: number;
    pages_queued: number;
    duration_ms: number;
  };
}

type RobotsPolicy = {
  isAllowed(url: string, ua?: string): boolean | undefined;
};

const robotsParser = robotsParserModule as unknown as (url: string, robotstxt: string) => RobotsPolicy;

function parseRobotsHints(robotsText: string, baseUrl: string): { sitemaps: string[] } {
  const sitemaps = robotsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^sitemap:/i.test(line))
    .map((line) => line.replace(/^sitemap:\s*/i, ""))
    .map((value) => {
      try {
        return new URL(value, baseUrl).toString();
      } catch {
        return value;
      }
    });

  return { sitemaps };
}

function collectNavigationLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links = new Set<string>();

  $("nav a[href], header a[href], [role='navigation'] a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }
    try {
      const resolved = new URL(href, baseUrl);
      resolved.hash = "";
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        links.add(resolved.toString());
      }
    } catch {
      // ignore invalid nav links
    }
  });

  return [...links];
}

function detectSignals(html: string): { rss: string[]; login: boolean; search: boolean } {
  const $ = cheerio.load(html);
  const rss = $("link[rel='alternate'][type*='rss'], link[rel='alternate'][type*='atom']")
    .toArray()
    .map((element) => $(element).attr("href"))
    .filter((value): value is string => Boolean(value));

  const login =
    $("input[type='password']").length > 0 ||
    /login|sign in|anmelden|konto|account/i.test($.text());

  const search =
    $("input[type='search']").length > 0 ||
    $("form[action*='search' i]").length > 0 ||
    /search|suche/i.test($.text());

  return { rss, login, search };
}

function importantReason(url: string): "nav" | "sitemap" | "rss" | "content" {
  if (/feed|rss|atom/i.test(url)) {
    return "rss";
  }
  if (/sitemap/i.test(url)) {
    return "sitemap";
  }
  if (/(docs|guide|about|blog|search|login|account)/i.test(url)) {
    return "nav";
  }
  return "content";
}

export async function executeDiscovery(
  input: DiscoveryInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<DiscoveryResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const lookupFn = options?.lookupFn;
  const maxPages = clampNumber(input.max_pages, 1, 50);
  const startedAt = Date.now();
  const filterOptions = {
    sameDomainOnly: input.same_domain_only,
    startUrl: input.start_url
  };
  const startUrl = normalizeUrlForCrawl(input.start_url).normalizedUrl;
  const startHost = new URL(startUrl).hostname;
  const queue = [startUrl];
  const seen = new Set<string>([startUrl]);
  const important = new Map<string, { url: string; title?: string; reason: "nav" | "sitemap" | "rss" | "content"; score: number }>();
  const navigation = new Set<string>();
  const sitemaps = new Set<string>();
  const rss = new Set<string>();
  const robotsCache = new Map<string, RobotsPolicy>();
  let pagesScanned = 0;
  let loginDetected = false;
  let searchDetected = false;

  if (input.include_sitemaps) {
    try {
      const robotsSnapshot = await fetchPageSnapshot(
        {
          url: new URL("/robots.txt", startUrl).toString(),
          max_chars: config.robotsMaxBytes,
          timeout_ms: 10_000,
          user_agent: config.defaultUserAgent
        },
        config,
        { fetchImpl, lookupFn, maxBytes: config.robotsMaxBytes }
      );

      for (const sitemap of parseRobotsHints(robotsSnapshot.html, startUrl).sitemaps) {
        sitemaps.add(sitemap);
        important.set(sitemap, { url: sitemap, reason: "sitemap", score: 200 });
      }
    } catch {
      // ignore robots discovery failures
    }
  }

  const getRobotsPolicy = async (origin: string): Promise<RobotsPolicy> => {
    const cached = robotsCache.get(origin);
    if (cached) {
      return cached;
    }

    const robotsUrl = new URL("/robots.txt", origin).toString();
    try {
      const snapshot = await fetchPageSnapshot(
        {
          url: robotsUrl,
          max_chars: config.robotsMaxBytes,
          timeout_ms: 10_000,
          user_agent: config.defaultUserAgent
        },
        config,
        { fetchImpl, lookupFn, maxBytes: config.robotsMaxBytes }
      );
      const parser = robotsParser(robotsUrl, snapshot.html);
      robotsCache.set(origin, parser);
      return parser;
    } catch {
      const parser = robotsParser(robotsUrl, "");
      robotsCache.set(origin, parser);
      return parser;
    }
  };

  while (queue.length > 0 && pagesScanned < maxPages) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    pagesScanned += 1;
    if (input.delay_ms > 0) {
      await sleep(input.delay_ms);
    }

    try {
      if (input.obey_robots) {
        const parser = await getRobotsPolicy(new URL(current).origin);
        if (!parser.isAllowed(current, config.defaultUserAgent)) {
          continue;
        }
      }

      const snapshot = await fetchPageSnapshot(
        {
          url: current,
          max_chars: config.maxCharsPerPage,
          timeout_ms: 15_000,
          user_agent: config.defaultUserAgent
        },
        config,
        { fetchImpl, lookupFn }
      );

      const navLinks = collectNavigationLinks(snapshot.html, snapshot.final_url);
      for (const link of navLinks) {
        if (input.obey_robots) {
          const parser = await getRobotsPolicy(new URL(link).origin);
          if (!parser.isAllowed(link, config.defaultUserAgent)) {
            continue;
          }
        }
        navigation.add(link);
        const existing = important.get(link);
        if (existing) {
          existing.score += 40;
        } else {
          important.set(link, { url: link, reason: "nav", score: 120 });
        }
      }

      const signals = detectSignals(snapshot.html);
      loginDetected ||= signals.login;
      searchDetected ||= signals.search;

      for (const feedHref of signals.rss) {
        try {
          const resolved = new URL(feedHref, snapshot.final_url).toString();
          rss.add(resolved);
          important.set(resolved, { url: resolved, reason: "rss", score: 180 });
        } catch {
          // ignore invalid rss href
        }
      }

      const contentUrl = snapshot.extracted.metadata.canonical_url ?? snapshot.final_url;
      if (!important.has(contentUrl)) {
        important.set(contentUrl, {
          url: contentUrl,
          title: snapshot.title,
          reason: importantReason(contentUrl),
          score: 100 + snapshot.extracted.mainText.length
        });
      }

      for (const link of snapshot.extracted.links) {
        const normalized = normalizeUrlForCrawl(link).normalizedUrl;
        if (seen.has(normalized) || !shouldIncludeUrl(normalized, filterOptions).allowed) {
          continue;
        }
        if (input.same_domain_only && new URL(normalized).hostname !== startHost) {
          continue;
        }
        if (input.obey_robots) {
          const parser = await getRobotsPolicy(new URL(normalized).origin);
          if (!parser.isAllowed(normalized, config.defaultUserAgent)) {
            continue;
          }
        }

        seen.add(normalized);
        queue.push(normalized);
      }
    } catch {
      // ignore page-level discovery errors
    }
  }

  return {
    important_pages: [...important.values()]
      .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
      .slice(0, Math.max(maxPages, 10))
      .map(({ score: _score, ...page }) => page),
    navigation_links: [...navigation].sort(),
    sitemaps: [...sitemaps].sort(),
    rss: [...rss].sort(),
    login_detected: loginDetected,
    search_detected: searchDetected,
    stats: {
      pages_scanned: pagesScanned,
      pages_queued: seen.size,
      duration_ms: Date.now() - startedAt
    }
  };
}
