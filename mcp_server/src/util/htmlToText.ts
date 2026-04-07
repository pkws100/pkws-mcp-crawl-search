import * as cheerio from "cheerio";
import { normalizeWhitespace, truncateText } from "./limits.js";

export interface HtmlTextResult {
  title?: string;
  text: string;
  truncated: boolean;
}

export function htmlToText(html: string, maxChars: number): HtmlTextResult {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const title = normalizeWhitespace($("title").first().text()) || undefined;
  const bodyText = normalizeWhitespace($("body").text() || $.root().text());
  const truncated = truncateText(bodyText, maxChars);

  return {
    title,
    text: truncated.value,
    truncated: truncated.truncated
  };
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links = new Set<string>();

  $("a[href]").each((_, element) => {
    const rawHref = $(element).attr("href");
    if (!rawHref) {
      return;
    }

    try {
      const resolved = new URL(rawHref, baseUrl);
      resolved.hash = "";
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        links.add(resolved.toString());
      }
    } catch {
      // ignore invalid links
    }
  });

  return [...links];
}
