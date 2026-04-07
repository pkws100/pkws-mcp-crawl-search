# ChatGPT Setup

This repo can be used from a ChatGPT workflow when your ChatGPT environment supports an external MCP server or a bridge that forwards MCP calls. The server itself is the same one used by other clients:

- MCP URL: `http://<HOST-IP>:8789/mcp`
- Health URL: `http://<HOST-IP>:8789/health`

## Start The Server

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:8789/health
```

If `MCP_AUTH_TOKEN` is set, include:

```http
Authorization: Bearer <TOKEN>
```

for every MCP request and health check.

## MCP Config Shape

Use the same connection object in any ChatGPT bridge, connector, or local wrapper that supports MCP server URLs:

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

If your ChatGPT surface does not accept raw MCP URLs directly, point the bridge at the same URL and keep the bearer token handling there.

## How To Use It In ChatGPT

- Use `web_search` first when you need fresh public sources.
- Use `fetch_url_markdown` for compact, readable source material.
- Use `discover_site` and `crawl_sitemap_targets` for site-level discovery and targeted fetches.
- Use `crawl_rendered` when the source depends on browser execution.
- Use `fetch_url_chunks` when the content is long and the model should reason over sections.

## Example Prompts

```text
Find the best public sources on this topic, fetch the strongest source as Markdown, and summarize the main evidence.
```

```text
Inspect the sitemap for this domain, keep only docs pages, and fetch them as chunks for later synthesis.
```

## Lead Tool Examples

These are the recommended patterns for the implemented lead tools:

```text
Find leads for logistics companies in Germany, sorted by website quality and recency.
```

```text
Extract business contacts from the business profile page and return only verified contact details.
```

```text
Resolve the official website for this business name, then confirm it against the sitemap and contact page.
```

## Troubleshooting

- `web_search` runs through the internal SearXNG container. If you see `403`, rebuild the stack after confirming that the mounted `searxng/settings.yml` still enables `search.formats: [html, json]`.
- A second common `403` cause is SearXNG bot-detection. The MCP server now sends browser-like headers, but Compose must be restarted after the update.
