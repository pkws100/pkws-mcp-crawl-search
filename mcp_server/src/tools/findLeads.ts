import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { executeExtractBusinessContacts } from "./extractBusinessContacts.js";
import { executeResolveBusinessWebsite } from "./resolveBusinessWebsite.js";
import { executeWebSearch, type WebSearchResult } from "./webSearch.js";
import { generateLeadSearchQueries, interpretLeadQuery } from "../util/leadQuery.js";
import {
  businessContactsSchema,
  interpretedLeadQuerySchema,
  leadSchema,
  leadSourceSchema,
  type BusinessContacts
} from "../util/leadTypes.js";
import { normalizeWhitespace } from "../util/limits.js";
import type { LookupFn } from "../util/ssrfGuard.js";

const DIRECTORY_PATTERN = /(gelbeseiten|11880|dasoertliche|branchenbuch|telefonbuch|cylex|yelp|meinestadt|werkenntdenbesten|golocal)/i;

export const findLeadsInputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
  country: z.string().min(2).max(8).default("DE"),
  language: z.string().min(2).max(16).default("de"),
  source_strategy: z.enum(["hybrid_public"]).default("hybrid_public"),
  include_contact_pages: z.boolean().default(true),
  include_evidence: z.boolean().default(true)
});

export const findLeadsResultSchema = z.object({
  interpreted_query: interpretedLeadQuerySchema,
  leads: z.array(leadSchema),
  stats: z.object({
    candidates_found: z.number().int().nonnegative(),
    websites_resolved: z.number().int().nonnegative(),
    contact_pages_scanned: z.number().int().nonnegative(),
    leads_returned: z.number().int().nonnegative(),
    duplicates_removed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative()
  })
});

export type FindLeadsInput = z.infer<typeof findLeadsInputSchema>;
export type FindLeadsResult = z.infer<typeof findLeadsResultSchema>;

interface LeadCandidateGroup {
  name: string;
  location?: string;
  postalCode?: string;
  category?: string;
  candidateUrls: string[];
  sources: Array<z.infer<typeof leadSourceSchema>>;
  notes: string[];
}

function createLeadId(value: string): string {
  return `lead_${createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function classifySourceType(url: string): "website" | "directory" | "search" {
  return DIRECTORY_PATTERN.test(url) ? "directory" : "search";
}

function inferNameFromResult(result: WebSearchResult[number], location?: string): string | undefined {
  const parts = result.title
    .split(/\s+[|\-–:]\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const candidates = [...parts, normalizeWhitespace(result.title)];
  for (const candidate of candidates) {
    const cleaned = candidate
      .replace(/\b(impressum|kontakt|contact|homepage|offizielle website|webseite|telefonbuch|branchenbuch)\b/gi, "")
      .replace(location ? new RegExp(`\\b${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : /$^/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 3) {
      return cleaned;
    }
  }

  try {
    const parsed = new URL(result.url);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

function mergeCandidate(groupMap: Map<string, LeadCandidateGroup>, candidate: LeadCandidateGroup) {
  const key = normalizeWhitespace(`${candidate.name} ${candidate.location ?? ""}`).toLowerCase();
  const existing = groupMap.get(key);
  if (!existing) {
    groupMap.set(key, {
      ...candidate,
      candidateUrls: [...new Set(candidate.candidateUrls)],
      sources: candidate.sources,
      notes: candidate.notes
    });
    return;
  }

  existing.candidateUrls = [...new Set([...existing.candidateUrls, ...candidate.candidateUrls])];
  existing.sources = [
    ...existing.sources,
    ...candidate.sources.filter(
      (source) =>
        !existing.sources.some((existingSource) => existingSource.url === source.url && existingSource.source_type === source.source_type)
    )
  ];
  existing.notes = [...new Set([...existing.notes, ...candidate.notes])];
}

function dedupeLeads(leads: z.infer<typeof leadSchema>[]): z.infer<typeof leadSchema>[] {
  const seen = new Set<string>();
  const deduped: z.infer<typeof leadSchema>[] = [];

  for (const lead of leads) {
    const key = normalizeWhitespace(`${lead.website ?? ""}|${lead.name}|${lead.location ?? ""}`).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(lead);
  }

  return deduped;
}

function rankLead(lead: z.infer<typeof leadSchema>): number {
  let score = lead.confidence;
  if (lead.website) {
    score += 10;
  }
  if (lead.contacts.emails.length > 0) {
    score += 10;
  }
  if (lead.contacts.phones.length > 0) {
    score += 8;
  }
  if (lead.contact_pages.length > 0) {
    score += 4;
  }
  return score;
}

export async function executeFindLeads(
  input: FindLeadsInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    searchFetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<FindLeadsResult> {
  const interpreted = interpretLeadQuery(input.query);
  const queries = generateLeadSearchQueries(interpreted, input.source_strategy);
  const aggregatedResults: WebSearchResult = [];
  const seenUrls = new Set<string>();
  let errors = 0;

  for (const query of queries) {
    try {
      const results = await executeWebSearch(
        {
          query,
          limit: Math.min(10, Math.max(5, input.limit)),
          language: input.language,
          time_range: "year"
        },
        config,
        options?.searchFetchImpl ?? options?.fetchImpl,
        options?.lookupFn
      );

      for (const result of results) {
        if (seenUrls.has(result.url)) {
          continue;
        }
        seenUrls.add(result.url);
        aggregatedResults.push(result);
      }
    } catch {
      errors += 1;
    }
  }

  const candidateGroups = new Map<string, LeadCandidateGroup>();
  for (const result of aggregatedResults) {
    const name = inferNameFromResult(result, interpreted.location);
    if (!name) {
      continue;
    }
    mergeCandidate(candidateGroups, {
      name,
      location: interpreted.location,
      postalCode: interpreted.postal_code,
      category: interpreted.category,
      candidateUrls: [result.url],
      sources: [
        {
          url: result.url,
          source_type: classifySourceType(result.url)
        }
      ],
      notes: [DIRECTORY_PATTERN.test(result.url) ? "Discovered via directory-like search result." : "Discovered via public web search."]
    });
  }

  const candidates = [...candidateGroups.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, Math.max(input.limit * 2, input.limit));

  const leads: z.infer<typeof leadSchema>[] = [];
  let websitesResolved = 0;
  let contactPagesScanned = 0;

  for (const candidate of candidates) {
    try {
      const resolved = await executeResolveBusinessWebsite(
        {
          name: candidate.name,
          location: candidate.location,
          postal_code: candidate.postalCode,
          category: candidate.category,
          candidate_urls: candidate.candidateUrls
        },
        config,
        {
          fetchImpl: options?.fetchImpl,
          searchFetchImpl: options?.searchFetchImpl,
          lookupFn: options?.lookupFn
        }
      );

      const website = resolved.best_website;
      if (website) {
        websitesResolved += 1;
      }

      const contacts: BusinessContacts = {
        emails: [],
        phones: [],
        addresses: [],
        contact_people: [],
        organization_names: []
      };
      let contactPages: string[] = [];
      let contactConfidence = 0;
      let contactSources: Array<{ url: string; extracted_fields?: string[] }> = [];

      if (website && input.include_contact_pages) {
        const extracted = await executeExtractBusinessContacts(
          {
            url: website,
            max_pages: 5,
            rendered: false
          },
          config,
          {
            fetchImpl: options?.fetchImpl,
            lookupFn: options?.lookupFn
          }
        );
        contacts.emails.push(...extracted.contacts.emails);
        contacts.phones.push(...extracted.contacts.phones);
        contacts.addresses.push(...extracted.contacts.addresses);
        contacts.contact_people.push(...extracted.contacts.contact_people);
        contacts.organization_names.push(...extracted.contacts.organization_names);
        contactPages = extracted.contact_pages.map((page) => page.url);
        contactSources = extracted.sources;
        contactConfidence = extracted.confidence;
        contactPagesScanned += extracted.contact_pages.length;
      }

      const confidence = Math.max(0, Math.min(100, Math.round((resolved.confidence + contactConfidence) / (contactConfidence > 0 ? 2 : 1))));
      const lead = leadSchema.parse({
        lead_id: createLeadId(website ?? `${candidate.name}|${candidate.location ?? ""}`),
        name: candidate.name,
        category: candidate.category,
        location: candidate.location,
        postal_code: candidate.postalCode,
        website,
        contact_pages: contactPages,
        contacts: businessContactsSchema.parse({
          emails: [...new Set(contacts.emails)],
          phones: [...new Set(contacts.phones)],
          addresses: [...new Set(contacts.addresses)],
          contact_people: [...new Set(contacts.contact_people)],
          organization_names: [...new Set(contacts.organization_names)]
        }),
        sources: [
          ...candidate.sources,
          ...(website
            ? [
                {
                  url: website,
                  source_type: "website" as const
                }
              ]
            : []),
          ...(input.include_evidence
            ? contactSources.map((source) => ({
                url: source.url,
                source_type: "website" as const,
                extracted_fields: source.extracted_fields
              }))
            : [])
        ],
        confidence,
        notes: [
          ...candidate.notes,
          resolved.resolution_reason,
          ...(website ? [] : ["No likely official website could be resolved."])
        ]
      });
      leads.push(lead);
    } catch {
      errors += 1;
    }
  }

  const deduped = dedupeLeads(leads)
    .sort((a, b) => rankLead(b) - rankLead(a) || a.name.localeCompare(b.name))
    .slice(0, input.limit);

  return findLeadsResultSchema.parse({
    interpreted_query: interpreted,
    leads: deduped,
    stats: {
      candidates_found: candidates.length,
      websites_resolved: websitesResolved,
      contact_pages_scanned: contactPagesScanned,
      leads_returned: deduped.length,
      duplicates_removed: Math.max(0, leads.length - deduped.length),
      errors
    }
  });
}
