import { z } from "zod";
import type { AppConfig } from "../config.js";
import { buildClaimsFromSources, dedupeResearchSources, loadResearchSource } from "../util/research.js";
import type { LookupFn } from "../util/ssrfGuard.js";

const contradictionSchema = z.object({
  claim_id: z.string(),
  source_id: z.string(),
  note: z.string()
});

export const researchClaimsInputSchema = z.object({
  query: z.string().min(1).max(500),
  source_urls: z.array(z.string().url()).min(1).max(20),
  max_claims: z.number().int().min(1).max(20).default(12)
});

export const researchClaimsResultSchema = z.object({
  claims: z.array(
    z.object({
      id: z.string(),
      claim: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      support: z.array(
        z.object({
          source_id: z.string(),
          evidence: z.string()
        })
      ),
      contradictions: z.array(
        z.object({
          source_id: z.string(),
          note: z.string()
        })
      )
    })
  ),
  contradictions: z.array(contradictionSchema),
  coverage: z.object({
    well_supported: z.number().int().nonnegative(),
    weakly_supported: z.number().int().nonnegative(),
    conflicting: z.number().int().nonnegative()
  })
});

export type ResearchClaimsInput = z.infer<typeof researchClaimsInputSchema>;
export type ResearchClaimsResult = z.infer<typeof researchClaimsResultSchema>;

export async function executeResearchClaims(
  input: ResearchClaimsInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<ResearchClaimsResult> {
  const loaded = await Promise.all(
    input.source_urls.map((url) =>
      loadResearchSource(
        {
          url,
          query: input.query,
          rendered: false,
          extractedVia: "search"
        },
        config,
        options
      )
    )
  );

  const result = buildClaimsFromSources(input.query, dedupeResearchSources(loaded), input.max_claims);
  return researchClaimsResultSchema.parse(result);
}
