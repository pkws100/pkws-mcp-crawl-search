import { chromium, type Browser } from "playwright";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { extractContent, type ExtractedContent } from "../util/contentExtract.js";
import { clampNumber, truncateText, truncateUtf8ByBytes } from "../util/limits.js";
import { ensurePublicHttpUrl, SSRFError, type LookupFn } from "../util/ssrfGuard.js";

export const crawlRenderedInputSchema = z.object({
  url: z.string().url().optional(),
  start_url: z.string().url().optional(),
  wait_until: z.enum(["domcontentloaded", "networkidle"]).default("networkidle"),
  wait_ms: z.number().int().min(0).max(10_000).default(1_000),
  wait_selector: z.string().min(1).max(300).optional(),
  max_chars: z.number().int().min(1).max(20_000).default(8_000),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(30_000),
  user_agent: z.string().min(1).max(300).optional(),
  max_pages: z.number().int().min(1).max(50).optional(),
  max_depth: z.number().int().min(0).max(3).optional(),
  same_domain_only: z.boolean().optional(),
  obey_robots: z.boolean().optional(),
  delay_ms: z.number().int().min(0).max(10_000).optional(),
  max_chars_per_page: z.number().int().min(1).max(20_000).optional()
}).superRefine((input, ctx) => {
  if (!input.url && !input.start_url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "Either url or start_url is required"
    });
  }
});

export const crawlRenderedResultSchema = z.object({
  final_url: z.string().url(),
  status: z.number().int().nonnegative(),
  title: z.string().optional(),
  text: z.string(),
  html: z.string().optional(),
  network: z.object({
    requests: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative()
  }),
  truncated: z.boolean()
});

export type CrawlRenderedInput = {
  url: string;
  wait_until: "domcontentloaded" | "networkidle";
  wait_ms: number;
  wait_selector?: string;
  max_chars: number;
  timeout_ms: number;
  user_agent?: string;
};
export type CrawlRenderedRawInput = z.infer<typeof crawlRenderedInputSchema>;
export type CrawlRenderedResult = z.infer<typeof crawlRenderedResultSchema>;

export interface RenderedPageSnapshot extends CrawlRenderedResult {
  extracted: ExtractedContent;
}

let browserPromise: Promise<Browser> | undefined;

const ignoredRenderedCrawlFields = [
  "max_pages",
  "max_depth",
  "same_domain_only",
  "obey_robots",
  "delay_ms",
  "max_chars_per_page"
] as const;

export type CrawlRenderedNormalization = {
  input: CrawlRenderedInput;
  normalized_start_url_alias: boolean;
  ignored_crawl_fields: string[];
};

export function normalizeCrawlRenderedInput(rawInput: CrawlRenderedRawInput): CrawlRenderedNormalization {
  const url = rawInput.url ?? rawInput.start_url;

  if (!url) {
    throw new Error("crawl_rendered requires url or start_url");
  }

  return {
    input: {
      url,
      wait_until: rawInput.wait_until,
      wait_ms: rawInput.wait_ms,
      wait_selector: rawInput.wait_selector,
      max_chars: rawInput.max_chars,
      timeout_ms: rawInput.timeout_ms,
      user_agent: rawInput.user_agent
    },
    normalized_start_url_alias: !rawInput.url && Boolean(rawInput.start_url),
    ignored_crawl_fields: ignoredRenderedCrawlFields.filter((field) => rawInput[field] !== undefined)
  };
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }

  return browserPromise;
}

export async function closeSharedBrowser(): Promise<void> {
  if (!browserPromise) {
    return;
  }

  const browser = await browserPromise;
  await browser.close();
  browserPromise = undefined;
}

export async function renderPageSnapshot(
  input: CrawlRenderedInput,
  config: AppConfig,
  options?: {
    lookupFn?: LookupFn;
  }
): Promise<RenderedPageSnapshot> {
  const lookupFn = options?.lookupFn;
  await ensurePublicHttpUrl(input.url, config, lookupFn);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: input.user_agent ?? config.defaultUserAgent,
    ignoreHTTPSErrors: false,
    serviceWorkers: "block"
  });
  const page = await context.newPage();
  const maxChars = clampNumber(input.max_chars, 1, config.maxCharsPerPage);
  const timeoutMs = clampNumber(input.timeout_ms, 1_000, config.maxToolTimeoutMs);

  let requests = 0;
  let failed = 0;

  page.on("request", () => {
    requests += 1;
  });
  page.on("requestfailed", () => {
    failed += 1;
  });

  await page.route("**/*", async (route) => {
    try {
      await ensurePublicHttpUrl(route.request().url(), config, lookupFn);
      await route.continue();
    } catch (error) {
      if (!(error instanceof SSRFError)) {
        failed += 1;
      }
      await route.abort("accessdenied");
    }
  });

  try {
    const response = await page.goto(input.url, {
      waitUntil: input.wait_until,
      timeout: timeoutMs
    });

    if (input.wait_selector) {
      await page.waitForSelector(input.wait_selector, { timeout: timeoutMs });
    }

    if (input.wait_ms > 0) {
      await page.waitForTimeout(input.wait_ms);
    }

    const title = (await page.title()).trim() || undefined;
    const htmlResult = truncateUtf8ByBytes(await page.content(), config.maxHtmlBytes);
    const extracted = extractContent(htmlResult.value, {
      maxChars,
      finalUrl: page.url()
    });
    const textResult = truncateText(extracted.mainText, maxChars);

    const parsed = crawlRenderedResultSchema.parse({
      final_url: page.url(),
      status: response?.status() ?? 0,
      title: title || extracted.title,
      text: textResult.value,
      html: htmlResult.value,
      network: {
        requests,
        failed
      },
      truncated: textResult.truncated || htmlResult.truncated || extracted.truncated
    });

    return {
      ...parsed,
      extracted
    };
  } finally {
    await page.close();
    await context.close();
  }
}

export async function executeCrawlRendered(
  input: CrawlRenderedInput | CrawlRenderedRawInput,
  config: AppConfig,
  options?: {
    lookupFn?: LookupFn;
  }
): Promise<CrawlRenderedResult> {
  const normalized = normalizeCrawlRenderedInput(crawlRenderedInputSchema.parse(input));
  const snapshot = await renderPageSnapshot(normalized.input, config, options);
  return crawlRenderedResultSchema.parse(snapshot);
}
