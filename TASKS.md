# TASKS

## Milestone 1: Foundation
- Create root repo files, `mcp_server/` project scaffolding, and TypeScript build configuration.
- Define env parsing, runtime limits, and structured logging.

## Milestone 2: HTTP and MCP Server
- Stand up Express with `/health` and `/mcp`.
- Wire optional bearer auth for both endpoints.
- Register all MCP tools with validated schemas and stable JSON outputs.

## Milestone 3: Tooling
- Implement `web_search` against internal SearXNG.
- Implement `fetch_url_text` with SSRF guard, byte caps, text extraction, and redirect validation.
- Implement `crawl_static` with BFS traversal, robots handling, dedupe, domain filtering, and page stats.
- Implement `crawl_rendered` with Playwright, rendered DOM extraction, and network counters.

## Milestone 4: Containerization
- Add `Dockerfile` based on a Playwright image.
- Add Compose networking with internal-only backend and host-facing frontend.
- Add healthchecks and dependency ordering.

## Milestone 5: Verification
- Add unit and smoke tests for SSRF, web search normalization, fetch/crawl behavior, and auth expectations.
- Verify build/test locally and fix issues found by review.
- Confirm README setup, LAN access guidance, and MCP client configuration examples.

## Done Criteria
- All acceptance criteria pass.
- Review finds no open blockers.
- Repo is ready to copy as-is.
