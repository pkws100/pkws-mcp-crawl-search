import * as cheerio from "cheerio";
import type { PageSnapshot } from "../tools/fetchUrlText.js";
import { normalizeWhitespace } from "./limits.js";
import type { BusinessContacts, ContactPage, ContactPageType } from "./leadTypes.js";

const DEFAULT_CONTACT_PATHS = ["/impressum", "/kontakt", "/contact", "/ueber-uns", "/about", "/team"];
const HIDDEN_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "[hidden]",
  "[aria-hidden='true']",
  "[style*='display:none' i]",
  "[style*='visibility:hidden' i]",
  ".hidden",
  ".sr-only"
].join(", ");
const CONTACT_PAGE_PATTERNS: Array<{ type: ContactPageType; pattern: RegExp }> = [
  { type: "impressum", pattern: /(impressum|imprint|legal)/i },
  { type: "kontakt", pattern: /(kontakt|contact|ansprechpartner|anfahrt)/i },
  { type: "about", pattern: /(ueber-uns|über-uns|about|company|unternehmen)/i },
  { type: "team", pattern: /(team|staff|people)/i }
];
const PERSON_LABEL_PATTERN = /\b(?:ansprechpartner(?:in)?|kontaktperson|inhaber(?:in)?|geschäftsführer(?:in)?|vertreten durch|owner|managing director)\b[:\s-]*([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]+){1,2})/gi;
const ADDRESS_PATTERN = /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{2,}(?:straße|str\.|weg|platz|gasse|allee|ring|ufer|chaussee)\s*\d+[a-zA-Z]?,?\s*\d{5}\s*[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]+)\b/gi;
export interface ContactExtraction {
  page: ContactPage;
  contacts: BusinessContacts;
  extractedFields: string[];
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => normalizeWhitespace(value)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function decodeUriText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function classifyContactPage(url: string, title?: string, text?: string): ContactPageType {
  const subject = `${decodeUriText(url)} ${title ?? ""} ${text ?? ""}`;
  for (const entry of CONTACT_PAGE_PATTERNS) {
    if (entry.pattern.test(subject)) {
      return entry.type;
    }
  }
  return "other";
}

function normalizeEmail(email: string): string | undefined {
  const normalized = email.trim().toLowerCase().replace(/^mailto:/i, "").replace(/[)>.,;]+$/g, "");
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizePhone(phone: string): string | undefined {
  const trimmed = phone.trim().replace(/^tel:/i, "");
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return undefined;
  }
  return `${hasPlus ? "+" : ""}${digits}`;
}

function parseJsonLdContacts(html: string): Partial<BusinessContacts> {
  const $ = cheerio.load(html);
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addresses = new Set<string>();
  const contactPeople = new Set<string>();
  const organizationNames = new Set<string>();

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) {
      return;
    }

    const visit = (value: unknown) => {
      if (!value) {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object") {
        return;
      }

      const item = value as Record<string, unknown>;
      const email = typeof item.email === "string" ? normalizeEmail(item.email) : undefined;
      if (email) {
        emails.add(email);
      }

      const telephone = typeof item.telephone === "string" ? normalizePhone(item.telephone) : undefined;
      if (telephone) {
        phones.add(telephone);
      }

      if (typeof item.name === "string") {
        organizationNames.add(normalizeWhitespace(item.name));
      }
      if (typeof item.legalName === "string") {
        organizationNames.add(normalizeWhitespace(item.legalName));
      }

      if (typeof item.contactPoint === "object") {
        visit(item.contactPoint);
      }

      if (typeof item.address === "object" && item.address) {
        const address = item.address as Record<string, unknown>;
        const composed = [
          typeof address.streetAddress === "string" ? address.streetAddress : undefined,
          typeof address.postalCode === "string" ? address.postalCode : undefined,
          typeof address.addressLocality === "string" ? address.addressLocality : undefined
        ].filter(Boolean).join(", ");
        if (composed) {
          addresses.add(normalizeWhitespace(composed));
        }
      }

    };

    try {
      visit(JSON.parse(raw));
    } catch {
      // ignore malformed json-ld blocks
    }
  });

  return {
    emails: dedupeSorted(emails),
    phones: dedupeSorted(phones),
    addresses: dedupeSorted(addresses),
    contact_people: dedupeSorted(contactPeople),
    organization_names: dedupeSorted(organizationNames)
  };
}

function loadVisibleDom(html: string): cheerio.CheerioAPI {
  const $ = cheerio.load(html);
  $(HIDDEN_SELECTOR).remove();
  return $;
}

export function extractContactsFromSnapshot(snapshot: PageSnapshot): ContactExtraction {
  const pageType = classifyContactPage(snapshot.final_url, snapshot.title, snapshot.text);
  const $ = loadVisibleDom(snapshot.html);
  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();
  const addressSet = new Set<string>();
  const personSet = new Set<string>();
  const organizationSet = new Set<string>();
  const extractedFields = new Set<string>();

  $("a[href^='mailto:']").each((_, element) => {
    const email = normalizeEmail($(element).attr("href") ?? "");
    if (email) {
      emailSet.add(email);
    }
  });

  $("a[href^='tel:']").each((_, element) => {
    const phone = normalizePhone($(element).attr("href") ?? "");
    if (phone) {
      phoneSet.add(phone);
    }
  });

  const visibleText = normalizeWhitespace($("body").text() || $.root().text());
  const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  for (const match of visibleText.match(emailPattern) ?? []) {
    const email = normalizeEmail(match);
    if (email) {
      emailSet.add(email);
    }
  }

  const phonePattern = /(?:\+?\d[\d\s()/.-]{6,}\d)/g;
  for (const match of visibleText.match(phonePattern) ?? []) {
    const phone = normalizePhone(match);
    if (phone) {
      phoneSet.add(phone);
    }
  }

  for (const match of visibleText.matchAll(ADDRESS_PATTERN)) {
    addressSet.add(normalizeWhitespace(match[1]));
  }

  for (const match of visibleText.matchAll(PERSON_LABEL_PATTERN)) {
    personSet.add(normalizeWhitespace(match[1]));
  }

  if (snapshot.title) {
    organizationSet.add(normalizeWhitespace(snapshot.title.split(/[-|–]/)[0] ?? snapshot.title));
  }
  if (snapshot.extracted.headings[0]?.text) {
    organizationSet.add(normalizeWhitespace(snapshot.extracted.headings[0].text));
  }
  if (snapshot.extracted.metadata.author) {
    organizationSet.add(normalizeWhitespace(snapshot.extracted.metadata.author));
  }

  const jsonLd = parseJsonLdContacts(snapshot.html);
  for (const email of jsonLd.emails ?? []) {
    emailSet.add(email);
  }
  for (const phone of jsonLd.phones ?? []) {
    phoneSet.add(phone);
  }
  for (const address of jsonLd.addresses ?? []) {
    addressSet.add(address);
  }
  for (const person of jsonLd.contact_people ?? []) {
    personSet.add(person);
  }
  for (const organization of jsonLd.organization_names ?? []) {
    organizationSet.add(organization);
  }

  const contacts: BusinessContacts = {
    emails: dedupeSorted(emailSet),
    phones: dedupeSorted(phoneSet),
    addresses: dedupeSorted(addressSet),
    contact_people: dedupeSorted(personSet),
    organization_names: dedupeSorted(organizationSet)
  };

  if (contacts.emails.length > 0) {
    extractedFields.add("emails");
  }
  if (contacts.phones.length > 0) {
    extractedFields.add("phones");
  }
  if (contacts.addresses.length > 0) {
    extractedFields.add("addresses");
  }
  if (contacts.contact_people.length > 0) {
    extractedFields.add("contact_people");
  }
  if (contacts.organization_names.length > 0) {
    extractedFields.add("organization_names");
  }

  return {
    page: {
      url: snapshot.final_url,
      page_type: pageType
    },
    contacts,
    extractedFields: [...extractedFields]
  };
}

export function mergeBusinessContacts(contacts: BusinessContacts[]): BusinessContacts {
  const merged: BusinessContacts = {
    emails: [],
    phones: [],
    addresses: [],
    contact_people: [],
    organization_names: []
  };

  for (const contact of contacts) {
    merged.emails.push(...contact.emails);
    merged.phones.push(...contact.phones);
    merged.addresses.push(...contact.addresses);
    merged.contact_people.push(...contact.contact_people);
    merged.organization_names.push(...contact.organization_names);
  }

  merged.emails = dedupeSorted(merged.emails);
  merged.phones = dedupeSorted(merged.phones);
  merged.addresses = dedupeSorted(merged.addresses);
  merged.contact_people = dedupeSorted(merged.contact_people);
  merged.organization_names = dedupeSorted(merged.organization_names);
  return merged;
}

export function buildContactCandidateUrls(
  homeUrl: string,
  html: string,
  preferPaths: string[] = [],
  maxPages = 5
): string[] {
  const parsed = new URL(homeUrl);
  const candidates = new Set<string>();
  const allPaths = [...preferPaths, ...DEFAULT_CONTACT_PATHS];

  for (const path of allPaths) {
    try {
      candidates.add(new URL(path, parsed.origin).toString());
    } catch {
      // ignore invalid preferred path
    }
  }

  const $ = cheerio.load(html);
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    try {
      const resolved = new URL(href, homeUrl);
      resolved.hash = "";
      if (resolved.origin !== parsed.origin) {
        return;
      }
      if (CONTACT_PAGE_PATTERNS.some((entry) => entry.pattern.test(`${resolved.pathname} ${$(element).text()}`))) {
        candidates.add(resolved.toString());
      }
    } catch {
      // ignore invalid links
    }
  });

  return [...candidates].slice(0, maxPages);
}

export function computeContactConfidence(input: {
  impressumFound: boolean;
  pageCount: number;
  contacts: BusinessContacts;
  hasWebsite: boolean;
}): number {
  let score = input.hasWebsite ? 35 : 15;
  if (input.impressumFound) {
    score += 30;
  }
  if (input.contacts.emails.length > 0) {
    score += 15;
  }
  if (input.contacts.phones.length > 0) {
    score += 10;
  }
  if (input.contacts.addresses.length > 0) {
    score += 10;
  }
  if (input.contacts.contact_people.length > 0) {
    score += 5;
  }
  score += Math.min(10, input.pageCount * 2);
  return Math.max(0, Math.min(100, score));
}
