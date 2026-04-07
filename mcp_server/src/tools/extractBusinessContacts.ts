import { z } from "zod";
import type { AppConfig } from "../config.js";
import { renderPageSnapshot } from "./crawlRendered.js";
import { fetchPageSnapshot, type PageSnapshot } from "./fetchUrlText.js";
import {
  buildContactCandidateUrls,
  computeContactConfidence,
  extractContactsFromSnapshot,
  mergeBusinessContacts
} from "../util/contactExtract.js";
import { businessContactsSchema, contactPageSchema } from "../util/leadTypes.js";
import type { LookupFn } from "../util/ssrfGuard.js";

export const extractBusinessContactsInputSchema = z.object({
  url: z.string().url(),
  max_pages: z.number().int().min(1).max(10).default(5),
  prefer_paths: z.array(z.string().min(1).max(200)).max(20).optional(),
  rendered: z.boolean().default(false)
});

export const extractBusinessContactsResultSchema = z.object({
  site: z.object({
    final_url: z.string().url(),
    title: z.string().optional()
  }),
  contact_pages: z.array(contactPageSchema),
  contacts: businessContactsSchema,
  impressum_found: z.boolean(),
  confidence: z.number().int().min(0).max(100),
  sources: z.array(
    z.object({
      url: z.string().url(),
      extracted_fields: z.array(z.string())
    })
  )
});

export type ExtractBusinessContactsInput = z.infer<typeof extractBusinessContactsInputSchema>;
export type ExtractBusinessContactsResult = z.infer<typeof extractBusinessContactsResultSchema>;

async function loadSnapshot(
  url: string,
  rendered: boolean,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<PageSnapshot> {
  if (rendered) {
    const renderedSnapshot = await renderPageSnapshot(
      {
        url,
        wait_until: "networkidle",
        wait_ms: 750,
        max_chars: config.maxCharsPerPage,
        timeout_ms: 20_000
      },
      config,
      {
        lookupFn: options?.lookupFn
      }
    );

    return {
      final_url: renderedSnapshot.final_url,
      status: renderedSnapshot.status,
      title: renderedSnapshot.title,
      text: renderedSnapshot.text,
      content_type: "text/html",
      bytes: Buffer.byteLength(renderedSnapshot.html ?? "", "utf8"),
      truncated: renderedSnapshot.truncated,
      html: renderedSnapshot.html ?? "",
      extracted: renderedSnapshot.extracted
    };
  }

  return fetchPageSnapshot(
    {
      url,
      max_chars: config.maxCharsPerPage,
      timeout_ms: 15_000
    },
    config,
    options
  );
}

export async function executeExtractBusinessContacts(
  input: ExtractBusinessContactsInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<ExtractBusinessContactsResult> {
  const home = await loadSnapshot(input.url, input.rendered, config, options);
  const candidateUrls = buildContactCandidateUrls(
    home.final_url,
    home.html,
    input.prefer_paths,
    Math.max(1, input.max_pages)
  );

  const snapshots = new Map<string, PageSnapshot>();
  snapshots.set(home.final_url, home);

  for (const candidateUrl of candidateUrls) {
    if (snapshots.size >= input.max_pages) {
      break;
    }
    if (snapshots.has(candidateUrl)) {
      continue;
    }

    try {
      const snapshot = await loadSnapshot(candidateUrl, input.rendered, config, options);
      snapshots.set(snapshot.final_url, snapshot);
    } catch {
      // ignore individual contact page failures
    }
  }

  const parsed = [...snapshots.values()].map((snapshot) => extractContactsFromSnapshot(snapshot));
  const mergedContacts = mergeBusinessContacts(parsed.map((entry) => entry.contacts));
  const contactPages = parsed
    .filter((entry) => entry.page.page_type !== "other" || entry.extractedFields.length > 0)
    .map((entry) => entry.page);
  const sources = parsed
    .filter((entry) => entry.extractedFields.length > 0)
    .map((entry) => ({
      url: entry.page.url,
      extracted_fields: entry.extractedFields
    }));
  const impressumFound = parsed.some((entry) => entry.page.page_type === "impressum");
  const confidence = computeContactConfidence({
    impressumFound,
    pageCount: parsed.length,
    contacts: mergedContacts,
    hasWebsite: true
  });

  return extractBusinessContactsResultSchema.parse({
    site: {
      final_url: home.final_url,
      title: home.title
    },
    contact_pages: contactPages,
    contacts: mergedContacts,
    impressum_found: impressumFound,
    confidence,
    sources
  });
}
