import { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../config.js";
import { executeWebSearch, webSearchInputSchema, webSearchResultSchema } from "../tools/webSearch.js";
import {
  executeFetchUrlText,
  fetchUrlTextInputSchema,
  fetchUrlTextResultSchema
} from "../tools/fetchUrlText.js";
import {
  executeFetchUrlMarkdown,
  fetchUrlMarkdownInputSchema,
  fetchUrlMarkdownResultSchema
} from "../tools/fetchUrlMarkdown.js";
import {
  executeExtractBusinessContacts,
  extractBusinessContactsInputSchema,
  extractBusinessContactsResultSchema
} from "../tools/extractBusinessContacts.js";
import {
  executeFetchUrlChunks,
  fetchUrlChunksInputSchema,
  fetchUrlChunksResultSchema
} from "../tools/fetchUrlChunks.js";
import {
  executeFindLeads,
  findLeadsInputSchema,
  findLeadsResultSchema
} from "../tools/findLeads.js";
import {
  executeFetchDocumentText,
  fetchDocumentTextInputSchema,
  fetchDocumentTextResultSchema
} from "../tools/fetchDocumentText.js";
import {
  crawlSitemapTargetsInputSchema,
  crawlSitemapTargetsResultSchema,
  executeCrawlSitemapTargets
} from "../tools/crawlSitemapTargets.js";
import {
  executeInspectSitemap,
  inspectSitemapInputSchema,
  inspectSitemapResultSchema
} from "../tools/inspectSitemap.js";
import {
  executeSearchAndExtract,
  searchAndExtractInputSchema,
  searchAndExtractResultSchema
} from "../tools/searchAndExtract.js";
import {
  deepResearchInputSchema,
  deepResearchResultSchema,
  executeDeepResearch
} from "../tools/deepResearch.js";
import {
  executeResearchClaims,
  researchClaimsInputSchema,
  researchClaimsResultSchema
} from "../tools/researchClaims.js";
import {
  executeResearchSources,
  researchSourcesInputSchema,
  researchSourcesResultSchema
} from "../tools/researchSources.js";
import {
  executeResolveBusinessWebsite,
  resolveBusinessWebsiteInputSchema,
  resolveBusinessWebsiteResultSchema
} from "../tools/resolveBusinessWebsite.js";
import {
  executeSourceProfile,
  sourceProfileInputSchema,
  sourceProfileResultSchema
} from "../tools/sourceProfile.js";
import { crawlStaticInputSchema, crawlStaticResultSchema, executeCrawlStatic } from "../tools/crawlStatic.js";
import {
  crawlRenderedInputSchema,
  crawlRenderedResultSchema,
  executeCrawlRendered,
  normalizeCrawlRenderedInput
} from "../tools/crawlRendered.js";
import {
  discoverSiteInputSchema,
  discoverSiteResultSchema,
  executeDiscoverSite
} from "../tools/discoverSite.js";
import { log } from "../util/log.js";
import { toToolResult } from "./toolResult.js";

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: "pkws-mcp-crawl-search",
    version: "1.0.0"
  });

  server.registerTool(
    "web_search",
    {
      title: "Web Search",
      description: "Searches the web using the internal SearXNG instance.",
      inputSchema: webSearchInputSchema
    },
    async (rawInput) => {
      const input = webSearchInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeWebSearch(input, config);
        log.info("tool.web_search", {
          query_length: input.query.length,
          result_count: result.length,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.web_search.failed", {
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "find_leads",
    {
      title: "Find Leads",
      description: "Finds business leads from a free-text user query and enriches them with public contact data.",
      inputSchema: findLeadsInputSchema,
      outputSchema: findLeadsResultSchema
    },
    async (rawInput) => {
      const input = findLeadsInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeFindLeads(input, config);
        log.info("tool.find_leads", {
          query_length: input.query.length,
          leads: result.leads.length,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.find_leads.failed", {
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "fetch_url_text",
    {
      title: "Fetch URL Text",
      description: "Fetches a URL and returns extracted title and text content.",
      inputSchema: fetchUrlTextInputSchema,
      outputSchema: fetchUrlTextResultSchema
    },
    async (rawInput) => {
      const input = fetchUrlTextInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeFetchUrlText(input, config);
        log.info("tool.fetch_url_text", {
          url: input.url,
          status: result.status,
          bytes: result.bytes,
          truncated: result.truncated,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.fetch_url_text.failed", {
          url: input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "fetch_url_markdown",
    {
      title: "Fetch URL Markdown",
      description: "Fetches a URL and returns main content as Markdown with metadata.",
      inputSchema: fetchUrlMarkdownInputSchema,
      outputSchema: fetchUrlMarkdownResultSchema
    },
    async (rawInput) => {
      const input = fetchUrlMarkdownInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeFetchUrlMarkdown(input, config);
        log.info("tool.fetch_url_markdown", {
          url: input.url,
          bytes: result.bytes,
          truncated: result.truncated,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.fetch_url_markdown.failed", {
          url: input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "source_profile",
    {
      title: "Source Profile",
      description: "Profiles a source for trust, metadata, and quality signals.",
      inputSchema: sourceProfileInputSchema,
      outputSchema: sourceProfileResultSchema
    },
    async (rawInput) => {
      const input = sourceProfileInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeSourceProfile(input, config);
        log.info("tool.source_profile", {
          url: input.url,
          trust_score: result.trust_score,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.source_profile.failed", {
          url: input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "inspect_sitemap",
    {
      title: "Inspect Sitemap",
      description: "Reads sitemap indexes and urlsets, groups URLs, and exposes likely content targets.",
      inputSchema: inspectSitemapInputSchema,
      outputSchema: inspectSitemapResultSchema
    },
    async (rawInput) => {
      const input = inspectSitemapInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeInspectSitemap(input, config);
        log.info("tool.inspect_sitemap", {
          url: input.url,
          sitemap_count: result.stats.sitemap_count,
          url_count: result.stats.url_count,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.inspect_sitemap.failed", {
          url: input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "research_sources",
    {
      title: "Research Sources",
      description: "Builds a curated, trust-aware source pack for a research query.",
      inputSchema: researchSourcesInputSchema,
      outputSchema: researchSourcesResultSchema
    },
    async (rawInput) => {
      const input = researchSourcesInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeResearchSources(input, config);
        log.info("tool.research_sources", {
          query_length: input.query.length,
          returned: result.stats.returned,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.research_sources.failed", {
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "crawl_static",
    {
      title: "Crawl Static",
      description: "Performs a bounded multi-page BFS crawl starting from start_url. Use this for multi-page site traversal without JavaScript rendering.",
      inputSchema: crawlStaticInputSchema,
      outputSchema: crawlStaticResultSchema
    },
    async (rawInput) => {
      const input = crawlStaticInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeCrawlStatic(input, config);
        log.info("tool.crawl_static", {
          url: input.start_url,
          pages_fetched: result.stats.pages_fetched,
          errors: result.stats.errors,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.crawl_static.failed", {
          url: input.start_url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "crawl_sitemap_targets",
    {
      title: "Crawl Sitemap Targets",
      description: "Selects relevant sitemap URLs and fetches them as text, markdown, or chunks.",
      inputSchema: crawlSitemapTargetsInputSchema,
      outputSchema: crawlSitemapTargetsResultSchema
    },
    async (rawInput) => {
      const input = crawlSitemapTargetsInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeCrawlSitemapTargets(input, config);
        log.info("tool.crawl_sitemap_targets", {
          url: input.sitemap_url,
          selected: result.stats.selected,
          fetched: result.stats.fetched,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.crawl_sitemap_targets.failed", {
          url: input.sitemap_url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "extract_business_contacts",
    {
      title: "Extract Business Contacts",
      description: "Finds and extracts public business contacts from a website, prioritizing impressum and contact pages.",
      inputSchema: extractBusinessContactsInputSchema,
      outputSchema: extractBusinessContactsResultSchema
    },
    async (rawInput) => {
      const input = extractBusinessContactsInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeExtractBusinessContacts(input, config);
        log.info("tool.extract_business_contacts", {
          url: input.url,
          contact_pages: result.contact_pages.length,
          confidence: result.confidence,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.extract_business_contacts.failed", {
          url: input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "fetch_url_chunks",
    {
      title: "Fetch URL Chunks",
      description: "Fetches a URL and returns semantically chunked main content.",
      inputSchema: fetchUrlChunksInputSchema,
      outputSchema: fetchUrlChunksResultSchema
    },
    async (rawInput) => {
      const input = fetchUrlChunksInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeFetchUrlChunks(input, config);
        log.info("tool.fetch_url_chunks", {
          url: input.url,
          chunk_count: result.chunks.length,
          truncated: result.truncated,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.fetch_url_chunks.failed", {
          url: input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "fetch_document_text",
    {
      title: "Fetch Document Text",
      description: "Fetches supported document URLs and extracts text, starting with PDF.",
      inputSchema: fetchDocumentTextInputSchema,
      outputSchema: fetchDocumentTextResultSchema
    },
    async (rawInput) => {
      const input = fetchDocumentTextInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeFetchDocumentText(input, config);
        log.info("tool.fetch_document_text", {
          url: input.url,
          status: result.status,
          bytes: result.bytes,
          truncated: result.truncated,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.fetch_document_text.failed", {
          url: input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "crawl_rendered",
    {
      title: "Crawl Rendered",
      description: "Renders exactly one page in headless Chromium and returns visible DOM text. Use url for the page to render; start_url is tolerated as an alias. For multi-page crawling, use crawl_static instead.",
      inputSchema: crawlRenderedInputSchema,
      outputSchema: crawlRenderedResultSchema
    },
    async (rawInput) => {
      const normalized = normalizeCrawlRenderedInput(crawlRenderedInputSchema.parse(rawInput));
      const startedAt = Date.now();

      try {
        const result = await executeCrawlRendered(normalized.input, config);
        log.info("tool.crawl_rendered", {
          url: normalized.input.url,
          normalized_start_url_alias: normalized.normalized_start_url_alias,
          ignored_crawl_fields: normalized.ignored_crawl_fields,
          status: result.status,
          requests: result.network.requests,
          failed: result.network.failed,
          truncated: result.truncated,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.crawl_rendered.failed", {
          url: normalized.input.url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "resolve_business_website",
    {
      title: "Resolve Business Website",
      description: "Selects the most likely official website for a business from candidate URLs and search results.",
      inputSchema: resolveBusinessWebsiteInputSchema,
      outputSchema: resolveBusinessWebsiteResultSchema
    },
    async (rawInput) => {
      const input = resolveBusinessWebsiteInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeResolveBusinessWebsite(input, config);
        log.info("tool.resolve_business_website", {
          name: input.name,
          resolved: Boolean(result.best_website),
          confidence: result.confidence,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.resolve_business_website.failed", {
          name: input.name,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "search_and_extract",
    {
      title: "Search And Extract",
      description: "Runs web search, reranks results, and extracts the most useful content in one step.",
      inputSchema: searchAndExtractInputSchema,
      outputSchema: searchAndExtractResultSchema
    },
    async (rawInput) => {
      const input = searchAndExtractInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeSearchAndExtract(input, config);
        log.info("tool.search_and_extract", {
          query_length: input.query.length,
          searched: result.stats.searched,
          extracted: result.stats.extracted,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.search_and_extract.failed", {
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "research_claims",
    {
      title: "Research Claims",
      description: "Builds structured claims, evidence, and contradictions from prepared sources.",
      inputSchema: researchClaimsInputSchema,
      outputSchema: researchClaimsResultSchema
    },
    async (rawInput) => {
      const input = researchClaimsInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeResearchClaims(input, config);
        log.info("tool.research_claims", {
          source_count: input.source_urls.length,
          claims: result.claims.length,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.research_claims.failed", {
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "deep_research",
    {
      title: "Deep Research",
      description: "Runs an evidence-first research workflow with trust-aware sources and structured claims.",
      inputSchema: deepResearchInputSchema,
      outputSchema: deepResearchResultSchema
    },
    async (rawInput) => {
      const input = deepResearchInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeDeepResearch(input, config);
        log.info("tool.deep_research", {
          query_length: input.query.length,
          claims: result.claims.length,
          sources: result.sources.length,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.deep_research.failed", {
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "discover_site",
    {
      title: "Discover Site",
      description: "Discovers the key navigation and feeds of a site before deeper crawling.",
      inputSchema: discoverSiteInputSchema,
      outputSchema: discoverSiteResultSchema
    },
    async (rawInput) => {
      const input = discoverSiteInputSchema.parse(rawInput);
      const startedAt = Date.now();

      try {
        const result = await executeDiscoverSite(input, config);
        log.info("tool.discover_site", {
          url: input.start_url,
          important_pages: result.important_pages.length,
          duration_ms: Date.now() - startedAt
        });
        return toToolResult(result);
      } catch (error) {
        log.error("tool.discover_site.failed", {
          url: input.start_url,
          duration_ms: Date.now() - startedAt,
          error: asErrorMessage(error)
        });
        throw error;
      }
    }
  );

  return server;
}
