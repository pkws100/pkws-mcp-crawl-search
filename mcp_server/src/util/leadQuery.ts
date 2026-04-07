import { normalizeWhitespace } from "./limits.js";
import type { InterpretedLeadQuery } from "./leadTypes.js";

const PERSON_PREFIXES = ["herr", "frau", "dr", "prof"];
const DIRECTORY_TERMS = ["branchenbuch", "telefonbuch", "gelbe seiten", "dasoertliche", "11880", "cylex"];

function stripCountPrefix(value: string): string {
  return value.replace(/^\s*\d{1,3}\s+/, "").trim();
}

function cleanupFragment(value: string): string | undefined {
  const cleaned = normalizeWhitespace(value)
    .replace(/^(suche|finde|find|show)\s+/i, "")
    .replace(/\b(im bereich|in der nähe|in der naehe|im raum|umkreis)\b.*$/i, "")
    .trim();
  return cleaned || undefined;
}

export function interpretLeadQuery(query: string): InterpretedLeadQuery {
  const normalized = normalizeWhitespace(query);
  const lower = normalized.toLowerCase();
  const postalCode = normalized.match(/\b\d{5}\b/)?.[0];

  let location: string | undefined;
  const locationMatch =
    normalized.match(/\b(?:im bereich|im raum|umkreis|in)\s+(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+)/i) ??
    normalized.match(/\b(?:in|raum|umkreis)\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+){0,2})/i);
  if (locationMatch) {
    location = locationMatch[2] ?? locationMatch[1];
  } else if (postalCode) {
    const afterPostal = normalized.match(new RegExp(`\\b${postalCode}\\b\\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+(?:\\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+){0,2})`));
    location = afterPostal?.[1];
  }

  const stripped = stripCountPrefix(normalized);
  const categoryFragment = stripped
    .replace(/\b\d{5}\b/g, "")
    .replace(location ? new RegExp(`\\b${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : /$^/, "")
    .replace(/\b(?:im bereich|im raum|umkreis|in|bei|nahe|nähe)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  let category = cleanupFragment(categoryFragment);
  let person: string | undefined;
  let organization: string | undefined;

  const quoted = normalized.match(/["“”']([^"“”']+)["“”']/);
  if (quoted) {
    if (PERSON_PREFIXES.some((prefix) => lower.includes(prefix))) {
      person = quoted[1];
    } else {
      organization = quoted[1];
    }
  }

  if (!person && /\b(person|ansprechpartner|kontaktperson)\b/i.test(lower)) {
    const maybePerson = normalized.match(/\b(?:person|ansprechpartner|kontaktperson)\b\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+){0,2})/i);
    person = maybePerson?.[1];
  }

  if (!organization && /\b(firma|unternehmen|praxis|kanzlei|studio)\b/i.test(lower)) {
    const maybeOrg = normalized.match(/\b(?:firma|unternehmen|praxis|kanzlei|studio)\b\s+([A-ZÄÖÜ0-9][^,]+)$/i);
    organization = maybeOrg?.[1]?.trim();
  }

  if (organization) {
    category = undefined;
  }

  return {
    category: category || undefined,
    location,
    postal_code: postalCode,
    person,
    organization,
    free_text: normalized
  };
}

export function generateLeadSearchQueries(
  interpreted: InterpretedLeadQuery,
  sourceStrategy: "hybrid_public"
): string[] {
  const coreParts = [
    interpreted.organization ?? interpreted.person ?? interpreted.category,
    interpreted.postal_code,
    interpreted.location
  ].filter(Boolean);
  const core = coreParts.join(" ").trim() || interpreted.free_text;

  const queries = new Set<string>([core]);

  if (sourceStrategy === "hybrid_public") {
    queries.add(`${core} webseite kontakt`);
    queries.add(`${core} impressum`);
    for (const directoryTerm of DIRECTORY_TERMS.slice(0, 4)) {
      queries.add(`${core} ${directoryTerm}`);
    }
  }

  return [...queries].filter(Boolean).slice(0, 6);
}

export function buildResolutionQuery(input: {
  name: string;
  location?: string;
  postalCode?: string;
  category?: string;
}): string {
  return [input.name, input.category, input.postalCode, input.location, "webseite kontakt"]
    .filter(Boolean)
    .join(" ")
    .trim();
}
