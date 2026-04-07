import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { extractMetadata, type ContentMetadata, createContentHash } from "./contentMetadata.js";
import { extractLinks } from "./htmlToText.js";
import { normalizeWhitespace, truncateText } from "./limits.js";

export interface ContentHeading {
  level: number;
  text: string;
  id?: string;
}

export interface ExtractedContent {
  title?: string;
  mainText: string;
  mainHtml?: string;
  headings: ContentHeading[];
  links: string[];
  metadata: ContentMetadata;
  content_hash: string;
  boilerplate_ratio?: number;
  truncated: boolean;
}

const BLOCKED_SELECTOR = [
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "header",
  "footer",
  "nav",
  "aside",
  "form",
  "[role='navigation']",
  "[role='complementary']",
  "[aria-label*='cookie' i]",
  "[class*='cookie' i]",
  "[id*='cookie' i]",
  "[class*='consent' i]",
  "[id*='consent' i]",
  "[class*='banner' i][class*='cookie' i]",
  "[id*='banner' i][id*='cookie' i]"
].join(", ");

function scoreCandidate($: cheerio.CheerioAPI, element: Element): number {
  const scope = $(element);
  const text = normalizeWhitespace(scope.text());
  const textLength = text.length;
  if (textLength < 200) {
    return -1;
  }

  const paragraphCount = scope.find("p").length;
  const headingCount = scope.find("h1, h2, h3").length;
  const listItemCount = scope.find("li").length;
  const linkTextLength = normalizeWhitespace(scope.find("a").text()).length;
  const linkDensity = textLength === 0 ? 0 : linkTextLength / textLength;
  const className = `${element.attribs?.class ?? ""} ${element.attribs?.id ?? ""}`.toLowerCase();
  const articleBonus = /(article|content|post|entry|main|docs|markdown|page)/.test(className) ? 180 : 0;
  const boilerplatePenalty = /(comment|footer|header|nav|sidebar|menu|breadcrumb)/.test(className) ? 220 : 0;

  return (
    textLength +
    paragraphCount * 120 +
    headingCount * 160 +
    listItemCount * 24 +
    articleBonus -
    Math.round(linkDensity * textLength * 1.4) -
    boilerplatePenalty
  );
}

function selectMainScope($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const prioritySelectors = ["main", "article", "[role='main']", ".main-content", "#main-content", "#content", ".content"];

  for (const selector of prioritySelectors) {
    const scope = $(selector).first();
    if (scope.length && normalizeWhitespace(scope.text()).length >= 120) {
      return scope;
    }
  }

  let bestElement: Element | undefined;
  let bestScore = -Infinity;

  $("body, body *").each((_, element) => {
    if (!element.tagName) {
      return;
    }
    const score = scoreCandidate($, element);
    if (score > bestScore) {
      bestScore = score;
      bestElement = element;
    }
  });

  return bestElement ? $(bestElement) : $("body").first();
}

function fallbackText($: cheerio.CheerioAPI): string {
  return normalizeWhitespace($("body").text() || $.root().text());
}

export function extractContent(html: string, options?: { maxChars?: number; finalUrl?: string }): ExtractedContent {
  const $ = cheerio.load(html);
  const fullTextBefore = fallbackText($);
  const title = normalizeWhitespace($("title").first().text()) || undefined;
  const metadata = extractMetadata($, options?.finalUrl);

  $(BLOCKED_SELECTOR).remove();

  const scope = selectMainScope($);
  const clonedScope = cheerio.load("<div></div>");
  clonedScope("div").append(scope.clone());
  clonedScope(BLOCKED_SELECTOR).remove();

  const headings: ContentHeading[] = [];
  clonedScope("h1, h2, h3, h4, h5, h6").each((_, element) => {
    const tagName = element.tagName?.toLowerCase();
    const text = normalizeWhitespace(clonedScope(element).text());
    const level = tagName ? Number(tagName.slice(1)) : NaN;
    if (!text || Number.isNaN(level)) {
      return;
    }

    headings.push({
      level,
      text,
      id: clonedScope(element).attr("id") || undefined
    });
  });

  const mainHtml = clonedScope("div").html() ?? scope.html() ?? "";
  let mainText = normalizeWhitespace(clonedScope("div").text());
  if (!mainText) {
    mainText = fallbackText($);
  }

  const truncatedResult = options?.maxChars ? truncateText(mainText, options.maxChars) : { value: mainText, truncated: false };
  const boilerplateRatio =
    fullTextBefore.length > 0
      ? Number(Math.max(0, 1 - mainText.length / fullTextBefore.length).toFixed(4))
      : undefined;

  return {
    title,
    mainText: truncatedResult.value,
    mainHtml,
    headings,
    links: options?.finalUrl ? extractLinks(mainHtml || html, options.finalUrl) : [],
    metadata,
    content_hash: createContentHash(mainText),
    boilerplate_ratio: boilerplateRatio,
    truncated: truncatedResult.truncated
  };
}

export const extractMainContent = extractContent;



