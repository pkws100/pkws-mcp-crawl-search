# pkws-mcp-crawl-search

Node.js/TypeScript MCP server for local-network search and crawling. The stack exposes a single MCP endpoint on port `8789`, keeps SearXNG internal to Docker, and supports both static HTML extraction and JavaScript-rendered crawling via Playwright.

## Features
- MCP endpoint at `http://<HOST-IP>:8789/mcp`
- Health endpoint at `http://<HOST-IP>:8789/health`
- Internal SearXNG-backed `web_search`
- `fetch_url_text` for direct text extraction
- `fetch_url_markdown` for LLM-friendly Markdown plus metadata
- `fetch_url_chunks` for section-aware chunk extraction
- `find_leads` for end-to-end business lead discovery from free-text user queries
- `extract_business_contacts` for impressum/contact-page extraction of public business contact data
- `resolve_business_website` for choosing the most likely official website over directory candidates
- `inspect_sitemap` for sitemap indexes, urlsets, and grouped target discovery
- `crawl_sitemap_targets` for focused crawling from sitemap-selected URLs
- `crawl_static` for bounded BFS crawling with robots support
- `crawl_rendered` for JS-rendered pages with Chromium
- `fetch_document_text` for PDF-first document extraction
- `search_and_extract` for combined search, reranking, and extraction
- `source_profile` for trust and source-quality scoring
- `research_sources` for trust-aware source packs
- `research_claims` for evidence-backed claims and contradiction detection
- `deep_research` for evidence-first multi-source research
- `discover_site` for sitemap/navigation/feed discovery
- Security-by-default SSRF protection, byte caps, timeouts, and optional bearer auth

## Project Layout
- `docker-compose.yml`
- `.env.example`
- `AGENTS.md`
- `TASKS.md`
- `docs/`
- `mcp_server/`

## Setup
```bash
docker compose up -d --build
curl http://localhost:8789/health
```

Expected response:

```text
ok
```

## Environment
The stack starts with safe defaults even without a local `.env`. If you want to override settings, create one from the example:

```bash
cp .env.example .env
```

- `MCP_PORT=8789`
- `MCP_BIND=0.0.0.0`
- `SEARXNG_BASE=http://searxng:8080`
- `MCP_AUTH_TOKEN=` optional bearer token
- `BLOCK_PRIVATE_NET=true`
- `ALLOW_PRIVATE_NET=false`
- `MAX_HTML_BYTES=2000000`
- `SEARXNG_SECRET=change-me`
- `WEB_SEARCH_TOTAL_BUDGET_MS=10000`
- `WEB_SEARCH_ATTEMPT_TIMEOUT_MS=3000`
- `WEB_SEARCH_MAX_VARIANTS=4`

## MCP Client Example
Example `mcp.json` for LM Studio or a similar MCP-capable client:

```json
{
  "mcpServers": {
    "pkws-tools": {
      "url": "http://<HOST-IP>:8789/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}
```

If `MCP_AUTH_TOKEN` is empty, omit the `Authorization` header.

## Tool Usage Pattern
- Start with `web_search` to discover relevant public pages.
- Use `find_leads` when the user wants businesses or organizations for a location/category query such as `20 Friseure 96515 Sonneberg`.
- Use `resolve_business_website` when a lead candidate came from a directory or ambiguous search result and the model should prefer an official domain.
- Use `extract_business_contacts` after website resolution to pull public emails, phones, addresses, and impressum/contact evidence.
- Use `search_and_extract` when you want search plus extraction in one step.
- Use `source_profile` when you want to vet a single source before trusting it heavily.
- Use `research_sources` to build a curated source pack with trust scoring and optional sitemap candidates.
- Use `research_claims` to turn selected sources into claims, support, and contradictions.
- Use `deep_research` when you want an evidence-first research pass that prefers trustworthy sources and surfaces conflicts.
- Use `discover_site` when you first need to understand a site structure.
- Use `inspect_sitemap` when a site exposes sitemaps and you want structured URL discovery.
- Follow with `crawl_sitemap_targets` to fetch only the sitemap URLs that match your content goal.
- Use `fetch_url_text` for static content pages.
- Use `fetch_url_markdown` when the model should read clean, structured content.
- Use `fetch_url_chunks` for long pages that should be read section by section.
- Use `fetch_document_text` for PDF or other document-style links returned by search.
- Use `crawl_rendered` for exactly one page that loads important content through JavaScript. Prefer `url`, though `start_url` is also accepted as a compatibility alias.
- Use `crawl_static` when you need bounded multi-page traversal on the same site with `start_url`.

## V2 Tool Notes
- `fetch_url_markdown` returns Markdown, headings, links, and page metadata such as canonical URL and content hash.
- `fetch_url_chunks` returns semantically chunked page content with heading paths and stable chunk IDs.
- `discover_site` surfaces important pages, navigation links, sitemaps, RSS feeds, and login/search hints.
- `crawl_static` now also supports include/exclude filters and dedupe controls for cleaner crawl results.

## V3 Tool Notes
- `inspect_sitemap` resolves sitemap indexes and urlsets, follows nested sitemaps, and groups URLs by inferred type such as `docs`, `blog`, `product`, `category`, and `policy`.
- `crawl_sitemap_targets` filters sitemap entries by type and patterns, then fetches the selected targets as `text`, `markdown`, or `chunks`.
- `search_and_extract` runs `web_search`, reranks hits, and returns extracted content plus additive relevance and quality signals.
- `fetch_document_text` extracts text from PDF documents and also handles document-like plain text responses returned from download links.
- `fetch_url_markdown`, `fetch_url_chunks`, `crawl_static`, and `search_and_extract` now return content quality signals to help LLMs prioritize cleaner sources.

## V4 Research Notes
- `source_profile` classifies sources as `official`, `government`, `scientific`, `major_media`, `community`, or `unknown` and returns transparent trust signals instead of a black-box verdict.
- `research_sources` combines search, extraction, profiling, and optional sitemap discovery to build a higher-quality source pack before synthesis.
- `research_claims` turns prepared sources into structured claims with concrete `source_id` support references and explicit contradiction tracking.
- `deep_research` orchestrates the full evidence-first workflow: search, trust profiling, optional sitemap deepening for stronger primary sources, dedupe, and claim generation.
- The research layer is additive. Existing crawl and extraction tools still work directly, while the new research tools help models avoid drifting into weak or low-value sources.

## V5 Lead Notes
- `find_leads` interprets a free-text lead query, generates hybrid public search patterns, resolves likely websites, scans public contact pages, and returns ranked leads with evidence and confidence.
- `extract_business_contacts` prioritizes German `impressum` and `kontakt` paths, then extracts publicly exposed business emails, phone numbers, addresses, organization names, and contact persons.
- `resolve_business_website` ranks official domains above directory-style URLs by combining trust, relevance, title matching, and URL heuristics.
- Lead extraction is limited to publicly exposed business contacts. The server does not do private-person enrichment or social scraping.

## Docs
- [docs/overview.md](./docs/overview.md)
- [docs/claude-code.md](./docs/claude-code.md)
- [docs/chatgpt.md](./docs/chatgpt.md)
- [docs/lm-studio.md](./docs/lm-studio.md)
- [docs/lead-search-usage.md](./docs/lead-search-usage.md)

## Security Notes
- SSRF protection blocks localhost, RFC1918, link-local, loopback, and unique-local targets by default.
- Redirect destinations are validated again before each follow-up request.
- `ALLOW_PRIVATE_NET=true` is the only supported override for private network access.
- Host headers are validated against the local bind address, localhost aliases, and machine hostname to reduce DNS-rebinding risk on LAN deployments.
- The server logs metadata only and never writes full page contents or auth tokens to logs.

## Troubleshooting
- If `web_search` returns `403`, the most common cause is that SearXNG is running without `json` enabled in `search.formats`.
- A second common cause is SearXNG bot-detection rejecting API-style requests; this repo now sends browser-like `Accept` and `Accept-Language` headers to reduce that risk.
- If `web_search` returns `[]` for a domain or brand query, the server now retries internal query variants such as `site:domain.tld topic` and may fall back to a direct public homepage fetch before returning an empty array.
- Even with the fallback, `web_search` can still return `[]` when neither SearXNG nor the target site exposes enough public content for a minimally useful result.
- The MCP endpoint now keeps Streamable HTTP sessions alive for follow-up calls. This is especially important for LM Studio, which tends to make several `web_search` calls back-to-back in one session.
- `web_search` is intentionally budgeted with short per-attempt timeouts and a fixed total runtime budget so repeated brand/domain searches do not stall the client connection.
- If a model confuses `crawl_rendered` with `crawl_static`, `crawl_rendered` now tolerates `start_url` as an alias for `url` and ignores harmless crawl-only fields like `max_pages`. It still renders exactly one page.
- After changing SearXNG settings, rebuild and restart the stack with `docker compose up -d --build`.
- If LM Studio reports `MCP error -32602` about `structuredContent` expecting a record, update to a build where array-returning tools such as `web_search` are returned via `content` only and do not send array values in `structuredContent`.

## Verification
Run inside the project:

```bash
cd mcp_server
npm test
```

Then validate Compose:

```bash
docker compose up -d --build
curl http://localhost:8789/health
```

## Notes
- SearXNG is intentionally not exposed on a host port.
- Port `8789` is fixed by design.
