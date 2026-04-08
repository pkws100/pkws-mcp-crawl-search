import { z } from "zod";

export interface AppConfig {
  mcpPort: number;
  mcpBind: string;
  mcpAllowedHosts: string[];
  mcpLogRequests: boolean;
  mcpEnableLegacySse: boolean;
  mcpLegacySsePath: string;
  searxngBase: string;
  mcpAuthToken?: string;
  blockPrivateNet: boolean;
  allowPrivateNet: boolean;
  maxHtmlBytes: number;
  maxPageCount: number;
  maxDepth: number;
  maxCharsPerPage: number;
  maxToolTimeoutMs: number;
  maxRedirects: number;
  robotsMaxBytes: number;
  defaultUserAgent: string;
  webSearchTotalBudgetMs?: number;
  webSearchAttemptTimeoutMs?: number;
  webSearchMaxVariants?: number;
}

const envSchema = z.object({
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8789),
  MCP_BIND_HOST: z.string().optional(),
  MCP_BIND: z.string().optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_LOG_REQUESTS: z.string().optional().default("false"),
  MCP_ENABLE_LEGACY_SSE: z.string().optional().default("true"),
  MCP_LEGACY_SSE_PATH: z.string().optional().default("/mcp/stream"),
  SEARXNG_BASE: z.string().url().default("http://searxng:8080"),
  MCP_AUTH_TOKEN: z.string().optional(),
  BLOCK_PRIVATE_NET: z.string().optional().default("true"),
  ALLOW_PRIVATE_NET: z.string().optional().default("false"),
  MAX_HTML_BYTES: z.coerce.number().int().min(4096).max(10_000_000).default(2_000_000),
  WEB_SEARCH_TOTAL_BUDGET_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  WEB_SEARCH_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(3_000),
  WEB_SEARCH_MAX_VARIANTS: z.coerce.number().int().min(1).max(6).default(4)
});

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeRoutePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const bindHost = (parsed.MCP_BIND_HOST?.trim() || parsed.MCP_BIND?.trim() || "0.0.0.0");
  const legacySsePath = normalizeRoutePath(parsed.MCP_LEGACY_SSE_PATH, "/mcp/stream");

  return {
    mcpPort: parsed.MCP_PORT,
    mcpBind: z.string().min(1).parse(bindHost),
    mcpAllowedHosts: parseList(parsed.MCP_ALLOWED_HOSTS),
    mcpLogRequests: parseBoolean(parsed.MCP_LOG_REQUESTS, false),
    mcpEnableLegacySse: parseBoolean(parsed.MCP_ENABLE_LEGACY_SSE, true),
    mcpLegacySsePath: legacySsePath,
    searxngBase: parsed.SEARXNG_BASE.replace(/\/+$/, ""),
    mcpAuthToken: parsed.MCP_AUTH_TOKEN?.trim() || undefined,
    blockPrivateNet: parseBoolean(parsed.BLOCK_PRIVATE_NET, true),
    allowPrivateNet: parseBoolean(parsed.ALLOW_PRIVATE_NET, false),
    maxHtmlBytes: parsed.MAX_HTML_BYTES,
    maxPageCount: 50,
    maxDepth: 3,
    maxCharsPerPage: 20_000,
    maxToolTimeoutMs: 30_000,
    maxRedirects: 5,
    robotsMaxBytes: 100_000,
    defaultUserAgent: "pkws-mcp-crawl-search/1.0 (+https://modelcontextprotocol.io)",
    webSearchTotalBudgetMs: parsed.WEB_SEARCH_TOTAL_BUDGET_MS,
    webSearchAttemptTimeoutMs: parsed.WEB_SEARCH_ATTEMPT_TIMEOUT_MS,
    webSearchMaxVariants: parsed.WEB_SEARCH_MAX_VARIANTS
  };
}
