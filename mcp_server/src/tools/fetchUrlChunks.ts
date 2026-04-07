import { z } from "zod";
import type { AppConfig } from "../config.js";
import { buildChunks } from "../util/chunking.js";
import { computeContentQuality } from "../util/quality.js";
import type { LookupFn } from "../util/ssrfGuard.js";
import { clampNumber } from "../util/limits.js";
import { fetchPageSnapshot } from "./fetchUrlText.js";
import { renderPageSnapshot } from "./crawlRendered.js";

export const fetchUrlChunksInputSchema = z.object({
  url: z.string().url(),
  chunk_size: z.number().int().min(200).max(5_000).default(1_200),
  overlap: z.number().int().min(0).max(1_000).default(150),
  max_chunks: z.number().int().min(1).max(50).default(20),
  strategy: z.enum(["heading", "fixed"]).default("heading"),
  rendered: z.boolean().default(false),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(15_000),
  user_agent: z.string().min(1).max(300).optional()
});

export const fetchUrlChunksResultSchema = z.object({
  final_url: z.string().url(),
  status: z.number().int().nonnegative(),
  title: z.string().optional(),
  metadata: z.object({
    canonical_url: z.string().optional(),
    meta_description: z.string().optional(),
    lang: z.string().optional(),
    author: z.string().optional(),
    published_at: z.string().optional(),
    modified_at: z.string().optional(),
    og_title: z.string().optional(),
    og_description: z.string().optional(),
    content_hash: z.string()
  }),
  quality: z.object({
    content_quality_score: z.number().int().min(0).max(100),
    boilerplate_ratio: z.number().min(0).max(1).optional(),
    word_count: z.number().int().nonnegative()
  }),
  chunks: z.array(
    z.object({
      chunk_id: z.string(),
      heading_path: z.array(z.string()),
      text: z.string(),
      start_char: z.number().int().nonnegative(),
      end_char: z.number().int().nonnegative()
    })
  ),
  truncated: z.boolean()
});

export type FetchUrlChunksInput = z.infer<typeof fetchUrlChunksInputSchema>;
export type FetchUrlChunksResult = z.infer<typeof fetchUrlChunksResultSchema>;

export async function executeFetchUrlChunks(
  input: FetchUrlChunksInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<FetchUrlChunksResult> {
  const chunkSize = clampNumber(input.chunk_size, 200, 5_000);
  const overlap = clampNumber(input.overlap, 0, Math.min(1_000, chunkSize - 1));
  const maxChunks = clampNumber(input.max_chunks, 1, 50);

  const snapshot = input.rendered
    ? await renderPageSnapshot(
        {
          url: input.url,
          wait_until: "networkidle",
          wait_ms: 1_000,
          max_chars: config.maxCharsPerPage,
          timeout_ms: input.timeout_ms,
          user_agent: input.user_agent
        },
        config,
        { lookupFn: options?.lookupFn }
      )
    : await fetchPageSnapshot(
        {
          url: input.url,
          max_chars: config.maxCharsPerPage,
          timeout_ms: input.timeout_ms,
          user_agent: input.user_agent
        },
        config,
        options
      );

  const chunks = buildChunks(snapshot.extracted, {
    chunkSize,
    overlap,
    maxChunks,
    strategy: input.strategy
  });

  return fetchUrlChunksResultSchema.parse({
    final_url: snapshot.final_url,
    status: snapshot.status,
    title: snapshot.title,
    metadata: {
      ...snapshot.extracted.metadata,
      content_hash: snapshot.extracted.content_hash
    },
    quality: computeContentQuality(snapshot.extracted),
    chunks,
    truncated: snapshot.truncated || chunks.length >= maxChunks
  });
}
