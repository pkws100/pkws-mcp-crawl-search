import { z } from "zod";

export const leadSourceTypeValues = ["website", "directory", "search"] as const;
export const contactPageTypeValues = ["impressum", "kontakt", "about", "team", "other"] as const;
export const leadSourceStrategyValues = ["hybrid_public"] as const;

export const businessContactsSchema = z.object({
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  addresses: z.array(z.string()),
  contact_people: z.array(z.string()),
  organization_names: z.array(z.string())
});

export const contactPageSchema = z.object({
  url: z.string().url(),
  page_type: z.enum(contactPageTypeValues)
});

export const leadSourceSchema = z.object({
  url: z.string().url(),
  source_type: z.enum(leadSourceTypeValues),
  trust_score: z.number().int().min(0).max(100).optional(),
  extracted_fields: z.array(z.string()).optional()
});

export const leadSchema = z.object({
  lead_id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  location: z.string().optional(),
  postal_code: z.string().optional(),
  website: z.string().url().optional(),
  contact_pages: z.array(z.string().url()),
  contacts: businessContactsSchema,
  sources: z.array(leadSourceSchema),
  confidence: z.number().int().min(0).max(100),
  notes: z.array(z.string())
});

export const interpretedLeadQuerySchema = z.object({
  category: z.string().optional(),
  location: z.string().optional(),
  postal_code: z.string().optional(),
  person: z.string().optional(),
  organization: z.string().optional(),
  free_text: z.string()
});

export type BusinessContacts = z.infer<typeof businessContactsSchema>;
export type ContactPage = z.infer<typeof contactPageSchema>;
export type ContactPageType = z.infer<typeof contactPageSchema>["page_type"];
export type Lead = z.infer<typeof leadSchema>;
export type LeadSource = z.infer<typeof leadSourceSchema>;
export type InterpretedLeadQuery = z.infer<typeof interpretedLeadQuerySchema>;
