# AGENTS

## Mission
Build and validate the `pkws-mcp-crawl-search` repository as a production-ready Node.js/TypeScript MCP server with internal SearXNG search, static crawling, rendered crawling via Playwright, and security-by-default safeguards.

## Roles

### Architect
- Owns architecture, repo layout, interface contracts, Docker Compose topology, and security defaults.
- Confirms that `searxng` stays internal-only and that `mcp` binds to `0.0.0.0:8789`.
- Defines input/output contracts for all MCP tools and guardrails for SSRF, auth, limits, and logging.

### Builder
- Owns implementation inside `mcp_server/`, Docker assets, tests, and local developer experience.
- Delivers working HTTP endpoints `/health` and `/mcp`.
- Implements the four MCP tools exactly to contract and keeps the build reproducible with `docker compose up -d --build`.

### Reviewer
- Owns acceptance verification, regression checks, and security validation.
- Runs lint/build/test and smoke checks against Compose.
- Verifies auth behavior, SSRF protection, network isolation, and README accuracy.

## Handoffs
- Architect hands Builder a decision-complete contract for repo structure, env vars, networking, and tool schemas.
- Builder hands Reviewer a runnable repo with tests and documented verification steps.
- Reviewer reports findings by severity, Builder fixes them, and Reviewer re-checks until no acceptance blockers remain.

## Guardrails
- Port `8789` is fixed and exposed only by the `mcp` service.
- `searxng` must never publish a host port.
- All outbound URL access must pass SSRF validation before request and on redirects.
- Private, loopback, link-local, and unique-local ranges stay blocked unless `ALLOW_PRIVATE_NET=true`.
- No page body, HTML blob, auth token, or secret value may be logged.
- No login flows, cookies, or credential forwarding in v1.

## Acceptance Targets
- `docker compose up -d --build` works without manual steps.
- `GET /health` returns `200 ok`.
- `POST /mcp` is reachable from `localhost` and the host LAN IP on port `8789`.
- Tools `web_search`, `fetch_url_text`, `crawl_static`, and `crawl_rendered` match the required response shapes.
- Optional bearer auth works exactly when `MCP_AUTH_TOKEN` is set.

## Review Gate
The task is complete only when:
- unit and smoke tests pass
- Docker build and Compose startup succeed
- reviewer finds no remaining acceptance or security blockers
