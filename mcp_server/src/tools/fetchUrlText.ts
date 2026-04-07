import { z } from "zod";
import type { AppConfig } from "../config.js";
import { extractContent, type ExtractedContent } from "../util/contentExtract.js";
import { clampNumber } from "../util/limits.js";
import { fetchRemoteResource } from "../util/remoteFetch.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const fetchUrlTextInputSchema = z.object({
  url: z.string().url(),
  max_chars: z.number().int().min(1).max(20_000).default(8_000),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(15_000),
  user_agent: z.string().min(1).max(300).optional()
});

export const fetchUrlTextResultSchema = z.object({
  final_url: z.string().url(),
  status: z.number().int().nonnegative(),
  title: z.string().optional(),
  text: z.string(),
  content_type: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean()
});

export type FetchUrlTextInput = z.infer<typeof fetchUrlTextInputSchema>;
export type FetchUrlTextResult = z.infer<typeof fetchUrlTextResultSchema>;

export interface PageSnapshot extends FetchUrlTextResult {
  html: string;
  extracted: ExtractedContent;
}

export async function fetchPageSnapshot(
  input: FetchUrlTextInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
    maxBytes?: number;
  }
): Promise<PageSnapshot> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const lookupFn = options?.lookupFn;
  const maxChars = clampNumber(input.max_chars, 1, config.maxCharsPerPage);
  const timeoutMs = clampNumber(input.timeout_ms, 1_000, config.maxToolTimeoutMs);
  const maxBytes = options?.maxBytes ?? config.maxHtmlBytes;
  const response = await fetchRemoteResource(config, {
    url: input.url,
    timeoutMs,
    maxBytes,
    userAgent: input.user_agent ?? config.defaultUserAgent,
    accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    fetchImpl,
    lookupFn
  });
  const html = response.buffer.toString("utf8");
  const extracted = extractContent(html, {
    maxChars,
    finalUrl: response.finalUrl
  });

  return {
    final_url: response.finalUrl,
    status: response.status,
    title: extracted.title,
    text: extracted.mainText,
    content_type: response.contentType,
    bytes: response.bytes,
    truncated: response.truncated || extracted.truncated,
    html,
    extracted
  };
}

export async function executeFetchUrlText(
  input: FetchUrlTextInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<FetchUrlTextResult> {
  const snapshot = await fetchPageSnapshot(input, config, options);
  return fetchUrlTextResultSchema.parse(snapshot);
}
