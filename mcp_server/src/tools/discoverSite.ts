import { z } from "zod";
import type { AppConfig } from "../config.js";
import { executeDiscovery } from "../util/discovery.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const discoverSiteInputSchema = z.object({
  start_url: z.string().url(),
  max_pages: z.number().int().min(1).max(50).default(20),
  same_domain_only: z.boolean().default(true),
  include_sitemaps: z.boolean().default(true),
  obey_robots: z.boolean().default(true),
  delay_ms: z.number().int().min(0).max(5_000).default(250)
});

export const discoverSiteResultSchema = z.object({
  important_pages: z.array(
    z.object({
      url: z.string().url(),
      title: z.string().optional(),
      reason: z.enum(["nav", "sitemap", "rss", "content"])
    })
  ),
  navigation_links: z.array(z.string().url()),
  sitemaps: z.array(z.string().url()),
  rss: z.array(z.string().url()),
  login_detected: z.boolean(),
  search_detected: z.boolean(),
  stats: z.object({
    pages_scanned: z.number().int().nonnegative(),
    pages_queued: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative()
  })
});

export type DiscoverSiteInput = z.infer<typeof discoverSiteInputSchema>;
export type DiscoverSiteResult = z.infer<typeof discoverSiteResultSchema>;

export async function executeDiscoverSite(
  input: DiscoverSiteInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<DiscoverSiteResult> {
  return discoverSiteResultSchema.parse(await executeDiscovery(input, config, options));
}
