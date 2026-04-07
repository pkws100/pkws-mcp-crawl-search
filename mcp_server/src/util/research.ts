import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { FetchDocumentTextResult } from "../tools/fetchDocumentText.js";
import { executeFetchDocumentText } from "../tools/fetchDocumentText.js";
import { fetchPageSnapshot } from "../tools/fetchUrlText.js";
import { renderPageSnapshot } from "../tools/crawlRendered.js";
import { clampNumber, normalizeWhitespace, truncateText } from "./limits.js";
import { computeContentQuality, computeRelevanceScore } from "./quality.js";
import {
  buildSourceProfile,
  type SourceMetadataLike,
  type SourceProfile,
  type SourceType
} from "./sourceTrust.js";
import type { LookupFn } from "./ssrfGuard.js";

export type ExtractedVia = "search" | "sitemap" | "document" | "rendered";

export interface ResearchSourceRecord {
  source_id: string;
  title?: string;
  url: string;
  canonical_url?: string;
  content_hash?: string;
  source_type: SourceType;
  trust_score: number;
  relevance_score: number;
  content_quality_score?: number;
  extracted_via: ExtractedVia;
  profile: SourceProfile;
  quality?: {
    content_quality_score: number;
    boilerplate_ratio?: number;
    word_count: number;
  };
  metadata?: SourceMetadataLike;
  extracted_preview: string;
  text: string;
}

export interface ResearchClaim {
  id: string;
  claim: string;
  confidence: "high" | "medium" | "low";
  support: Array<{ source_id: string; evidence: string }>;
  contradictions: Array<{ source_id: string; note: string }>;
}

export interface ResearchContradiction {
  claim_id: string;
  source_id: string;
  note: string;
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u017f]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

export function createSourceId(url: string): string {
  return `src_${createHash("sha1").update(url).digest("hex").slice(0, 12)}`;
}

function extractDocumentQuality(document: FetchDocumentTextResult): {
  content_quality_score: number;
  word_count: number;
} {
  const wordCount = document.text.split(/\s+/).filter(Boolean).length;
  return {
    content_quality_score: Math.max(0, Math.min(100, Math.round(Math.min(wordCount, 1200) / 12))),
    word_count: wordCount
  };
}

function buildPreview(value: string): string {
  return truncateText(normalizeWhitespace(value), 420).value;
}

export async function loadResearchSource(
  input: {
    url: string;
    query: string;
    rendered?: boolean;
    extractedVia: ExtractedVia;
    titleHint?: string;
    snippetHint?: string;
  },
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<ResearchSourceRecord> {
  const url = input.url;
  if (/\.pdf($|[?#])/i.test(url)) {
    const document = await executeFetchDocumentText(
      {
        url,
        max_chars: clampNumber(12_000, 1, config.maxCharsPerPage),
        timeout_ms: 20_000
      },
      config,
      options
    );
    const quality = extractDocumentQuality(document);
    const profile = buildSourceProfile({
      url: document.final_url,
      title: document.title ?? input.titleHint,
      quality
    });

    return {
      source_id: createSourceId(document.final_url),
      title: document.title ?? input.titleHint,
      url: document.final_url,
      source_type: profile.source_type,
      trust_score: profile.trust_score,
      relevance_score: computeRelevanceScore(input.query, {
        title: document.title ?? input.titleHint,
        url: document.final_url,
        snippet: input.snippetHint,
        text: document.text
      }),
      content_quality_score: quality.content_quality_score,
      extracted_via: "document",
      profile,
      quality: {
        content_quality_score: quality.content_quality_score,
        word_count: quality.word_count
      },
      extracted_preview: buildPreview(document.text),
      text: document.text
    };
  }

  const snapshot = input.rendered
    ? await renderPageSnapshot(
        {
          url,
          wait_until: "networkidle",
          wait_ms: 1_000,
          max_chars: config.maxCharsPerPage,
          timeout_ms: 20_000
        },
        config,
        { lookupFn: options?.lookupFn }
      )
    : await fetchPageSnapshot(
        {
          url,
          max_chars: config.maxCharsPerPage,
          timeout_ms: 20_000
        },
        config,
        options
      );

  const quality = computeContentQuality(snapshot.extracted);
  const profile = buildSourceProfile({
    url: snapshot.final_url,
    title: snapshot.title ?? input.titleHint,
    metadata: snapshot.extracted.metadata,
    quality
  });

  return {
    source_id: createSourceId(snapshot.final_url),
    title: snapshot.title ?? input.titleHint,
    url: snapshot.final_url,
    canonical_url: snapshot.extracted.metadata.canonical_url,
    content_hash: snapshot.extracted.content_hash,
    source_type: profile.source_type,
    trust_score: profile.trust_score,
    relevance_score: computeRelevanceScore(input.query, {
      title: snapshot.title ?? input.titleHint,
      url: snapshot.final_url,
      snippet: input.snippetHint,
      headings: snapshot.extracted.headings.map((heading) => heading.text),
      metaDescription: snapshot.extracted.metadata.meta_description,
      text: snapshot.extracted.mainText
    }),
    content_quality_score: quality.content_quality_score,
    extracted_via: input.rendered ? "rendered" : input.extractedVia,
    profile,
    quality,
    metadata: snapshot.extracted.metadata,
    extracted_preview: buildPreview(snapshot.extracted.mainText),
    text: snapshot.extracted.mainText
  };
}

export function dedupeResearchSources(sources: ResearchSourceRecord[]): ResearchSourceRecord[] {
  const seen = new Set<string>();
  const deduped: ResearchSourceRecord[] = [];

  for (const source of sources) {
    const key = source.canonical_url ?? source.content_hash ?? source.url;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(source);
  }

  return deduped;
}

function splitSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30 && sentence.length <= 320);
}

function scoreEvidenceSentence(query: string, sentence: string): number {
  const queryTokens = uniqueTokens(query);
  const sentenceTokens = uniqueTokens(sentence);
  if (queryTokens.length === 0 || sentenceTokens.length === 0) {
    return 0;
  }

  const sentenceSet = new Set(sentenceTokens);
  const hits = queryTokens.filter((token) => sentenceSet.has(token)).length;
  const overlap = hits / queryTokens.length;
  return Math.round(overlap * 100);
}

function claimSignature(sentence: string): string {
  return uniqueTokens(sentence)
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, 8)
    .sort()
    .join("|");
}

function sentenceSimilarity(left: string, right: string): number {
  const leftTokens = uniqueTokens(left);
  const rightTokens = uniqueTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function areLikelySameClaim(left: string, right: string): boolean {
  if (normalizeWhitespace(left).toLowerCase() === normalizeWhitespace(right).toLowerCase()) {
    return true;
  }

  const leftSignature = claimSignature(left);
  const rightSignature = claimSignature(right);
  if (leftSignature && leftSignature === rightSignature) {
    return true;
  }

  const similarity = sentenceSimilarity(left, right);
  const leftNumbers = extractNumbers(left);
  const rightNumbers = extractNumbers(right);
  const sameNumbers =
    leftNumbers.length > 0 &&
    rightNumbers.length > 0 &&
    leftNumbers.join("|") === rightNumbers.join("|");

  return similarity >= 0.72 || (sameNumbers && similarity >= 0.45);
}

function hasNegation(text: string): boolean {
  return /\b(no|not|never|none|kein|keine|ohne|nicht)\b/i.test(text);
}

function extractNumbers(text: string): string[] {
  return text.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
}

function findContradictionNote(claim: string, evidence: string): string | undefined {
  const claimNumbers = extractNumbers(claim);
  const evidenceNumbers = extractNumbers(evidence);
  if (claimNumbers.length > 0 && evidenceNumbers.length > 0 && claimNumbers.join("|") !== evidenceNumbers.join("|")) {
    return `mentions ${evidenceNumbers.join(", ")} instead of ${claimNumbers.join(", ")}`;
  }

  if (hasNegation(claim) !== hasNegation(evidence)) {
    return "uses opposite polarity or negation";
  }

  return undefined;
}

export function buildClaimsFromSources(
  query: string,
  sources: ResearchSourceRecord[],
  maxClaims: number
): { claims: ResearchClaim[]; contradictions: ResearchContradiction[]; coverage: { well_supported: number; weakly_supported: number; conflicting: number } } {
  const candidates: ResearchClaim[] = [];
  const contradictions: ResearchContradiction[] = [];

  for (const source of sources) {
    const sentences = splitSentences(source.text)
      .map((sentence) => ({ sentence, score: scoreEvidenceSentence(query, sentence) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.sentence.length - b.sentence.length)
      .slice(0, 4);

    for (const item of sentences) {
      const signature = claimSignature(item.sentence);
      if (!signature) {
        continue;
      }

      const existing = candidates.find((candidate) => areLikelySameClaim(candidate.claim, item.sentence));
      if (existing) {
        if (!existing.support.some((support) => support.source_id === source.source_id)) {
          existing.support.push({
            source_id: source.source_id,
            evidence: item.sentence
          });
        }
        if (item.sentence.length < existing.claim.length) {
          existing.claim = item.sentence;
        }
        continue;
      }

      candidates.push({
        id: `claim_${candidates.length + 1}`,
        claim: item.sentence,
        confidence: "low",
        support: [
          {
            source_id: source.source_id,
            evidence: item.sentence
          }
        ],
        contradictions: []
      });
    }
  }

  const claims = [...candidates]
    .sort((a, b) => b.support.length - a.support.length || a.claim.localeCompare(b.claim))
    .slice(0, maxClaims);

  for (const claim of claims) {
    const supportingSources = claim.support
      .map((support) => sources.find((source) => source.source_id === support.source_id))
      .filter((source): source is ResearchSourceRecord => Boolean(source));
    const averageTrust =
      supportingSources.length > 0
        ? supportingSources.reduce((sum, source) => sum + source.trust_score, 0) / supportingSources.length
        : 0;

    claim.confidence =
      claim.support.length >= 2 && averageTrust >= 75
        ? "high"
        : claim.support.length >= 1 && averageTrust >= 60
          ? "medium"
          : "low";

    for (const source of sources) {
      if (claim.support.some((support) => support.source_id === source.source_id)) {
        continue;
      }

      const sentences = splitSentences(source.text);
      const candidate = sentences.find((sentence) => {
        const overlap = uniqueTokens(sentence).filter((token) => claim.claim.toLowerCase().includes(token)).length;
        return overlap >= 3;
      });
      if (!candidate) {
        continue;
      }

      const note = findContradictionNote(claim.claim, candidate);
      if (!note) {
        continue;
      }

      claim.contradictions.push({
        source_id: source.source_id,
        note
      });
      contradictions.push({
        claim_id: claim.id,
        source_id: source.source_id,
        note
      });
    }
  }

  return {
    claims,
    contradictions,
    coverage: {
      well_supported: claims.filter((claim) => claim.confidence === "high").length,
      weakly_supported: claims.filter((claim) => claim.confidence !== "high").length,
      conflicting: claims.filter((claim) => claim.contradictions.length > 0).length
    }
  };
}
