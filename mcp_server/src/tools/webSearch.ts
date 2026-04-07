import { z } from "zod";
import type { AppConfig } from "../config.js";
import { fetchPageSnapshot } from "./fetchUrlText.js";
import { clampNumber, truncateText } from "../util/limits.js";
import { log } from "../util/log.js";
import { getRequestContext } from "../util/requestContext.js";
import { buildSearchIntent } from "../util/searchIntent.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5),
  language: z.string().min(2).max(16).default("de"),
  time_range: z.enum(["day", "week", "month", "year", "all"]).default("month")
});

export const webSearchResultSchema = z.array(
  z.object({
    title: z.string(),
    url: z.string().url(),
    snippet: z.string()
  })
);

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

interface SearxResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

class SearchSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(timeoutMs: number, task: () => Promise<T>): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(onAcquire), 1);
        reject(new Error("Search concurrency budget exceeded"));
      }, timeoutMs);

      const onAcquire = () => {
        clearTimeout(timer);
        this.active += 1;
        resolve();
      };

      this.queue.push(onAcquire);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

const searchSemaphore = new SearchSemaphore(2);
const DEFAULT_TOTAL_BUDGET_MS = 10_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_VARIANTS = 4;
const MIN_REMAINING_BUDGET_MS = 400;

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
}

function getWebSearchBudget(config: AppConfig): { totalBudgetMs: number; attemptTimeoutMs: number; maxVariants: number } {
  const totalBudgetMs = clampNumber(
    config.webSearchTotalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS,
    1_000,
    config.maxToolTimeoutMs
  );
  const attemptTimeoutMs = clampNumber(
    config.webSearchAttemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    500,
    totalBudgetMs
  );
  const maxVariants = clampNumber(
    config.webSearchMaxVariants ?? DEFAULT_MAX_VARIANTS,
    1,
    6
  );

  return {
    totalBudgetMs,
    attemptTimeoutMs,
    maxVariants
  };
}

async function executeSingleSearch(
  input: WebSearchInput,
  config: AppConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<WebSearchResult> {
  const limit = clampNumber(input.limit, 1, 10);
  const url = new URL("/search", config.searxngBase);
  url.searchParams.set("q", input.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", input.language);
  url.searchParams.set("time_range", input.time_range);
  const acceptLanguage = input.language.toLowerCase().startsWith("de")
    ? `${input.language},de;q=0.9,en;q=0.6`
    : `${input.language};q=1.0,en;q=0.8,de;q=0.6`;

  const response = await searchSemaphore.run(timeoutMs, async () =>
    fetchImpl(url, {
      headers: {
        accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        "accept-language": acceptLanguage,
        "user-agent": config.defaultUserAgent
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
  );

  if (!response.ok) {
    const responseText = truncateText((await response.text()).trim(), 280).value;
    if (response.status === 403) {
      throw new Error(
        `SearXNG search failed with status 403. This usually means JSON search format is disabled in SearXNG or bot-detection rejected the request headers.${responseText ? ` Response: ${responseText}` : ""}`
      );
    }
    throw new Error(`SearXNG search failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`);
  }

  const payload = (await response.json()) as SearxResponse;
  return webSearchResultSchema.parse(
    (payload.results ?? [])
      .filter((entry): entry is { title: string; url: string; content?: string } => Boolean(entry?.title && entry?.url))
      .slice(0, limit)
      .map((entry) => ({
        title: entry.title,
        url: entry.url,
        snippet: truncateText((entry.content ?? "").trim(), 500).value
      }))
  );
}

function dedupeResults(results: WebSearchResult, limit: number): WebSearchResult {
  const seen = new Set<string>();
  const deduped: WebSearchResult = [];

  for (const result of results) {
    const key = normalizeResultUrl(result.url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

function normalizeResultUrl(input: string): string {
  try {
    const url = new URL(input);
    const normalizedHost = url.hostname.toLowerCase().replace(/^www\./, "");
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    const normalizedQuery = url.searchParams.toString();
    return `${url.protocol}//${normalizedHost}${normalizedPath}${normalizedQuery ? `?${normalizedQuery}` : ""}`;
  } catch {
    return input.toLowerCase();
  }
}

async function buildDomainFallbackResults(
  domain: string,
  config: AppConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  lookupFn?: LookupFn
): Promise<WebSearchResult> {
  const candidates = [`https://${domain}/`];
  const results: WebSearchResult = [];
  const seenUrls = new Set<string>();

  for (const candidateUrl of candidates) {
    try {
      const snapshot = await fetchPageSnapshot(
        {
          url: candidateUrl,
          max_chars: 800,
          timeout_ms: timeoutMs
        },
        config,
        {
          fetchImpl,
          lookupFn
        }
      );
      if (seenUrls.has(snapshot.final_url)) {
        continue;
      }
      seenUrls.add(snapshot.final_url);
      const snippetSource = snapshot.extracted.metadata.meta_description || snapshot.text;
      const snippet = truncateText(snippetSource.trim(), 500).value;
      if (!snapshot.title && !snippet) {
        continue;
      }
      results.push({
        title: snapshot.title ?? domain,
        url: snapshot.final_url,
        snippet
      });
      if (results.length >= 2) {
        break;
      }
    } catch {
      // ignore failed direct-domain fallback attempts
    }
  }

  return results;
}

export async function executeWebSearch(
  input: WebSearchInput,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
  lookupFn?: LookupFn
): Promise<WebSearchResult> {
  const requestContext = getRequestContext();
  const limit = clampNumber(input.limit, 1, 10);
  const { totalBudgetMs, attemptTimeoutMs, maxVariants } = getWebSearchBudget(config);
  const intent = buildSearchIntent(input.query, input.language);
  const attempts = intent.queryVariants
    .flatMap((queryVariant) =>
      intent.languageVariants.map((languageVariant) => ({
        queryVariant,
        languageVariant
      }))
    )
    .slice(0, maxVariants);
  const aggregated: WebSearchResult = [];
  let emptyAfterPrimary = false;
  let fallbackUsed = false;
  let strategyUsed = "primary";
  let searchBudgetExceeded = false;
  let searxTimeouts = 0;
  let attemptErrors = 0;
  let attemptsTried = 0;
  const deadline = Date.now() + totalBudgetMs;

  for (const [index, attempt] of attempts.entries()) {
    const remainingBudgetMs = deadline - Date.now();
    if (remainingBudgetMs < MIN_REMAINING_BUDGET_MS) {
      searchBudgetExceeded = true;
      break;
    }

    attemptsTried += 1;
    const perAttemptTimeoutMs = clampNumber(
      Math.min(attemptTimeoutMs, remainingBudgetMs),
      500,
      totalBudgetMs
    );

    try {
      const results = await executeSingleSearch(
        {
          ...input,
          query: attempt.queryVariant,
          language: attempt.languageVariant
        },
        config,
        fetchImpl,
        perAttemptTimeoutMs
      );

      if (index === 0 && aggregated.length === 0 && results.length === 0) {
        emptyAfterPrimary = true;
      }

      aggregated.push(...results);
      const dedupedSoFar = dedupeResults(aggregated, limit);
      if (dedupedSoFar.length >= limit) {
        strategyUsed = index === 0 ? "primary" : "query_variants";
        log.info("tool.web_search.strategy", {
          strategy_used: strategyUsed,
          variants_tried: attemptsTried,
          fallback_used: false,
          empty_after_primary: emptyAfterPrimary,
          result_count: dedupedSoFar.length,
          total_budget_ms: totalBudgetMs,
          search_budget_exceeded: false,
          searx_timeout_count: searxTimeouts,
          attempt_error_count: attemptErrors,
          client_disconnected: requestContext?.clientDisconnected ?? false,
          session_id: requestContext?.sessionId
        });
        return webSearchResultSchema.parse(dedupedSoFar);
      }
    } catch (error) {
      if (error instanceof Error && /status 403/i.test(error.message)) {
        throw error;
      }

      if (isAbortLikeError(error)) {
        searxTimeouts += 1;
      } else {
        attemptErrors += 1;
      }
    }
  }

  let finalResults = dedupeResults(aggregated, limit);
  const remainingBudgetMs = deadline - Date.now();
  if (finalResults.length === 0 && intent.domain && remainingBudgetMs >= 750) {
    const fallbackResults = await buildDomainFallbackResults(
      intent.domain,
      config,
      fetchImpl,
      clampNumber(Math.min(attemptTimeoutMs, remainingBudgetMs), 750, totalBudgetMs),
      lookupFn
    );
    if (fallbackResults.length > 0) {
      fallbackUsed = true;
      strategyUsed = "domain_fetch_fallback";
      finalResults = dedupeResults([...aggregated, ...fallbackResults], limit);
    }
  } else if (finalResults.length > 0 && intent.queryVariants.length > 1) {
    strategyUsed = "query_variants";
  } else if (searchBudgetExceeded && finalResults.length > 0) {
    strategyUsed = "partial_budget";
  }

  log.info("tool.web_search.strategy", {
    strategy_used: strategyUsed,
    variants_tried: attemptsTried,
    fallback_used: fallbackUsed,
    empty_after_primary: emptyAfterPrimary,
    result_count: finalResults.length,
    total_budget_ms: totalBudgetMs,
    search_budget_exceeded: searchBudgetExceeded,
    searx_timeout_count: searxTimeouts,
    attempt_error_count: attemptErrors,
    client_disconnected: requestContext?.clientDisconnected ?? false,
    session_id: requestContext?.sessionId
  });

  return webSearchResultSchema.parse(finalResults);
}
