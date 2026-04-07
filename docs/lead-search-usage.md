# Lead Search Usage

This document describes the implemented V5 lead workflow and how the three lead tools work in the MCP server.

Tool names:

- `find_leads`
- `extract_business_contacts`
- `resolve_business_website`

These tools are additive on top of the existing search, research, crawl, and sitemap stack.

## High-Level Flow

1. Use `find_leads` to build a candidate list from a business search query.
2. Use `resolve_business_website` to identify the official website for each candidate.
3. Use `extract_business_contacts` to pull names, emails, phone numbers, and contact-page evidence from the website.
4. Use `fetch_url_markdown` or `crawl_sitemap_targets` if you need deeper verification before outreach.

## `find_leads`

Intended purpose:

- Find companies, organizations, or lead records from a search query
- Return lead candidates with enough metadata to rank or triage them
- Prefer official sites and high-confidence business results

Supported input shape:

```json
{
  "query": "managed IT providers in Berlin",
  "limit": 10,
  "country": "DE",
  "language": "de",
  "source_strategy": "hybrid_public",
  "include_contact_pages": true,
  "include_evidence": true
}
```

Expected output shape:

```json
{
  "interpreted_query": {
    "category": "managed IT providers",
    "location": "Berlin",
    "postal_code": "10115",
    "free_text": "managed IT providers in Berlin"
  },
  "leads": [
    {
      "lead_id": "lead_123",
      "name": "Example GmbH",
      "website": "https://example.com",
      "location": "Berlin",
      "contact_pages": ["https://example.com/impressum"],
      "contacts": {
        "emails": ["info@example.com"],
        "phones": ["+4930123456"],
        "addresses": ["Musterstraße 1, 10115 Berlin"],
        "contact_people": [],
        "organization_names": ["Example GmbH"]
      },
      "sources": [
        {"url": "https://example.com", "source_type": "website"}
      ],
      "confidence": 88,
      "notes": ["Discovered via public web search."]
    }
  ],
  "stats": {
    "candidates_found": 10,
    "websites_resolved": 8,
    "contact_pages_scanned": 12,
    "leads_returned": 5,
    "duplicates_removed": 2,
    "errors": 0
  }
}
```

Example prompt:

```text
Find 10 managed IT providers in Berlin and prefer companies with an official website and a public contact page.
```

## `resolve_business_website`

Intended purpose:

- Resolve the official website for a business name or candidate lead
- Prefer the organization's own domain over directories, aggregators, or social profiles
- Return evidence that explains why the site was selected

Supported input shape:

```json
{
  "name": "Example GmbH",
  "location": "Berlin",
  "postal_code": "10115",
  "category": "IT services",
  "candidate_urls": ["https://example.com", "https://directory.example.org/example-gmbh"]
}
```

Expected output shape:

```json
{
  "best_website": "https://example.com",
  "alternatives": ["https://directory.example.org/example-gmbh"],
  "resolution_reason": "trust=84, relevance=72, url_heuristics=14, title_match=12",
  "confidence": 92
}
```

Example prompt:

```text
Resolve the official website for Example GmbH in Berlin and tell me why this domain is the best match.
```

## `extract_business_contacts`

Intended purpose:

- Extract business contact details from a website or page list
- Return contact people, email addresses, phone numbers, organization names, addresses, and source URLs
- Keep the evidence chain so the record can be verified later

Supported input shape:

```json
{
  "url": "https://example.com",
  "max_pages": 5,
  "prefer_paths": ["/impressum", "/kontakt"],
  "rendered": false
}
```

Expected output shape:

```json
{
  "site": {
    "final_url": "https://example.com",
    "title": "Example GmbH"
  },
  "contact_pages": [
    {"url": "https://example.com/impressum", "page_type": "impressum"}
  ],
  "contacts": {
    "emails": ["info@example.com"],
    "phones": ["+4930123456"],
    "addresses": ["Musterstraße 1, 10115 Berlin"],
    "contact_people": ["Ada Example"],
    "organization_names": ["Example GmbH"]
  },
  "impressum_found": true,
  "confidence": 90,
  "sources": [
    {"url": "https://example.com/impressum", "extracted_fields": ["emails", "phones", "addresses"]}
  ]
}
```

Example prompt:

```text
Extract the business contacts from this website and return only details that are publicly exposed on the contact or imprint pages.
```

## Recommended Lead Workflow

- Start with `find_leads` when you only have a market or category.
- Use `resolve_business_website` before contact extraction if the lead record does not already have a strong website.
- Use `extract_business_contacts` only on official sites or pages confirmed by `resolve_business_website`.
- If the site is large, use `crawl_sitemap_targets` to find the contact, team, about, legal notice, and support pages first.
- If a page renders content late, use `crawl_rendered` before extraction.

## Safety And Quality Notes

- Prefer official websites over directories and social profiles.
- Keep the evidence URLs with each lead or contact record.
- Deduplicate by business name, website domain, and contact email when possible.
- Do not guess contact details from unrelated pages if the site does not expose them clearly.
- The implementation is intentionally limited to publicly exposed business contacts and does not do private person enrichment.

## Practical Example

```text
Use find_leads to discover 10 MSPs in Munich, resolve the official website for each one, then extract business contacts from the contact and imprint pages.
```

That workflow should produce a candidate list, a verified website, and a structured contact record for each viable lead.
