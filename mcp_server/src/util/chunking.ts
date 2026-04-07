import * as cheerio from "cheerio";
import type { ExtractedContent } from "./contentExtract.js";
import { normalizeWhitespace } from "./limits.js";

export interface ContentChunk {
  chunk_id: string;
  heading_path: string[];
  text: string;
  start_char: number;
  end_char: number;
}

function splitWithOverlap(text: string, chunkSize: number, overlap: number): Array<{ text: string; start: number; end: number }> {
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const slice = text.slice(start, end).trim();
    if (slice) {
      chunks.push({ text: slice, start, end });
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function sectionizeByHeadings(extracted: ExtractedContent): Array<{ heading_path: string[]; text: string }> {
  if (!extracted.mainHtml) {
    return [{ heading_path: [], text: extracted.mainText }];
  }

  const $ = cheerio.load(`<div id="root">${extracted.mainHtml}</div>`);
  const sections: Array<{ heading_path: string[]; text: string }> = [];
  const headingPath: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = normalizeWhitespace(buffer.join(" "));
    if (text) {
      sections.push({
        heading_path: [...headingPath],
        text
      });
    }
    buffer = [];
  };

  $("#root")
    .find("h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, div")
    .each((_, node) => {
      if (node.type === "tag" && /^h[1-6]$/i.test(node.tagName)) {
        flush();
        const level = Number(node.tagName.slice(1));
        const text = normalizeWhitespace($(node).text());
        if (!text) {
          return;
        }
        headingPath.splice(level - 1);
        headingPath[level - 1] = text;
        return;
      }

      const text = normalizeWhitespace($(node).text());
      if (text) {
        buffer.push(text);
      }
    });

  flush();
  return sections.length > 0 ? sections : [{ heading_path: [], text: extracted.mainText }];
}

export function buildChunks(
  extracted: ExtractedContent,
  options: {
    chunkSize: number;
    overlap: number;
    maxChunks: number;
    strategy: "heading" | "fixed";
  }
): ContentChunk[] {
  const sections =
    options.strategy === "heading"
      ? sectionizeByHeadings(extracted)
      : [{ heading_path: [], text: extracted.mainText }];

  const chunks: ContentChunk[] = [];
  let globalIndex = 0;
  let chunkCounter = 0;

  for (const section of sections) {
    const pieces = splitWithOverlap(section.text, options.chunkSize, options.overlap);
    for (const piece of pieces) {
      if (chunks.length >= options.maxChunks) {
        return chunks;
      }

      chunks.push({
        chunk_id: `chunk-${++chunkCounter}`,
        heading_path: section.heading_path.filter(Boolean),
        text: piece.text,
        start_char: globalIndex + piece.start,
        end_char: globalIndex + piece.end
      });
    }
    globalIndex += section.text.length + 1;
  }

  return chunks;
}
