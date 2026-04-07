import { z } from "zod";
import type { ExtractedContent } from "./contentExtract.js";
import { normalizeWhitespace } from "./limits.js";

const STOPWORDS = new Set([
  "and",
  "or",
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "from",
  "by",
  "and",
  "der",
  "die",
  "das",
  "ein",
  "eine",
  "und",
  "oder",
  "mit",
  "für",
  "fur",
  "im",
  "in",
  "am",
  "an",
  "den",
  "dem",
  "des"
]);

export const searchQualityBreakdownSchema = z.object({
  query_coverage: z.number(),
  title_match: z.number(),
  snippet_match: z.number(),
  url_match: z.number(),
  structure_bonus: z.number(),
  position_penalty: z.number(),
  total: z.number()
});

export const extractionQualityBreakdownSchema = z.object({
  kind_bonus: z.number(),
  length_score: z.number(),
  structure_score: z.number(),
  metadata_score: z.number(),
  truncation_penalty: z.number(),
  total: z.number()
});

export type SearchQualityBreakdown = z.infer<typeof searchQualityBreakdownSchema>;
export type ExtractionQualityBreakdown = z.infer<typeof extractionQualityBreakdownSchema>;

export interface SearchQualityCandidate {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchQualityInput extends SearchQualityCandidate {
  position: number;
}

export interface SearchQualityScored extends SearchQualityCandidate {
  position: number;
  quality_score: number;
  quality_breakdown: SearchQualityBreakdown;
}

export interface ExtractionQualityInput {
  kind: "markdown" | "text" | "chunks";
  title?: string;
  metadata?: {
    canonical_url?: string;
    meta_description?: string;
    lang?: string;
    author?: string;
    published_at?: string;
    modified_at?: string;
    og_title?: string;
    og_description?: string;
  };
  markdown?: string;
  text?: string;
  chunks?: Array<{ heading_path?: string[]; text: string }>;
  headings?: Array<{ level: number; text: string; id?: string }>;
  links?: string[];
  truncated?: boolean;
  bytes?: number;
}

export interface ExtractionQualityScored {
  quality_score: number;
  quality_breakdown: ExtractionQualityBreakdown;
}

export interface RankedCandidate<T> {
  item: T;
  position: number;
  quality_score: number;
  quality_breakdown: SearchQualityBreakdown;
}

export const inferredUrlTypeValues = ["docs", "blog", "product", "category", "policy", "other"] as const;
export type InferredUrlType = (typeof inferredUrlTypeValues)[number];

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

function overlapScore(needles: string[], haystack: string[]): number {
  if (needles.length === 0) {
    return 0;
  }

  const haystackSet = new Set(haystack);
  const hits = needles.filter((token) => haystackSet.has(token)).length;
  return Math.max(0, Math.min(100, (hits / needles.length) * 100));
}

function pathTokens(url: string): string[] {
  try {
    const parsed = new URL(url);
    return uniqueTokens(`${parsed.hostname} ${parsed.pathname}`);
  } catch {
    return uniqueTokens(url);
  }
}

function phraseBonus(query: string, value: string): number {
  const q = normalizeWhitespace(query).toLowerCase();
  const v = normalizeWhitespace(value).toLowerCase();
  if (!q || !v) {
    return 0;
  }

  if (v.includes(q)) {
    return 15;
  }

  const qTokens = uniqueTokens(q);
  if (qTokens.length > 1 && qTokens.every((token) => v.includes(token))) {
    return 8;
  }

  return 0;
}

function structuralBonus(url: string): number {
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();
  let bonus = 0;

  if (/(docs|guide|manual|reference|api|article|blog|post|tutorial|learn)/.test(path)) {
    bonus += 12;
  }

  if (path.split("/").filter(Boolean).length <= 3) {
    bonus += 4;
  }

  if (parsed.protocol === "https:") {
    bonus += 4;
  }

  return Math.min(20, bonus);
}

export function scoreSearchCandidate(query: string, candidate: SearchQualityCandidate, position = 0): SearchQualityBreakdown {
  const queryTokens = uniqueTokens(query);
  const titleTokens = uniqueTokens(candidate.title);
  const snippetTokens = uniqueTokens(candidate.snippet);
  const urlTokens = pathTokens(candidate.url);

  const queryCoverage =
    overlapScore(queryTokens, titleTokens) * 0.5 +
    overlapScore(queryTokens, snippetTokens) * 0.35 +
    overlapScore(queryTokens, urlTokens) * 0.15;

  const titleMatch = overlapScore(queryTokens, titleTokens);
  const snippetMatch = overlapScore(queryTokens, snippetTokens);
  const urlMatch = overlapScore(queryTokens, urlTokens);
  const structureBonus = structuralBonus(candidate.url) + phraseBonus(query, `${candidate.title} ${candidate.snippet}`);
  const positionPenalty = Math.min(18, Math.max(0, position) * 3);

  const total = clampScore(
    queryCoverage * 0.45 +
      titleMatch * 0.28 +
      snippetMatch * 0.14 +
      urlMatch * 0.08 +
      structureBonus
      - positionPenalty
  );

  return {
    query_coverage: roundScore(queryCoverage),
    title_match: roundScore(titleMatch),
    snippet_match: roundScore(snippetMatch),
    url_match: roundScore(urlMatch),
    structure_bonus: roundScore(structureBonus),
    position_penalty: roundScore(positionPenalty),
    total: roundScore(total)
  };
}

export function scoreSearchResultCandidate(query: string, candidate: SearchQualityCandidate, language?: string): number {
  let total = scoreSearchCandidate(query, candidate, 0).total;

  if (language?.toLowerCase().startsWith("de")) {
    if (/\.de(\/|$)/i.test(candidate.url) || /\/de(\/|$)/i.test(candidate.url)) {
      total += 6;
    }
  } else if (language?.toLowerCase().startsWith("en")) {
    if (/\/en(\/|$)/i.test(candidate.url)) {
      total += 6;
    }
  }

  const urlType = inferUrlType(candidate.url);
  if (urlType === "docs") {
    total += 8;
  } else if (urlType === "blog") {
    total += 4;
  } else if (urlType === "category" || urlType === "policy") {
    total -= 6;
  }

  return roundScore(clampScore(total));
}

export function rerankSearchCandidates<T extends SearchQualityCandidate>(query: string, candidates: T[]): RankedCandidate<T>[] {
  return candidates
    .map((item, position) => ({
      item,
      position,
      quality_breakdown: scoreSearchCandidate(query, item, position)
    }))
    .map((entry) => ({
      ...entry,
      quality_score: entry.quality_breakdown.total
    }))
    .sort((a, b) => b.quality_score - a.quality_score || a.position - b.position || a.item.url.localeCompare(b.item.url));
}

export function chooseExtractionKind(
  candidate: SearchQualityCandidate,
  options?: {
    preferred?: "auto" | "markdown" | "text" | "chunks";
    maxChars?: number;
    chunkSize?: number;
    maxChunks?: number;
  }
): "markdown" | "text" | "chunks" {
  const preferred = options?.preferred ?? "auto";
  if (preferred !== "auto") {
    return preferred;
  }

  const haystack = `${candidate.title} ${candidate.snippet} ${candidate.url}`.toLowerCase();

  if (/\/(login|signin|sign-in|account|search|about|help|faq)\b/.test(haystack)) {
    return "markdown";
  }

  if (/(docs|guide|manual|reference|api|tutorial|article|blog|post|chapter|learn)/.test(haystack)) {
    if ((options?.maxChars ?? 0) >= 12000 || candidate.snippet.length > 180) {
      return "chunks";
    }
    return "markdown";
  }

  if (candidate.snippet.length > 220 || (options?.maxChars ?? 0) >= 12000) {
    return "chunks";
  }

  return "markdown";
}

export function scoreExtractionQuality(input: ExtractionQualityInput): ExtractionQualityScored {
  const kindBonus = input.kind === "chunks" ? 18 : input.kind === "markdown" ? 14 : 8;
  const textSource =
    input.kind === "chunks"
      ? input.chunks?.map((chunk) => chunk.text).join(" ") ?? ""
      : input.kind === "markdown"
        ? input.markdown ?? ""
        : input.text ?? "";

  const contentLength = normalizeWhitespace(textSource).length;
  const lengthScore = Math.min(30, contentLength / 80);

  const headingScore = Math.min(12, (input.headings?.length ?? 0) * 2.5);
  const linkScore = Math.min(8, (input.links?.length ?? 0) * 0.8);
  const chunkScore = Math.min(10, (input.chunks?.length ?? 0) * 1.5);
  const metadataFields = [
    input.metadata?.canonical_url,
    input.metadata?.meta_description,
    input.metadata?.lang,
    input.metadata?.author,
    input.metadata?.published_at,
    input.metadata?.modified_at,
    input.metadata?.og_title,
    input.metadata?.og_description
  ].filter(Boolean).length;
  const metadataScore = Math.min(20, metadataFields * 2.5);
  const truncationPenalty = input.truncated ? 18 : 0;

  const total = clampScore(kindBonus + lengthScore + headingScore + linkScore + chunkScore + metadataScore - truncationPenalty);

  return {
    quality_score: roundScore(total),
    quality_breakdown: {
      kind_bonus: roundScore(kindBonus),
      length_score: roundScore(lengthScore),
      structure_score: roundScore(headingScore + linkScore + chunkScore),
      metadata_score: roundScore(metadataScore),
      truncation_penalty: roundScore(truncationPenalty),
      total: roundScore(total)
    }
  };
}

export function combineQualityScores(searchScore: number, extractionScore: number): number {
  return roundScore(clampScore(searchScore * 0.6 + extractionScore * 0.4));
}

export function inferUrlType(input: string): InferredUrlType {
  const lower = input.toLowerCase();
  if (/(^|\/)(docs?|guide|manual|api|kb|knowledge-base|learn|release-notes?|releases?|changelog|change-log)(\/|$)/.test(lower)) {
    return "docs";
  }
  if (/(^|\/)(blog|news|articles?|posts?)(\/|$)/.test(lower)) {
    return "blog";
  }
  if (/(^|\/)(product|products|pricing|item|shop)(\/|$)/.test(lower)) {
    return "product";
  }
  if (/(^|\/)(category|categories|catalog|collections?|tags?)(\/|$)/.test(lower)) {
    return "category";
  }
  if (/(^|\/)(privacy|terms|legal|policy|policies|imprint|impressum)(\/|$)/.test(lower)) {
    return "policy";
  }
  return "other";
}

export function computeContentQuality(extracted: ExtractedContent): {
  content_quality_score: number;
  boilerplate_ratio?: number;
  word_count: number;
} {
  const extraction = scoreExtractionQuality({
    kind: "markdown",
    title: extracted.title,
    metadata: extracted.metadata,
    markdown: extracted.mainText,
    headings: extracted.headings,
    links: extracted.links,
    truncated: extracted.truncated
  });

  return {
    content_quality_score: Math.round(extraction.quality_score),
    boilerplate_ratio: extracted.boilerplate_ratio,
    word_count: uniqueTokens(extracted.mainText).length
  };
}

export function computeRelevanceScore(
  query: string,
  candidate: {
    title?: string;
    url?: string;
    snippet?: string;
    headings?: string[];
    metaDescription?: string;
    text?: string;
  }
): number {
  const breakdown = scoreSearchCandidate(query, {
    title: `${candidate.title ?? ""} ${(candidate.headings ?? []).join(" ")}`.trim(),
    url: candidate.url ?? "",
    snippet: `${candidate.snippet ?? ""} ${candidate.metaDescription ?? ""} ${candidate.text ?? ""}`.trim()
  });

  return Math.round(breakdown.total);
}

function roundScore(value: number): number {
  return Number(value.toFixed(2));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}
