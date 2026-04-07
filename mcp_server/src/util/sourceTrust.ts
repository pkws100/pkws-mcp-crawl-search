import { z } from "zod";

export const sourceTypeValues = ["official", "government", "scientific", "major_media", "community", "unknown"] as const;
export type SourceType = (typeof sourceTypeValues)[number];

export const sourceTrustSignalsSchema = z.object({
  official_domain: z.boolean(),
  government_domain: z.boolean(),
  scientific_domain: z.boolean(),
  has_author: z.boolean(),
  has_published_at: z.boolean(),
  has_canonical: z.boolean(),
  boilerplate_ratio: z.number().min(0).max(1).optional()
});

export const sourceProfileSchema = z.object({
  source_type: z.enum(sourceTypeValues),
  trust_score: z.number().int().min(0).max(100),
  signals: sourceTrustSignalsSchema,
  notes: z.array(z.string())
});

export type SourceTrustSignals = z.infer<typeof sourceTrustSignalsSchema>;
export type SourceProfile = z.infer<typeof sourceProfileSchema>;

export interface SourceMetadataLike {
  canonical_url?: string;
  meta_description?: string;
  lang?: string;
  author?: string;
  published_at?: string;
  modified_at?: string;
  og_title?: string;
  og_description?: string;
}

export interface SourceQualityLike {
  content_quality_score?: number;
  boilerplate_ratio?: number;
  word_count?: number;
}

export interface BuildSourceProfileInput {
  url: string;
  title?: string;
  metadata?: SourceMetadataLike;
  quality?: SourceQualityLike;
}

const MAJOR_MEDIA_PATTERNS = [
  /(^|\.)reuters\.com$/i,
  /(^|\.)apnews\.com$/i,
  /(^|\.)bbc\./i,
  /(^|\.)nytimes\.com$/i,
  /(^|\.)theguardian\.com$/i,
  /(^|\.)wsj\.com$/i,
  /(^|\.)ft\.com$/i,
  /(^|\.)bloomberg\.com$/i
];

const SCIENTIFIC_HOST_PATTERNS = [
  /(^|\.)arxiv\.org$/i,
  /(^|\.)pubmed\.ncbi\.nlm\.nih\.gov$/i,
  /(^|\.)doi\.org$/i,
  /(^|\.)nature\.com$/i,
  /(^|\.)springer\.com$/i,
  /(^|\.)sciencedirect\.com$/i,
  /(^|\.)ieee\.org$/i,
  /(^|\.)acm\.org$/i
];

const COMMUNITY_PATTERNS = [
  /(^|\.)reddit\.com$/i,
  /(^|\.)stackoverflow\.com$/i,
  /(^|\.)stackexchange\.com$/i,
  /(^|\.)medium\.com$/i,
  /(^|\.)dev\.to$/i,
  /(^|\.)discourse\./i,
  /(^|\.)forum\./i
];

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isGovernmentHost(host: string): boolean {
  return /\.gov($|\.)/i.test(host) || /\.gouv\./i.test(host) || /\.gv\./i.test(host);
}

function isScientificHost(host: string): boolean {
  return /\.edu($|\.)/i.test(host) || /\.ac\.[a-z.]+$/i.test(host) || SCIENTIFIC_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function isMajorMediaHost(host: string): boolean {
  return MAJOR_MEDIA_PATTERNS.some((pattern) => pattern.test(host));
}

function isCommunityHost(host: string): boolean {
  return COMMUNITY_PATTERNS.some((pattern) => pattern.test(host));
}

function isOfficialHost(host: string, pathname: string): boolean {
  return /^(docs|developer|developers|support|help|api)\./i.test(host) || /\/(docs|guide|reference|manual|api|developers?)(\/|$)/i.test(pathname);
}

export function classifySourceType(url: string): SourceType {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (isGovernmentHost(host)) {
    return "government";
  }
  if (isScientificHost(host)) {
    return "scientific";
  }
  if (isMajorMediaHost(host)) {
    return "major_media";
  }
  if (isCommunityHost(host) || /\/(forum|community|discussion|questions?|threads?)\//i.test(pathname)) {
    return "community";
  }
  if (isOfficialHost(host, pathname)) {
    return "official";
  }

  return "unknown";
}

export function buildSourceProfile(input: BuildSourceProfileInput): SourceProfile {
  const parsed = new URL(input.url);
  const sourceType = classifySourceType(input.url);
  const quality = input.quality ?? {};
  const metadata = input.metadata ?? {};
  const signals: SourceTrustSignals = {
    official_domain: sourceType === "official",
    government_domain: sourceType === "government",
    scientific_domain: sourceType === "scientific",
    has_author: Boolean(metadata.author),
    has_published_at: Boolean(metadata.published_at),
    has_canonical: Boolean(metadata.canonical_url),
    boilerplate_ratio: quality.boilerplate_ratio
  };

  const notes: string[] = [];
  let score =
    sourceType === "government"
      ? 92
      : sourceType === "scientific"
        ? 88
        : sourceType === "official"
          ? 82
          : sourceType === "major_media"
            ? 72
            : sourceType === "community"
              ? 42
              : 55;

  if (parsed.protocol === "https:") {
    score += 2;
    notes.push("uses https");
  }

  if (signals.has_canonical) {
    score += 4;
    notes.push("has canonical url");
  }

  if (signals.has_author) {
    score += 4;
    notes.push("has author metadata");
  }

  if (signals.has_published_at) {
    score += 6;
    notes.push("has publication date");
  }

  if ((quality.word_count ?? 0) > 250) {
    score += 4;
    notes.push("has substantial text");
  } else if ((quality.word_count ?? 0) > 0 && (quality.word_count ?? 0) < 50) {
    score -= 10;
    notes.push("very short content");
  }

  if ((quality.content_quality_score ?? 0) >= 80) {
    score += 6;
    notes.push("high content quality");
  } else if ((quality.content_quality_score ?? 0) >= 60) {
    score += 3;
    notes.push("good content quality");
  } else if ((quality.content_quality_score ?? 0) > 0 && (quality.content_quality_score ?? 0) < 35) {
    score -= 8;
    notes.push("thin or noisy content");
  }

  if ((quality.boilerplate_ratio ?? 0) >= 0.45) {
    score -= 10;
    notes.push("high boilerplate ratio");
  } else if ((quality.boilerplate_ratio ?? 1) <= 0.15) {
    score += 4;
    notes.push("low boilerplate ratio");
  }

  if (/\/(tag|tags|search|results|archive|archives|category|categories|feed|print)(\/|$)/i.test(parsed.pathname)) {
    score -= 12;
    notes.push("looks like an index or low-value utility page");
  }

  if (sourceType === "community") {
    notes.push("community source should be cross-checked");
  } else if (sourceType === "unknown") {
    notes.push("source type is not strongly classifiable");
  } else {
    notes.push(`classified as ${sourceType}`);
  }

  return {
    source_type: sourceType,
    trust_score: clampScore(score),
    signals,
    notes
  };
}
