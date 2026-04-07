import { z } from "zod";
import type { AppConfig } from "../config.js";
import { executeCrawlSitemapTargets } from "./crawlSitemapTargets.js";
import { collectResearchSources } from "./researchSources.js";
import { buildClaimsFromSources, dedupeResearchSources, loadResearchSource } from "../util/research.js";
import { sourceTypeValues } from "../util/sourceTrust.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const deepResearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  mode: z.enum(["evidence_first"]).default("evidence_first"),
  max_sources: z.number().int().min(1).max(12).default(8),
  max_claims: z.number().int().min(1).max(20).default(12),
  language: z.string().min(2).max(16).default("de"),
  time_range: z.enum(["day", "week", "month", "year", "all"]).default("month"),
  include_sitemaps: z.boolean().default(true),
  prefer_official_sources: z.boolean().default(true),
  allow_rendered: z.boolean().default(true)
});

export const deepResearchResultSchema = z.object({
  query: z.string(),
  claims: z.array(
    z.object({
      id: z.string(),
      claim: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      support: z.array(
        z.object({
          source_id: z.string(),
          evidence: z.string()
        })
      ),
      contradictions: z.array(
        z.object({
          source_id: z.string(),
          note: z.string()
        })
      )
    })
  ),
  sources: z.array(
    z.object({
      source_id: z.string(),
      title: z.string().optional(),
      url: z.string().url(),
      source_type: z.enum(sourceTypeValues),
      trust_score: z.number().int().min(0).max(100),
      relevance_score: z.number().int().min(0).max(100),
      content_quality_score: z.number().int().min(0).max(100).optional(),
      extracted_via: z.enum(["search", "sitemap", "document", "rendered"])
    })
  ),
  summary: z.object({
    answered: z.boolean(),
    confidence: z.enum(["high", "medium", "low"]),
    gaps: z.array(z.string())
  }),
  stats: z.object({
    sources_considered: z.number().int().nonnegative(),
    sources_profiled: z.number().int().nonnegative(),
    sitemap_sources_added: z.number().int().nonnegative(),
    claims_generated: z.number().int().nonnegative(),
    contradictions_found: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative()
  })
});

export type DeepResearchInput = z.infer<typeof deepResearchInputSchema>;
export type DeepResearchResult = z.infer<typeof deepResearchResultSchema>;

function inferSitemapUrlType(query: string): "docs" | "blog" | "product" | "policy" | undefined {
  const lower = query.toLowerCase();
  if (/(api|docs|guide|install|reference|manual|how to|tutorial|release notes|release|changelog|change log)/i.test(lower)) {
    return "docs";
  }
  if (/(privacy|policy|terms|legal|impressum|gdpr|cookie)/i.test(lower)) {
    return "policy";
  }
  if (/(announcement|news|blog)/i.test(lower)) {
    return "blog";
  }
  if (/(price|pricing|feature|product|plan|sku|offer)/i.test(lower)) {
    return "product";
  }
  return undefined;
}

export async function executeDeepResearch(
  input: DeepResearchInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    searchFetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<DeepResearchResult> {
  const startedAt = Date.now();
  const collected = await collectResearchSources(
    {
      query: input.query,
      max_sources: input.max_sources,
      language: input.language,
      time_range: input.time_range,
      prefer_official_sources: input.prefer_official_sources,
      include_sitemaps: input.include_sitemaps
    },
    config,
    options
  );

  const sourceMap = new Map(collected.publicResult.sources.map((source) => [source.source_id, source]));
  const enrichedSources = [...collected.loadedSources];
  let sitemapSourcesAdded = 0;

  if (input.include_sitemaps) {
    const sitemapType = inferSitemapUrlType(input.query);
    for (const source of collected.publicResult.sources.slice(0, 2)) {
      if (!["official", "government", "scientific"].includes(source.source_type) || source.trust_score < 75) {
        continue;
      }

      const sitemapCandidates = sourceMap.get(source.source_id)?.sitemap_candidates ?? [];
      for (const sitemapUrl of sitemapCandidates.slice(0, 1)) {
        try {
          const crawled = await executeCrawlSitemapTargets(
            {
              sitemap_url: sitemapUrl,
              url_type: sitemapType,
              sort_by: "lastmod_desc",
              limit: 2,
              fetch_mode: "markdown",
              max_chars_per_page: 6_000,
              timeout_ms: 15_000
            },
            config,
            {
              fetchImpl: options?.fetchImpl,
              lookupFn: options?.lookupFn
            }
          );

          for (const page of crawled.pages) {
            const loaded = await loadResearchSource(
              {
                url: page.url,
                query: input.query,
                rendered: false,
                extractedVia: "sitemap"
              },
              config,
              {
                fetchImpl: options?.fetchImpl,
                lookupFn: options?.lookupFn
              }
            );
            enrichedSources.push(loaded);
            sitemapSourcesAdded += 1;
          }
        } catch {
          // ignore sitemap deepening failures
        }
      }
    }
  }

  const deduped = dedupeResearchSources(enrichedSources)
    .sort((a, b) => b.trust_score - a.trust_score || b.relevance_score - a.relevance_score || a.url.localeCompare(b.url))
    .slice(0, input.max_sources + 4);

  const claims = buildClaimsFromSources(input.query, deduped, input.max_claims);
  const answered = claims.claims.length > 0;
  const confidence =
    claims.coverage.well_supported > 0
      ? "high"
      : claims.claims.length > 0
        ? "medium"
        : "low";

  const gaps: string[] = [];
  if (!answered) {
    gaps.push("No well-supported claim could be extracted from the available sources.");
  }
  if (claims.coverage.conflicting > 0) {
    gaps.push("Some claims have conflicting evidence and should be checked manually.");
  }
  if (!deduped.some((source) => ["official", "government", "scientific"].includes(source.source_type))) {
    gaps.push("No strong primary or institutional source was found in the source set.");
  }

  return deepResearchResultSchema.parse({
    query: input.query,
    claims: claims.claims,
    sources: deduped.map((source) => ({
      source_id: source.source_id,
      title: source.title,
      url: source.url,
      source_type: source.source_type,
      trust_score: source.trust_score,
      relevance_score: source.relevance_score,
      content_quality_score: source.content_quality_score,
      extracted_via: source.extracted_via
    })),
    summary: {
      answered,
      confidence,
      gaps
    },
    stats: {
      sources_considered: collected.publicResult.stats.searched,
      sources_profiled: collected.loadedSources.length,
      sitemap_sources_added: sitemapSourcesAdded,
      claims_generated: claims.claims.length,
      contradictions_found: claims.contradictions.length,
      duration_ms: Date.now() - startedAt
    }
  });
}
