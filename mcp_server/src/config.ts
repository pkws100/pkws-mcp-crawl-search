import { z } from "zod";

export interface AppConfig {
  mcpPort: number;
  mcpBind: string;
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
  MCP_BIND: z.string().min(1).default("0.0.0.0"),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    mcpPort: parsed.MCP_PORT,
    mcpBind: parsed.MCP_BIND,
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
