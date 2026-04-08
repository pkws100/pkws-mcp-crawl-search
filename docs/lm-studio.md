# LM Studio Setup

LM Studio can connect to this repo as an MCP server using the fixed HTTP endpoint exposed by the Docker stack.

## Start The Server

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:8789/health
```

The health endpoint should return `ok`.

## MCP Server Entry

Use the repo's MCP endpoint directly:

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

Notes:

- Replace `<HOST-IP>` with `localhost` when LM Studio runs on the same machine as Docker.
- Omit the `headers` block when `MCP_AUTH_TOKEN` is empty.
- Keep the server on `8789`; the port is fixed by design.
- `/mcp` is the recommended endpoint and now auto-negotiates between the stricter streamable transport and a JSON-compatible MCP mode used by other clients such as OpenWebUI.
- If you want an explicit legacy/session-oriented route for LM Studio, set the URL to `http://<HOST-IP>:8789/mcp/stream`.
- `web_search` depends on the internal SearXNG container, so after SearXNG config changes you should restart with `docker compose up -d --build`.
- `web_search` still returns a plain array of `{ title, url, snippet }`, but for domain and brand queries it may internally try extra query variants and a direct public-site fallback before returning `[]`.
- The MCP endpoint uses session-aware Streamable HTTP handling so LM Studio can reuse one initialized session for several follow-up tool calls.
- `web_search` is deliberately time-budgeted. Short per-attempt timeouts and a fixed total search budget reduce the chance that LM Studio closes the client connection during repeated follow-up searches.

## Relevant Environment Variables

- `MCP_BIND_HOST=0.0.0.0`
- `MCP_BIND=` legacy alias for `MCP_BIND_HOST`
- `MCP_ALLOWED_HOSTS=` comma-separated extra allowed hostnames
- `MCP_LOG_REQUESTS=false`
- `MCP_ENABLE_LEGACY_SSE=true`
- `MCP_LEGACY_SSE_PATH=/mcp/stream`
- `MCP_AUTH_TOKEN=`

## Curl Checks

Reachability:

```bash
curl -i http://localhost:8789/mcp -H "Authorization: Bearer <TOKEN>"
```

Explicit legacy stream endpoint:

```bash
curl -i http://localhost:8789/mcp/stream \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Accept: text/event-stream"
```

## Recommended Workflow

- `web_search` for discovery
- `fetch_url_markdown` for readable source content
- `crawl_sitemap_targets` for sitemap-driven targeted fetches
- `fetch_url_chunks` for long docs or knowledge-base pages
- `crawl_rendered` for one JS-heavy page at a time
- `crawl_static` for bounded multi-page crawling with `start_url`

## Example Prompts

```text
Search for the official docs, fetch the best result as Markdown, and extract the decision rules.
```

```text
Use the sitemap to find the docs pages on this site, then return the pages as chunks.
```

## Lead Tool Examples

The following examples use the implemented lead tools:

```text
Find leads for ERP vendors in the Benelux region and prefer companies with a clear official website.
```

```text
Extract business contacts from a company homepage and include names, emails, phone numbers, and source URLs.
```

```text
Resolve the official business website for this company and explain why it was chosen over social or directory pages.
```

## Troubleshooting

- If `web_search` returns `403`, the internal SearXNG instance is usually missing `json` in `search.formats` or is rejecting the request via bot-detection.
- This repo now mounts `searxng/settings.yml` for SearXNG JSON API support. Rebuild the Compose stack after updates.
- If `web_search` returns `[]` for brand or domain queries, the server already retries several internal query variants and may fetch the public homepage directly. If the result is still empty, the site likely has too little public text context or the search engines configured in SearXNG do not surface it.
- If LM Studio shows `WebSocket closed by the client` after the first successful calls, make sure you are on a build with session-aware `/mcp` handling and the new `WEB_SEARCH_*` budgets. Older builds created a fresh MCP server per request and were more likely to stall repeated `web_search` sequences.
- If LM Studio reports `MCP error -32602` and mentions `structuredContent` expecting a record, make sure you are on a build where array-returning tools like `web_search` only use `content` and do not send array values in `structuredContent`.
- If LM Studio sends `crawl_rendered` with `start_url` instead of `url`, current builds recover automatically. `crawl_rendered` still renders only one page, while `crawl_static` is the right tool for multi-page traversal.
