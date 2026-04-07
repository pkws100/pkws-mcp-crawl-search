import { z } from "zod";
import type { AppConfig } from "../config.js";
import { executeInspectSitemap } from "./inspectSitemap.js";
import { executeSearchAndExtract } from "./searchAndExtract.js";
import {
  dedupeResearchSources,
  loadResearchSource,
  type ResearchSourceRecord
} from "../util/research.js";
import { sourceTypeValues } from "../util/sourceTrust.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const researchSourcesInputSchema = z.object({
  query: z.string().min(1).max(500),
  max_sources: z.number().int().min(1).max(12).default(8),
  language: z.string().min(2).max(16).default("de"),
  time_range: z.enum(["day", "week", "month", "year", "all"]).default("month"),
  prefer_official_sources: z.boolean().default(true),
  include_sitemaps: z.boolean().default(true)
});

export const researchSourcesResultSchema = z.object({
  sources: z.array(
    z.object({
      source_id: z.string(),
      title: z.string().optional(),
      url: z.string().url(),
      source_type: z.enum(sourceTypeValues),
      trust_score: z.number().int().min(0).max(100),
      relevance_score: z.number().int().min(0).max(100),
      extracted_preview: z.string(),
      sitemap_candidates: z.array(z.string().url()).optional()
    })
  ),
  stats: z.object({
    searched: z.number().int().nonnegative(),
    profiled: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative()
  })
});

export type ResearchSourcesInput = z.infer<typeof researchSourcesInputSchema>;
export type ResearchSourcesResult = z.infer<typeof researchSourcesResultSchema>;

export interface CollectedResearchSources {
  publicResult: ResearchSourcesResult;
  loadedSources: ResearchSourceRecord[];
}

async function discoverSitemapCandidates(
  url: string,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<string[]> {
  const origin = new URL(url).origin;
  try {
    const inspected = await executeInspectSitemap(
      {
        url: new URL("/sitemap.xml", origin).toString(),
        follow_indexes: true,
        max_sitemaps: 5,
        max_urls: 25,
        same_domain_only: true,
        max_depth: 2,
        timeout_ms: 10_000,
        max_xml_bytes: 200_000,
        sample_limit: 2
      },
      config,
      options
    );
    return inspected.resolved_sitemaps.slice(0, 3);
  } catch {
    return [];
  }
}

export async function collectResearchSources(
  input: ResearchSourcesInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    searchFetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<CollectedResearchSources> {
  const startedAt = Date.now();
  const search = await executeSearchAndExtract(
    {
      query: input.query,
      search_limit: input.max_sources,
      extract_mode: "markdown",
      prefer_rendered: false,
      language: input.language,
      time_range: input.time_range,
      per_result_max_chars: 4_000
    },
    config,
    {
      fetchImpl: options?.fetchImpl,
      searchFetchImpl: options?.searchFetchImpl,
      lookupFn: options?.lookupFn
    }
  );

  const loadedSources: ResearchSourceRecord[] = [];
  const sitemapCandidates = new Map<string, string[]>();

  for (const result of search.results) {
    const loaded = await loadResearchSource(
      {
        url: result.url,
        query: input.query,
        rendered: false,
        extractedVia: "search",
        titleHint: result.title,
        snippetHint: result.snippet
      },
      config,
      {
        fetchImpl: options?.fetchImpl,
        lookupFn: options?.lookupFn
      }
    );

    loaded.relevance_score = result.quality?.relevance_score ?? loaded.relevance_score;
    loaded.content_quality_score = result.quality?.content_quality_score ?? loaded.content_quality_score;
    loadedSources.push(loaded);
  }

  const deduped = dedupeResearchSources(loadedSources).sort((a, b) => {
    if (input.prefer_official_sources) {
      return b.trust_score - a.trust_score || b.relevance_score - a.relevance_score || a.url.localeCompare(b.url);
    }
    return b.relevance_score - a.relevance_score || b.trust_score - a.trust_score || a.url.localeCompare(b.url);
  }).slice(0, input.max_sources);

  if (input.include_sitemaps) {
    for (const source of deduped) {
      if (!["official", "government", "scientific"].includes(source.source_type) || source.trust_score < 78) {
        continue;
      }
      const candidates = await discoverSitemapCandidates(source.url, config, {
        fetchImpl: options?.fetchImpl,
        lookupFn: options?.lookupFn
      });
      if (candidates.length > 0) {
        sitemapCandidates.set(source.source_id, candidates);
      }
    }
  }

  const publicResult = researchSourcesResultSchema.parse({
    sources: deduped.map((source) => ({
      source_id: source.source_id,
      title: source.title,
      url: source.url,
      source_type: source.source_type,
      trust_score: source.trust_score,
      relevance_score: source.relevance_score,
      extracted_preview: source.extracted_preview,
      sitemap_candidates: sitemapCandidates.get(source.source_id)
    })),
    stats: {
      searched: search.stats.searched,
      profiled: loadedSources.length,
      returned: deduped.length,
      duration_ms: Date.now() - startedAt
    }
  });

  return {
    publicResult,
    loadedSources: deduped
  };
}

export async function executeResearchSources(
  input: ResearchSourcesInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    searchFetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<ResearchSourcesResult> {
  const collected = await collectResearchSources(input, config, options);
  return collected.publicResult;
}
