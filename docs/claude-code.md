# Claude Code Setup

This repo exposes an MCP server at `http://<HOST-IP>:8789/mcp`. Claude Code can use it once the server is running and the MCP entry is configured in your Claude Code MCP settings or bridge.

## Start The Server

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:8789/health
```

If you set `MCP_AUTH_TOKEN`, the health check and every MCP request must carry the bearer token header.

## MCP Configuration

Use the same server definition regardless of whether you point Claude Code at `localhost` or a LAN host:

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

If auth is disabled, omit the `headers` block entirely.

## Usage Pattern In Claude Code

- Start with `web_search` to discover relevant public sources.
- Use `fetch_url_markdown` for pages you want to summarize or cite.
- Use `crawl_sitemap_targets` when you already know the site has a sitemap and want targeted extraction.
- Use `crawl_rendered` for pages that only become useful after JavaScript runs.
- Use `fetch_url_chunks` for long content that should be read in sections.

## Example Prompts

```text
Search for recent documentation about rate limits, then fetch the best source as Markdown and summarize the key rules.
```

```text
Inspect the sitemap for this site, select the most relevant docs pages, and return the result as chunks.
```

## Lead Tool Examples

The lead tools are available on the same MCP server:

```text
Find leads for managed IT providers in the DACH region and return only records with a clear business website.
```

```text
Extract business contacts from the company profile page and separate names, emails, and phone numbers.
```

```text
Resolve the official business website for this company name, then verify it against the contact page and sitemap.
```

Expected tool names:

- `find_leads`
- `extract_business_contacts`
- `resolve_business_website`
