import * as cheerio from "cheerio";
import type { AppConfig } from "../config.js";
import { clampNumber } from "./limits.js";
import { fetchRemoteResource } from "./remoteFetch.js";
import type { LookupFn } from "./ssrfGuard.js";

export type InferredUrlType = "docs" | "blog" | "product" | "category" | "policy" | "other";

export interface SitemapInspectInput {
  url: string;
  follow_indexes?: boolean;
  max_sitemaps?: number;
  max_urls?: number;
  same_domain_only?: boolean;
  max_depth?: number;
  timeout_ms?: number;
  max_xml_bytes?: number;
  sample_limit?: number;
}

export interface SitemapEntry {
  url: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
  inferred_type: InferredUrlType;
}

export interface SitemapGroup {
  label: string;
  count: number;
  sample_urls: string[];
}

export interface SitemapInspectResult {
  source_url: string;
  final_url: string;
  sitemap_type: "sitemapindex" | "urlset" | "unknown";
  resolved_sitemaps: string[];
  entries: SitemapEntry[];
  groups: SitemapGroup[];
  stats: {
    sitemap_count: number;
    url_count: number;
    nested_indexes_followed: number;
    skipped_same_domain: number;
    skipped_duplicates: number;
    truncated: boolean;
  };
}

type SitemapKind = "index" | "urlset" | "unknown";

interface SitemapNode {
  kind: SitemapKind;
  sitemaps: string[];
  entries: Array<Omit<SitemapEntry, "inferred_type">>;
}

interface SitemapQueueItem {
  url: string;
  depth: number;
}

function safeUrl(input: string | undefined): URL | undefined {
  if (!input) {
    return undefined;
  }

  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

function parseText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUrlValue(value: string, baseUrl: string): string | undefined {
  try {
    const normalized = new URL(value, baseUrl);
    normalized.hash = "";

    if (normalized.protocol !== "http:" && normalized.protocol !== "https:") {
      return undefined;
    }

    return normalized.toString();
  } catch {
    return undefined;
  }
}

function detectSitemapKind(xml: string): SitemapKind {
  if (/<(?:[\w.-]+:)?sitemapindex\b/i.test(xml)) {
    return "index";
  }

  if (/<(?:[\w.-]+:)?urlset\b/i.test(xml)) {
    return "urlset";
  }

  return "unknown";
}

function extractLocsFromXml(xml: string, baseUrl: string): string[] {
  const results = new Set<string>();
  const locPattern = /<loc>([\s\S]*?)<\/loc>/gi;

  for (let match = locPattern.exec(xml); match; match = locPattern.exec(xml)) {
    const normalized = normalizeUrlValue(match[1].trim(), baseUrl);
    if (normalized) {
      results.add(normalized);
    }
  }

  return [...results];
}

function parseIndexNode(xml: string, baseUrl: string): SitemapNode {
  const $ = cheerio.load(xml, { xmlMode: true });
  const sitemaps = $("sitemapindex sitemap loc")
    .toArray()
    .map((element) => normalizeUrlValue($(element).text(), baseUrl))
    .filter((value): value is string => Boolean(value));

  return {
    kind: "index",
    sitemaps: sitemaps.length > 0 ? sitemaps : extractLocsFromXml(xml, baseUrl),
    entries: []
  };
}

function parseUrlsetNode(xml: string, baseUrl: string): SitemapNode {
  const $ = cheerio.load(xml, { xmlMode: true });
  const parsedEntries = $("urlset url")
    .toArray()
    .map((element): Omit<SitemapEntry, "inferred_type"> | undefined => {
      const scope = $(element);
      const loc = normalizeUrlValue(scope.children("loc").text(), baseUrl);
      if (!loc) {
        return undefined;
      }

      const priorityValue = parseText(scope.children("priority").text());
      const priority = priorityValue ? Number(priorityValue) : undefined;

      return {
        url: loc,
        lastmod: parseText(scope.children("lastmod").text()),
        changefreq: parseText(scope.children("changefreq").text()),
        priority: Number.isFinite(priority) ? priority : undefined
      };
    });
  const entries = parsedEntries.filter((entry): entry is Omit<SitemapEntry, "inferred_type"> => entry !== undefined);

  if (entries.length > 0) {
    return {
      kind: "urlset",
      sitemaps: [],
      entries
    };
  }

  const fallbackEntries = extractLocsFromXml(xml, baseUrl).map((url) => ({
    url
  }));

  return {
    kind: "urlset",
    sitemaps: [],
    entries: fallbackEntries
  };
}

function parseSitemapXml(xml: string, baseUrl: string): SitemapNode {
  const kind = detectSitemapKind(xml);
  if (kind === "index") {
    return parseIndexNode(xml, baseUrl);
  }

  if (kind === "urlset") {
    return parseUrlsetNode(xml, baseUrl);
  }

  return {
    kind: "unknown",
    sitemaps: [],
    entries: []
  };
}

function inferUrlType(url: string): InferredUrlType {
  const parsed = safeUrl(url);
  const hostname = `${parsed?.hostname ?? ""}`.toLowerCase();
  const pathname = `${parsed?.pathname ?? ""}`.toLowerCase();
  const subject = `${hostname} ${pathname}`;

  if (
    /(privacy|policy|terms|legal|cookie|cookies|compliance|gdpr|security|trust|acceptable-use|aup|imprint|impressum)/.test(
      subject
    )
  ) {
    return "policy";
  }

  if (/(docs|guide|manual|reference|api|help|faq|support|knowledge|kb|learn|tutorial|how-to|documentation)/.test(subject)) {
    return "docs";
  }

  if (/(blog|news|article|post|press|release|update|updates|changelog|journal|stories|insights)/.test(subject)) {
    return "blog";
  }

  if (/(product|products|shop|store|item|items|sku|pricing|price|offer|offers|catalog|catalogue)/.test(subject)) {
    return "product";
  }

  if (/(category|categories|tag|tags|collection|collections|topic|topics|brand|brands|archive|archives)/.test(subject)) {
    return "category";
  }

  return "other";
}

function mergeEntry(existing: SitemapEntry, incoming: Omit<SitemapEntry, "inferred_type">): SitemapEntry {
  return {
    url: existing.url,
    inferred_type: existing.inferred_type,
    lastmod: existing.lastmod ?? incoming.lastmod,
    changefreq: existing.changefreq ?? incoming.changefreq,
    priority: existing.priority ?? incoming.priority
  };
}

function groupEntries(entries: SitemapEntry[], sampleLimit: number): SitemapGroup[] {
  const groups = new Map<InferredUrlType, SitemapGroup>();

  for (const entry of entries) {
    const group = groups.get(entry.inferred_type);
    if (group) {
      group.count += 1;
      if (group.sample_urls.length < sampleLimit) {
        group.sample_urls.push(entry.url);
      }
      continue;
    }

    groups.set(entry.inferred_type, {
      label: entry.inferred_type,
      count: 1,
      sample_urls: [entry.url]
    });
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function isSameHost(url: string, host: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) {
    return false;
  }

  return parsed.hostname === host;
}

function normalizeInputUrl(input: SitemapInspectInput): string {
  const sourceUrl = input.url?.trim();
  if (!sourceUrl) {
    throw new Error("Sitemap URL is required");
  }

  return sourceUrl;
}

export async function inspectSitemap(
  input: SitemapInspectInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<SitemapInspectResult> {
  const sourceUrl = normalizeInputUrl(input);
  const source = new URL(sourceUrl);
  const sourceHost = source.hostname;
  const followIndexes = input.follow_indexes ?? true;
  const maxSitemaps = clampNumber(input.max_sitemaps ?? 20, 1, 50);
  const maxUrls = clampNumber(input.max_urls ?? 500, 1, 5_000);
  const maxDepth = clampNumber(input.max_depth ?? 5, 0, 10);
  const sampleLimit = clampNumber(input.sample_limit ?? 3, 1, 10);
  const timeoutMs = clampNumber(input.timeout_ms ?? Math.min(config.maxToolTimeoutMs, 15_000), 1_000, config.maxToolTimeoutMs);
  const maxXmlBytes = clampNumber(
    input.max_xml_bytes ?? Math.max(4_096, config.robotsMaxBytes * 10),
    4_096,
    Math.max(config.maxHtmlBytes, 4_096)
  );

  const fetchImpl = options?.fetchImpl ?? fetch;
  const lookupFn = options?.lookupFn;

  const queue: SitemapQueueItem[] = [{ url: sourceUrl, depth: 0 }];
  const seenSitemaps = new Set<string>();
  const entries = new Map<string, SitemapEntry>();
  const resolvedSitemaps: string[] = [];
  let truncated = false;
  let nestedIndexesFollowed = 0;
  let skippedSameDomain = 0;
  let skippedDuplicates = 0;
  let sitemapType: "sitemapindex" | "urlset" | "unknown" = "unknown";
  let finalUrl = sourceUrl;

  while (queue.length > 0) {
    if (seenSitemaps.size >= maxSitemaps) {
      truncated = true;
      break;
    }

    const next = queue.shift();
    if (!next) {
      continue;
    }

    if (seenSitemaps.has(next.url)) {
      skippedDuplicates += 1;
      continue;
    }

    if (input.same_domain_only ?? true) {
      if (!isSameHost(next.url, sourceHost)) {
        skippedSameDomain += 1;
        continue;
      }
    }

    seenSitemaps.add(next.url);

    const response = await fetchRemoteResource(config, {
      url: next.url,
      timeoutMs,
      maxBytes: maxXmlBytes,
      userAgent: config.defaultUserAgent,
      accept: "application/xml,text/xml,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      fetchImpl,
      lookupFn
    });

    if (resolvedSitemaps.length === 0) {
      finalUrl = response.finalUrl;
    }
    resolvedSitemaps.push(response.finalUrl);
    if (response.truncated) {
      truncated = true;
    }

    const parsed = parseSitemapXml(response.buffer.toString("utf8"), response.finalUrl);
    if (sitemapType === "unknown" && parsed.kind !== "unknown") {
      sitemapType = parsed.kind === "index" ? "sitemapindex" : "urlset";
    }

    if (parsed.kind === "index" && followIndexes && next.depth < maxDepth) {
      for (const nestedUrl of parsed.sitemaps) {
        if (input.same_domain_only ?? true) {
          if (!isSameHost(nestedUrl, sourceHost)) {
            skippedSameDomain += 1;
            continue;
          }
        }

        if (seenSitemaps.has(nestedUrl) || queue.some((item) => item.url === nestedUrl)) {
          skippedDuplicates += 1;
          continue;
        }

        queue.push({ url: nestedUrl, depth: next.depth + 1 });
        nestedIndexesFollowed += 1;
      }
    } else if (parsed.kind === "index" && followIndexes && next.depth >= maxDepth) {
      truncated = true;
    }

    for (const entry of parsed.entries) {
      if (input.same_domain_only ?? true) {
        if (!isSameHost(entry.url, sourceHost)) {
          skippedSameDomain += 1;
          continue;
        }
      }

      const existing = entries.get(entry.url);
      if (existing) {
        entries.set(entry.url, mergeEntry(existing, entry));
        skippedDuplicates += 1;
        continue;
      }

      if (entries.size >= maxUrls) {
        truncated = true;
        break;
      }

      entries.set(entry.url, {
        ...entry,
        inferred_type: inferUrlType(entry.url)
      });
    }

    if (entries.size >= maxUrls) {
      truncated = true;
      break;
    }
  }

  const resolvedEntries = [...entries.values()].sort((a, b) => a.url.localeCompare(b.url));
  const resolvedSitemapsSorted = [...new Set(resolvedSitemaps)].sort((a, b) => a.localeCompare(b));

  return {
    source_url: sourceUrl,
    final_url: finalUrl,
    sitemap_type: sitemapType,
    resolved_sitemaps: resolvedSitemapsSorted,
    entries: resolvedEntries,
    groups: groupEntries(resolvedEntries, sampleLimit),
    stats: {
      sitemap_count: resolvedSitemapsSorted.length,
      url_count: resolvedEntries.length,
      nested_indexes_followed: nestedIndexesFollowed,
      skipped_same_domain: skippedSameDomain,
      skipped_duplicates: skippedDuplicates,
      truncated
    }
  };
}
