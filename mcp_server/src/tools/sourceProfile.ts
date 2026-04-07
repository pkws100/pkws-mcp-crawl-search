import { z } from "zod";
import type { AppConfig } from "../config.js";
import { loadResearchSource } from "../util/research.js";
import { sourceTypeValues, sourceTrustSignalsSchema } from "../util/sourceTrust.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const sourceProfileInputSchema = z.object({
  url: z.string().url(),
  rendered: z.boolean().default(false)
});

export const sourceProfileResultSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  source_type: z.enum(sourceTypeValues),
  trust_score: z.number().int().min(0).max(100),
  signals: sourceTrustSignalsSchema,
  quality: z.object({
    content_quality_score: z.number().int().min(0).max(100),
    boilerplate_ratio: z.number().min(0).max(1).optional(),
    word_count: z.number().int().nonnegative()
  }).optional(),
  notes: z.array(z.string())
});

export type SourceProfileInput = z.infer<typeof sourceProfileInputSchema>;
export type SourceProfileResult = z.infer<typeof sourceProfileResultSchema>;

export async function executeSourceProfile(
  input: SourceProfileInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<SourceProfileResult> {
  const source = await loadResearchSource(
    {
      url: input.url,
      query: input.url,
      rendered: input.rendered,
      extractedVia: input.rendered ? "rendered" : "search"
    },
    config,
    options
  );

  return sourceProfileResultSchema.parse({
    url: source.url,
    title: source.title,
    source_type: source.source_type,
    trust_score: source.trust_score,
    signals: source.profile.signals,
    quality: source.quality,
    notes: source.profile.notes
  });
}
