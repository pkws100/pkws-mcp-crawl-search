import { z } from "zod";
import type { AppConfig } from "../config.js";
import { inspectSitemap } from "../util/sitemap.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const inspectSitemapInputSchema = z
  .object({
    url: z.string().url().optional(),
    sitemap_url: z.string().url().optional(),
    follow_indexes: z.boolean().default(true),
    max_sitemaps: z.number().int().min(1).max(50).default(20),
    max_urls: z.number().int().min(1).max(5_000).default(500),
    same_domain_only: z.boolean().default(true),
    max_depth: z.number().int().min(0).max(10).default(5),
    timeout_ms: z.number().int().min(1_000).max(30_000).default(15_000),
    max_xml_bytes: z.number().int().min(4_096).max(5_000_000).default(100_000),
    sample_limit: z.number().int().min(1).max(10).default(3)
  })
  .refine((input) => Boolean(input.url || input.sitemap_url), {
    message: "Either url or sitemap_url is required"
  });

export const inspectSitemapResultSchema = z.object({
  source_url: z.string().url(),
  final_url: z.string().url(),
  sitemap_type: z.enum(["sitemapindex", "urlset", "unknown"]),
  resolved_sitemaps: z.array(z.string().url()),
  entries: z.array(
    z.object({
      url: z.string().url(),
      lastmod: z.string().optional(),
      changefreq: z.string().optional(),
      priority: z.number().optional(),
      inferred_type: z.enum(["docs", "blog", "product", "category", "policy", "other"])
    })
  ),
  groups: z.array(
    z.object({
      label: z.enum(["docs", "blog", "product", "category", "policy", "other"]),
      count: z.number().int().nonnegative(),
      sample_urls: z.array(z.string().url())
    })
  ),
  stats: z.object({
    sitemap_count: z.number().int().nonnegative(),
    url_count: z.number().int().nonnegative(),
    nested_indexes_followed: z.number().int().nonnegative(),
    skipped_same_domain: z.number().int().nonnegative(),
    skipped_duplicates: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
});

export type InspectSitemapInput = z.infer<typeof inspectSitemapInputSchema>;
export type InspectSitemapResult = z.infer<typeof inspectSitemapResultSchema>;

function normalizeInput(input: InspectSitemapInput): {
  url: string;
  follow_indexes: boolean;
  max_sitemaps: number;
  max_urls: number;
  same_domain_only: boolean;
  max_depth: number;
  timeout_ms: number;
  max_xml_bytes: number;
  sample_limit: number;
} {
  return {
    url: input.url ?? input.sitemap_url ?? "",
    follow_indexes: input.follow_indexes,
    max_sitemaps: input.max_sitemaps,
    max_urls: input.max_urls,
    same_domain_only: input.same_domain_only,
    max_depth: input.max_depth,
    timeout_ms: input.timeout_ms,
    max_xml_bytes: input.max_xml_bytes,
    sample_limit: input.sample_limit
  };
}

export async function executeInspectSitemap(
  input: InspectSitemapInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<InspectSitemapResult> {
  const normalized = inspectSitemapInputSchema.parse(input);
  const result = await inspectSitemap(normalizeInput(normalized), config, options);
  return inspectSitemapResultSchema.parse(result);
}
