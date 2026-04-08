# PKWS MCP Crawl Search Overview

`pkws-mcp-crawl-search` is a Node.js/TypeScript MCP server for search, crawl, extraction, and research workflows. It runs the MCP endpoint on fixed port `8789`, keeps SearXNG internal to Docker, and supports both static fetches and JS-rendered crawling.

## What It Provides

- `web_search` for internal SearXNG-backed web search
- `fetch_url_text` for plain text extraction
- `fetch_url_markdown` for LLM-friendly Markdown plus metadata
- `fetch_url_chunks` for section-aware chunking
- `inspect_sitemap` for sitemap inspection and URL classification
- `crawl_sitemap_targets` for selecting sitemap URLs and fetching them as text, Markdown, or chunks
- `crawl_static` for bounded crawl traversal
- `crawl_rendered` for Playwright-based rendered pages
- `discover_site` for site discovery and navigation hints
- `find_leads`
- `extract_business_contacts`
- `resolve_business_website`

## Quick Start

1. Copy the example environment file if you want custom settings:

```bash
cp .env.example .env
```

2. Start the stack:

```bash
docker compose up -d --build
```

3. Verify health:

```bash
curl http://localhost:8789/health
```

The health endpoint should return:

```text
ok
```

## Network And Ports

- MCP endpoint: `http://localhost:8789/mcp`
- LAN endpoint: `http://<HOST-IP>:8789/mcp`
- Optional legacy stream endpoint: `http://<HOST-IP>:8789/mcp/stream`
- SearXNG is internal only and does not publish a host port

## Environment Variables

The server works with safe defaults, but these are the key overrides:

- `MCP_PORT=8789`
- `MCP_BIND_HOST=0.0.0.0`
- `MCP_BIND=` legacy alias for `MCP_BIND_HOST`
- `MCP_ALLOWED_HOSTS=` comma-separated extra allowed hostnames
- `MCP_LOG_REQUESTS=false`
- `MCP_ENABLE_LEGACY_SSE=true`
- `MCP_LEGACY_SSE_PATH=/mcp/stream`
- `SEARXNG_BASE=http://searxng:8080`
- `MCP_AUTH_TOKEN=` optional bearer token
- `BLOCK_PRIVATE_NET=true`
- `ALLOW_PRIVATE_NET=false`
- `MAX_HTML_BYTES=2000000`
- `SEARXNG_SECRET=change-me`
- `WEB_SEARCH_TOTAL_BUDGET_MS=10000`
- `WEB_SEARCH_ATTEMPT_TIMEOUT_MS=3000`
- `WEB_SEARCH_MAX_VARIANTS=4`

If `MCP_AUTH_TOKEN` is set, every `/mcp` and `/health` request must include:

```http
Authorization: Bearer <token>
```

## Connection Pattern

Use the same MCP URL and auth pattern in every client:

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

If you are connecting from the same machine, `localhost` is fine. For another machine on the LAN, use the host IP.
`/mcp` auto-negotiates between streamable and JSON-compatible MCP behavior; `/mcp/stream` is the optional explicit legacy route.

## Recommended Tool Flow

- Use `web_search` to discover public sources.
- Use `discover_site` or `inspect_sitemap` to understand a site before crawling deeply.
- Use `crawl_sitemap_targets` when a sitemap is available and you want a focused fetch plan.
- Use `fetch_url_markdown` when the model should consume a clean page summary.
- Use `fetch_url_chunks` when a page is long and needs section-level reading.
- Use `crawl_rendered` when exactly one page depends on JavaScript for content. The tool prefers `url` and also tolerates `start_url` as a compatibility alias.
- Use `crawl_static` when you need bounded multi-page traversal with `start_url`.

## Security Defaults

- Private, loopback, link-local, and unique-local targets are blocked by default.
- Redirects are re-validated before follow-up requests.
- No login flow, cookies, or credential forwarding is used in v1/v2 crawl paths.
- Logging should stay metadata-only and never print page bodies or tokens.

## Troubleshooting

- If `web_search` returns `403`, check the SearXNG container settings first. The internal SearXNG instance must allow `json` in `search.formats`.
- This repo mounts `searxng/settings.yml` into the SearXNG container and expects that file to stay in sync with Compose.
- A second common cause for `403` is SearXNG bot-detection rejecting API-like headers. The MCP server now sends browser-like `Accept` and `Accept-Language` headers to reduce false positives.
- If `web_search` returns `[]` for a brand or domain query, the server now retries internal search rewrites and may fall back to a direct public homepage fetch. A remaining empty result usually means the configured search engines or the target site provide too little public context.
- The `/mcp` endpoint now auto-negotiates between session-aware Streamable HTTP and a JSON-compatible MCP mode for clients that do not send the stricter SSE-oriented `Accept` headers.
- The optional `/mcp/stream` endpoint preserves the explicit legacy/session-aware Streamable HTTP behavior.
- `web_search` uses a fixed total budget and shorter per-attempt timeouts to avoid long-running search bursts that can lead clients to close the connection.
- After changing SearXNG settings, rebuild the stack with `docker compose up -d --build`.

## Lead Search Workflow

The lead-search workflow uses the same MCP endpoint and auth model. Example usage patterns are documented in [lead-search-usage.md](./lead-search-usage.md). The lead tools are:

- `find_leads`
- `extract_business_contacts`
- `resolve_business_website`
