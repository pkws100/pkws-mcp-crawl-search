import { z } from "zod";
import type { AppConfig } from "../config.js";
import { buildResolutionQuery } from "../util/leadQuery.js";
import { normalizeWhitespace } from "../util/limits.js";
import { loadResearchSource } from "../util/research.js";
import type { LookupFn } from "../util/ssrfGuard.js";
import { executeWebSearch } from "./webSearch.js";

const DIRECTORY_PATTERN = /(gelbeseiten|11880|dasoertliche|branchenbuch|telefonbuch|cylex|yelp|meinestadt|werkenntdenbesten|golocal)/i;

export const resolveBusinessWebsiteInputSchema = z.object({
  name: z.string().min(1).max(300),
  location: z.string().min(1).max(200).optional(),
  postal_code: z.string().regex(/^\d{5}$/).optional(),
  category: z.string().min(1).max(200).optional(),
  candidate_urls: z.array(z.string().url()).max(20).optional()
});

export const resolveBusinessWebsiteResultSchema = z.object({
  best_website: z.string().url().optional(),
  alternatives: z.array(z.string().url()),
  resolution_reason: z.string(),
  confidence: z.number().int().min(0).max(100)
});

export type ResolveBusinessWebsiteInput = z.infer<typeof resolveBusinessWebsiteInputSchema>;
export type ResolveBusinessWebsiteResult = z.infer<typeof resolveBusinessWebsiteResultSchema>;

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function scoreUrlHeuristics(url: string, name: string, location?: string): number {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const pathname = decodeURIComponent(parsed.pathname.toLowerCase());
  const nameTokens = tokenize(name);
  const locationTokens = tokenize(location ?? "");
  const hostText = `${hostname} ${pathname}`;

  let score = 0;
  for (const token of nameTokens) {
    if (hostText.includes(token)) {
      score += 6;
    }
  }
  for (const token of locationTokens) {
    if (hostText.includes(token)) {
      score += 3;
    }
  }
  if (parsed.protocol === "https:") {
    score += 2;
  }
  if (pathname === "/" || pathname.split("/").filter(Boolean).length <= 1) {
    score += 6;
  }
  if (DIRECTORY_PATTERN.test(hostText)) {
    score -= 40;
  }
  return score;
}

export async function executeResolveBusinessWebsite(
  input: ResolveBusinessWebsiteInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    searchFetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<ResolveBusinessWebsiteResult> {
  const query = buildResolutionQuery({
    name: input.name,
    location: input.location,
    postalCode: input.postal_code,
    category: input.category
  });

  const candidateUrls = unique(input.candidate_urls ?? []);
  if (candidateUrls.length === 0) {
    const searchResults = await executeWebSearch(
      {
        query,
        limit: 5,
        language: "de",
        time_range: "year"
      },
      config,
      options?.searchFetchImpl ?? options?.fetchImpl,
      options?.lookupFn
    );
    candidateUrls.push(...searchResults.map((result) => result.url));
  }

  const scored: Array<{ url: string; score: number; reason: string }> = [];

  for (const url of unique(candidateUrls).slice(0, 8)) {
    try {
      const source = await loadResearchSource(
        {
          url,
          query,
          rendered: false,
          extractedVia: "search",
          titleHint: input.name
        },
        config,
        {
          fetchImpl: options?.fetchImpl,
          lookupFn: options?.lookupFn
        }
      );

      const urlScore = scoreUrlHeuristics(url, input.name, input.location);
      const titleText = `${source.title ?? ""} ${source.metadata?.og_title ?? ""}`;
      const titleMatch = tokenize(input.name).filter((token) => titleText.toLowerCase().includes(token)).length * 6;
      const total = Math.max(0, Math.min(100, source.trust_score + source.relevance_score / 2 + urlScore + titleMatch));
      scored.push({
        url: source.url,
        score: total,
        reason: `trust=${source.trust_score}, relevance=${source.relevance_score}, url_heuristics=${urlScore}, title_match=${titleMatch}`
      });
    } catch {
      const fallbackScore = scoreUrlHeuristics(url, input.name, input.location);
      scored.push({
        url,
        score: Math.max(0, Math.min(100, fallbackScore + 10)),
        reason: `heuristic-only=${fallbackScore}`
      });
    }
  }

  const ranked = unique(
    scored
      .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
      .map((entry) => entry.url)
  );
  const best = scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))[0];

  return resolveBusinessWebsiteResultSchema.parse({
    best_website: best && best.score >= 25 ? best.url : undefined,
    alternatives: ranked.slice(best && best.score >= 25 ? 1 : 0, 4),
    resolution_reason: best ? best.reason : "No website candidate could be validated.",
    confidence: best ? Math.max(0, Math.min(100, Math.round(best.score))) : 0
  });
}
