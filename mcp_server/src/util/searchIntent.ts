import { normalizeWhitespace } from "./limits.js";

export interface SearchIntent {
  originalQuery: string;
  domain?: string;
  brand?: string;
  topic?: string;
  queryVariants: string[];
  languageVariants: string[];
}

const ENGLISH_TOPIC_HINTS = [
  "target audience",
  "market position",
  "competitors",
  "alternatives",
  "pricing",
  "features"
];

export function extractDomainFromQuery(query: string): string | undefined {
  const match = normalizeWhitespace(query)
    .match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);

  return match?.[1]?.toLowerCase();
}

function extractBrandFromDomain(domain?: string): string | undefined {
  if (!domain) {
    return undefined;
  }

  const labels = domain.split(".").filter(Boolean);
  if (labels.length === 0) {
    return undefined;
  }

  return labels[0]?.toLowerCase();
}

function extractTopic(query: string, domain?: string): string | undefined {
  const normalized = normalizeWhitespace(query);
  if (!domain) {
    return normalized || undefined;
  }

  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutDomain = normalized
    .replace(new RegExp(`\\b(?:https?:\\/\\/)?(?:www\\.)?${escapedDomain}\\b`, "ig"), "")
    .replace(/\s+/g, " ")
    .trim();

  return withoutDomain || undefined;
}

export function buildSearchIntent(query: string, requestedLanguage: string): SearchIntent {
  const originalQuery = normalizeWhitespace(query);
  const domain = extractDomainFromQuery(originalQuery);
  const brand = extractBrandFromDomain(domain);
  const topic = extractTopic(originalQuery, domain);
  const variants = new Set<string>([originalQuery]);

  if (domain) {
    if (topic) {
      variants.add(`site:${domain} ${topic}`);
      variants.add(`"${domain}" ${topic}`);
      if (brand) {
        variants.add(`"${brand}" ${topic}`);
        variants.add(`${brand} ${topic}`);
      }
    } else {
      variants.add(`site:${domain}`);
      variants.add(`"${domain}"`);
      if (brand) {
        variants.add(brand);
      }
    }
  }

  const languageVariants = new Set<string>([requestedLanguage]);
  const lowerTopic = topic?.toLowerCase() ?? "";
  if (ENGLISH_TOPIC_HINTS.some((hint) => lowerTopic.includes(hint))) {
    languageVariants.add("en");
  }

  return {
    originalQuery,
    domain,
    brand,
    topic,
    queryVariants: [...variants].filter(Boolean).slice(0, 6),
    languageVariants: [...languageVariants].filter(Boolean).slice(0, 2)
  };
}
