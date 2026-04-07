import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ContentHeading, ExtractedContent } from "../util/contentExtract.js";
import type { ContentMetadata } from "../util/contentMetadata.js";
import { clampNumber, normalizeWhitespace, truncateText } from "../util/limits.js";
import { computeContentQuality } from "../util/quality.js";
import type { LookupFn } from "../util/ssrfGuard.js";
import { fetchPageSnapshot } from "./fetchUrlText.js";

export const fetchUrlMarkdownInputSchema = z.object({
  url: z.string().url(),
  max_chars: z.number().int().min(1).max(20_000).default(12_000),
  timeout_ms: z.number().int().min(1_000).max(30_000).default(15_000),
  user_agent: z.string().min(1).max(300).optional(),
  include_links: z.boolean().default(true)
});

const metadataSchema = z.object({
  canonical_url: z.string().optional(),
  meta_description: z.string().optional(),
  lang: z.string().optional(),
  author: z.string().optional(),
  published_at: z.string().optional(),
  modified_at: z.string().optional(),
  og_title: z.string().optional(),
  og_description: z.string().optional(),
  content_hash: z.string()
});

const headingSchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
  id: z.string().optional()
});

export const fetchUrlMarkdownResultSchema = z.object({
  final_url: z.string().url(),
  status: z.number().int().nonnegative(),
  title: z.string().optional(),
  markdown: z.string(),
  metadata: metadataSchema,
  headings: z.array(headingSchema),
  links: z.array(z.string().url()),
  quality: z.object({
    content_quality_score: z.number().int().min(0).max(100),
    boilerplate_ratio: z.number().min(0).max(1).optional(),
    word_count: z.number().int().nonnegative()
  }),
  content_type: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean()
});

export type FetchUrlMarkdownInput = z.infer<typeof fetchUrlMarkdownInputSchema>;
export type FetchUrlMarkdownResult = z.infer<typeof fetchUrlMarkdownResultSchema>;

function cleanInlineText(value: string): string {
  return normalizeWhitespace(value).replace(/\s+([.,!?;:])/g, "$1").trim();
}

function resolveMarkdownLink(href: string, baseUrl: string): string {
  try {
    const resolved = new URL(href, baseUrl);
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return href;
  }
}

function serializeInline($: cheerio.CheerioAPI, node: AnyNode, includeLinks: boolean, baseUrl: string): string {
  if (node.type === "text") {
    return node.data ?? "";
  }

  if (node.type !== "tag") {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === "a") {
    const text = cleanInlineText($(node).text());
    const href = $(node).attr("href");
    if (!includeLinks || !href || !text) {
      return text;
    }
    return `[${text}](${resolveMarkdownLink(href, baseUrl)})`;
  }

  if (tagName === "code") {
    return `\`${cleanInlineText($(node).text())}\``;
  }

  return $(node)
    .contents()
    .toArray()
    .map((child) => serializeInline($, child as AnyNode, includeLinks, baseUrl))
    .join("");
}

function htmlToMarkdown(html: string, includeLinks: boolean, baseUrl: string): string {
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  const lines: string[] = [];

  const renderChildren = (nodes: AnyNode[]) => {
    nodes.forEach((child) => renderNode(child));
  };

  const renderNode = (node: AnyNode) => {
    if (node.type === "text") {
      const text = cleanInlineText(node.data ?? "");
      if (text) {
        lines.push(text);
      }
      return;
    }

    if (node.type !== "tag") {
      return;
    }

    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const text = cleanInlineText(serializeInline($, node, includeLinks, baseUrl));
      if (text) {
        lines.push(`${"#".repeat(level)} ${text}`);
      }
      return;
    }

    if (tag === "pre") {
      const code = $(node).text().trim();
      if (code) {
        lines.push(`\`\`\`\n${code}\n\`\`\``);
      }
      return;
    }

    if (tag === "ul" || tag === "ol") {
      $(node)
        .children("li")
        .each((index, child) => {
          const prefix = tag === "ol" ? `${index + 1}.` : "-";
          const text = cleanInlineText(serializeInline($, child as AnyNode, includeLinks, baseUrl));
          if (text) {
            lines.push(`${prefix} ${text}`);
          }
        });
      return;
    }

    if (tag === "blockquote") {
      const text = cleanInlineText(serializeInline($, node, includeLinks, baseUrl));
      if (text) {
        lines.push(`> ${text}`);
      }
      return;
    }

    if (tag === "p") {
      const text = cleanInlineText(serializeInline($, node, includeLinks, baseUrl));
      if (text) {
        lines.push(text);
      }
      return;
    }

    if (["div", "section", "article", "main"].includes(tag)) {
      renderChildren($(node).contents().toArray());
      return;
    }

    const hasElementChildren = $(node)
      .contents()
      .toArray()
      .some((child) => child.type === "tag");

    if (hasElementChildren) {
      renderChildren($(node).contents().toArray());
      return;
    }

    const text = cleanInlineText(serializeInline($, node, includeLinks, baseUrl));
    if (text) {
      lines.push(text);
    }
  };

  $("#root")
    .contents()
    .toArray()
    .forEach((node) => renderNode(node as AnyNode));

  return lines.filter(Boolean).join("\n\n").trim();
}

function buildMetadata(metadata: ContentMetadata, contentHash: string): FetchUrlMarkdownResult["metadata"] {
  return {
    ...metadata,
    content_hash: contentHash
  };
}

type MarkdownSnapshot = {
  final_url: string;
  status: number;
  title?: string;
  content_type?: string;
  bytes?: number;
  truncated: boolean;
  html?: string;
  extracted: ExtractedContent;
};

export function buildMarkdownResult(
  snapshot: MarkdownSnapshot,
  options: {
    includeLinks: boolean;
    maxChars: number;
  }
): FetchUrlMarkdownResult {
  const rawMarkdown = htmlToMarkdown(snapshot.extracted.mainHtml ?? snapshot.html ?? "", options.includeLinks, snapshot.final_url);
  const markdown = truncateText(rawMarkdown, options.maxChars);

  return fetchUrlMarkdownResultSchema.parse({
    final_url: snapshot.final_url,
    status: snapshot.status,
    title: snapshot.title,
    markdown: markdown.value,
    metadata: buildMetadata(snapshot.extracted.metadata, snapshot.extracted.content_hash),
    headings: snapshot.extracted.headings as ContentHeading[],
    links: snapshot.extracted.links,
    quality: computeContentQuality(snapshot.extracted),
    content_type: "content_type" in snapshot ? snapshot.content_type : "text/html",
    bytes: snapshot.bytes ?? Buffer.byteLength(snapshot.html ?? snapshot.extracted.mainHtml ?? "", "utf8"),
    truncated: snapshot.truncated || markdown.truncated
  });
}

export async function executeFetchUrlMarkdown(
  input: FetchUrlMarkdownInput,
  config: AppConfig,
  options?: {
    fetchImpl?: typeof fetch;
    lookupFn?: LookupFn;
  }
): Promise<FetchUrlMarkdownResult> {
  const maxChars = clampNumber(input.max_chars, 1, config.maxCharsPerPage);
  const snapshot = await fetchPageSnapshot(
    {
      url: input.url,
      max_chars: maxChars,
      timeout_ms: input.timeout_ms,
      user_agent: input.user_agent
    },
    config,
    options
  );
  return buildMarkdownResult(snapshot, {
    includeLinks: input.include_links,
    maxChars
  });
}
