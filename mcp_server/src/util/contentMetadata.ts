import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { normalizeWhitespace } from "./limits.js";

export interface ContentMetadata {
  canonical_url?: string;
  meta_description?: string;
  lang?: string;
  author?: string;
  published_at?: string;
  modified_at?: string;
  og_title?: string;
  og_description?: string;
}

function firstContent($: cheerio.CheerioAPI, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const value = normalizeWhitespace($(selector).first().attr("content") ?? $(selector).first().text());
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function extractMetadata($: cheerio.CheerioAPI, finalUrl?: string): ContentMetadata {
  const canonicalHref = $("link[rel='canonical']").first().attr("href");
  let canonicalUrl: string | undefined;

  if (canonicalHref) {
    try {
      canonicalUrl = finalUrl ? new URL(canonicalHref, finalUrl).toString() : canonicalHref;
    } catch {
      canonicalUrl = canonicalHref;
    }
  }

  return {
    canonical_url: canonicalUrl,
    meta_description: firstContent($, [
      "meta[name='description']",
      "meta[property='og:description']",
      "meta[name='twitter:description']"
    ]),
    lang: $("html").first().attr("lang") || undefined,
    author: firstContent($, [
      "meta[name='author']",
      "meta[property='article:author']",
      "[rel='author']"
    ]),
    published_at: firstContent($, [
      "meta[property='article:published_time']",
      "meta[name='pubdate']",
      "time[datetime]"
    ]),
    modified_at: firstContent($, [
      "meta[property='article:modified_time']",
      "meta[name='last-modified']",
      "meta[http-equiv='last-modified']"
    ]),
    og_title: firstContent($, ["meta[property='og:title']", "meta[name='twitter:title']"]),
    og_description: firstContent($, ["meta[property='og:description']", "meta[name='twitter:description']"])
  };
}

export function createContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
