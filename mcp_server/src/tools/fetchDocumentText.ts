import { z } from "zod";
import type { AppConfig } from "../config.js";
import { clampNumber } from "../util/limits.js";
import type { LookupFn } from "../util/ssrfGuard.js";
import { fetchDocumentExtraction } from "../util/documentExtract.js";

export const fetchDocumentTextInputSchema = z.object({
  url: z.string().url(),
  max_chars: z.number().int().min(1).max(20_000).default(12_000),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(15_000),
  user_agent: z.string().min(1).max(300).optional()
});

export const fetchDocumentTextResultSchema = z.object({
  final_url: z.string().url(),
  status: z.number().int().nonnegative(),
  content_type: z.string(),
  title: z.string().optional(),
  text: z.string(),
  page_count: z.number().int().positive().optional(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean()
});

export type FetchDocumentTextInput = z.infer<typeof fetchDocumentTextInputSchema>;
export type FetchDocumentTextResult = z.infer<typeof fetchDocumentTextResultSchema>;

export async function executeFetchDocumentText(
  input: FetchDocumentTextInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<FetchDocumentTextResult> {
  const maxChars = clampNumber(input.max_chars, 1, config.maxCharsPerPage);
  const timeoutMs = clampNumber(input.timeout_ms, 1_000, config.maxToolTimeoutMs);
  const result = await fetchDocumentExtraction(
    {
      url: input.url,
      maxChars,
      timeoutMs,
      maxBytes: config.maxHtmlBytes,
      userAgent: input.user_agent ?? config.defaultUserAgent,
      fetchImpl: options?.fetchImpl,
      lookupFn: options?.lookupFn
    },
    config
  );

  return fetchDocumentTextResultSchema.parse(result);
}
