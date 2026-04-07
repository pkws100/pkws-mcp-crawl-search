import { z } from "zod";
import type { AppConfig } from "../config.js";
import { clampNumber } from "../util/limits.js";
import {
  computeContentQuality,
  computeRelevanceScore,
  scoreSearchResultCandidate
} from "../util/quality.js";
import type { LookupFn } from "../util/ssrfGuard.js";
import { executeCrawlRendered, renderPageSnapshot } from "./crawlRendered.js";
import { executeFetchDocumentText } from "./fetchDocumentText.js";
import { executeFetchUrlChunks } from "./fetchUrlChunks.js";
import { buildMarkdownResult, executeFetchUrlMarkdown } from "./fetchUrlMarkdown.js";
import { fetchPageSnapshot } from "./fetchUrlText.js";
import { executeWebSearch } from "./webSearch.js";

const extractionChunkSchema = z.object({
  chunk_id: z.string(),
  heading_path: z.array(z.string()),
  text: z.string()
});

const extractionMetadataSchema = z.object({
  canonical_url: z.string().optional(),
  meta_description: z.string().optional(),
  lang: z.string().optional(),
  author: z.string().optional(),
  published_at: z.string().optional(),
  modified_at: z.string().optional(),
  og_title: z.string().optional(),
  og_description: z.string().optional(),
  content_hash: z.string().optional()
});

export const searchAndExtractInputSchema = z.object({
  query: z.string().min(1).max(500),
  search_limit: z.number().int().min(1).max(10).default(5),
  extract_mode: z.enum(["markdown", "text", "chunks"]).default("markdown"),
  prefer_rendered: z.boolean().default(false),
  language: z.string().min(2).max(16).default("de"),
  time_range: z.enum(["day", "week", "month", "year", "all"]).default("month"),
  per_result_max_chars: z.number().int().min(1).max(20_000).default(8_000)
});

export const searchAndExtractResultSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      snippet: z.string(),
      extraction: z
        .object({
          mode: z.enum(["markdown", "text", "chunks"]),
          title: z.string().optional(),
          content: z.union([z.string(), z.array(extractionChunkSchema)]),
          metadata: extractionMetadataSchema.optional()
        })
        .optional(),
      quality: z
        .object({
          relevance_score: z.number().int().min(0).max(100),
          content_quality_score: z.number().int().min(0).max(100),
          boilerplate_ratio: z.number().min(0).max(1).optional(),
          word_count: z.number().int().nonnegative()
        })
        .optional()
    })
  ),
  stats: z.object({
    searched: z.number().int().nonnegative(),
    extracted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative()
  })
});

export type SearchAndExtractInput = z.infer<typeof searchAndExtractInputSchema>;
export type SearchAndExtractResult = z.infer<typeof searchAndExtractResultSchema>;

function shouldUseDocumentFetch(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

function shouldPreferRendered(
  preferRendered: boolean,
  candidate: { url: string; snippet: string }
): boolean {
  if (!preferRendered) {
    return false;
  }

  return (
    candidate.snippet.trim().length < 80 ||
    /(app|dashboard|interactive|viewer|spa|search|results)/i.test(candidate.url)
  );
}

export async function executeSearchAndExtract(
  input: SearchAndExtractInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    searchFetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<SearchAndExtractResult> {
  const perResultMaxChars = clampNumber(input.per_result_max_chars, 1, config.maxCharsPerPage);
  const searchResults = await executeWebSearch(
    {
      query: input.query,
      limit: input.search_limit,
      language: input.language,
      time_range: input.time_range
    },
    config,
    options?.searchFetchImpl ?? options?.fetchImpl,
    options?.lookupFn
  );

  const ranked = [...searchResults].sort((a, b) => {
    const delta =
      scoreSearchResultCandidate(input.query, b, input.language) -
      scoreSearchResultCandidate(input.query, a, input.language);
    return delta !== 0 ? delta : a.url.localeCompare(b.url);
  });

  const results: SearchAndExtractResult["results"] = [];
  let extracted = 0;
  let failed = 0;

  for (const candidate of ranked) {
    const base = {
      title: candidate.title,
      url: candidate.url,
      snippet: candidate.snippet
    };

    try {
      if (shouldUseDocumentFetch(candidate.url)) {
        const document = await executeFetchDocumentText(
          {
            url: candidate.url,
            max_chars: perResultMaxChars,
            timeout_ms: 20_000
          },
          config,
          { fetchImpl: options?.fetchImpl, lookupFn: options?.lookupFn }
        );

        const relevanceScore = computeRelevanceScore(input.query, {
          title: document.title ?? candidate.title,
          url: document.final_url,
          snippet: candidate.snippet,
          text: document.text
        });

        results.push({
          ...base,
          extraction: {
            mode: "text",
            title: document.title,
            content: document.text
          },
          quality: {
            relevance_score: relevanceScore,
            content_quality_score: Math.min(100, Math.max(0, Math.round(document.text.length / 120))),
            word_count: document.text.split(/\s+/).filter(Boolean).length
          }
        });
        extracted += 1;
        continue;
      }

      const useRendered = shouldPreferRendered(input.prefer_rendered, candidate);

      if (input.extract_mode === "chunks") {
        const chunkResult = await executeFetchUrlChunks(
          {
            url: candidate.url,
            chunk_size: 1_200,
            overlap: 150,
            max_chunks: 20,
            strategy: "heading",
            rendered: useRendered,
            timeout_ms: 20_000
          },
          config,
          { fetchImpl: options?.fetchImpl, lookupFn: options?.lookupFn }
        );

        const relevanceScore = computeRelevanceScore(input.query, {
          title: chunkResult.title ?? candidate.title,
          url: chunkResult.final_url,
          snippet: candidate.snippet,
          headings: chunkResult.chunks.map((chunk) => chunk.heading_path.join(" ")),
          metaDescription: chunkResult.metadata.meta_description,
          text: chunkResult.chunks.map((chunk) => chunk.text).join(" ")
        });

        results.push({
          ...base,
          extraction: {
            mode: "chunks",
            title: chunkResult.title,
            content: chunkResult.chunks.map((chunk) => ({
              chunk_id: chunk.chunk_id,
              heading_path: chunk.heading_path,
              text: chunk.text
            })),
            metadata: chunkResult.metadata
          },
          quality: {
            relevance_score: relevanceScore,
            ...chunkResult.quality
          }
        });
        extracted += 1;
        continue;
      }

      if (input.extract_mode === "markdown") {
        if (useRendered) {
          const renderedSnapshot = await renderPageSnapshot(
            {
              url: candidate.url,
              wait_until: "networkidle",
              wait_ms: 1_000,
              max_chars: perResultMaxChars,
              timeout_ms: 20_000
            },
            config,
            { lookupFn: options?.lookupFn }
          );
          const markdown = buildMarkdownResult({
            ...renderedSnapshot,
            content_type: "text/html",
            bytes: Buffer.byteLength(renderedSnapshot.html ?? "", "utf8")
          }, {
            includeLinks: true,
            maxChars: perResultMaxChars
          });
          const relevanceScore = computeRelevanceScore(input.query, {
            title: markdown.title ?? candidate.title,
            url: markdown.final_url,
            snippet: candidate.snippet,
            headings: markdown.headings.map((heading) => heading.text),
            metaDescription: markdown.metadata.meta_description,
            text: markdown.markdown
          });

          results.push({
            ...base,
            extraction: {
              mode: "markdown",
              title: markdown.title,
              content: markdown.markdown,
              metadata: markdown.metadata
            },
            quality: {
              relevance_score: relevanceScore,
              ...markdown.quality
            }
          });
          extracted += 1;
          continue;
        }

        const markdown = await executeFetchUrlMarkdown(
          {
            url: candidate.url,
            max_chars: perResultMaxChars,
            timeout_ms: 20_000,
            include_links: true
          },
          config,
          { fetchImpl: options?.fetchImpl, lookupFn: options?.lookupFn }
        );
        const relevanceScore = computeRelevanceScore(input.query, {
          title: markdown.title ?? candidate.title,
          url: markdown.final_url,
          snippet: candidate.snippet,
          headings: markdown.headings.map((heading) => heading.text),
          metaDescription: markdown.metadata.meta_description,
          text: markdown.markdown
        });

        results.push({
          ...base,
          extraction: {
            mode: "markdown",
            title: markdown.title,
            content: markdown.markdown,
            metadata: markdown.metadata
          },
          quality: {
            relevance_score: relevanceScore,
            ...markdown.quality
          }
        });
        extracted += 1;
        continue;
      }

      if (useRendered) {
        const rendered = await executeCrawlRendered(
          {
            url: candidate.url,
            wait_until: "networkidle",
            wait_ms: 1_000,
            max_chars: perResultMaxChars,
            timeout_ms: 20_000
          },
          config,
          { lookupFn: options?.lookupFn }
        );
        const contentQuality = Math.min(100, Math.max(0, Math.round(rendered.text.length / 120)));
        const relevanceScore = computeRelevanceScore(input.query, {
          title: rendered.title ?? candidate.title,
          url: rendered.final_url,
          snippet: candidate.snippet,
          text: rendered.text
        });

        results.push({
          ...base,
          extraction: {
            mode: "text",
            title: rendered.title,
            content: rendered.text
          },
          quality: {
            relevance_score: relevanceScore,
            content_quality_score: contentQuality,
            word_count: rendered.text.split(/\s+/).filter(Boolean).length
          }
        });
        extracted += 1;
        continue;
      }

      const snapshot = await fetchPageSnapshot(
        {
          url: candidate.url,
          max_chars: perResultMaxChars,
          timeout_ms: 20_000
        },
        config,
        { fetchImpl: options?.fetchImpl, lookupFn: options?.lookupFn }
      );
      const contentQuality = computeContentQuality(snapshot.extracted);
      const relevanceScore = computeRelevanceScore(input.query, {
        title: snapshot.title ?? candidate.title,
        url: snapshot.final_url,
        snippet: candidate.snippet,
        headings: snapshot.extracted.headings.map((heading) => heading.text),
        metaDescription: snapshot.extracted.metadata.meta_description,
        text: snapshot.text
      });

      results.push({
        ...base,
        extraction: {
          mode: "text",
          title: snapshot.title,
          content: snapshot.text,
          metadata: {
            ...snapshot.extracted.metadata,
            content_hash: snapshot.extracted.content_hash
          }
        },
        quality: {
          relevance_score: relevanceScore,
          ...contentQuality
        }
      });
      extracted += 1;
    } catch {
      failed += 1;
      results.push(base);
    }
  }

  return searchAndExtractResultSchema.parse({
    results,
    stats: {
      searched: searchResults.length,
      extracted,
      failed
    }
  });
}
