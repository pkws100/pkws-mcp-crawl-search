import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { AppConfig } from "../config.js";
import { extractMainContent } from "./contentExtract.js";
import { normalizeWhitespace, truncateText } from "./limits.js";
import { ensurePublicHttpUrl, type LookupFn } from "./ssrfGuard.js";

export type DocumentKind = "pdf" | "html" | "text";

export interface DocumentExtractionResult {
  final_url: string;
  status: number;
  content_type: string;
  title?: string;
  text: string;
  page_count?: number;
  bytes: number;
  truncated: boolean;
}

export interface DocumentFetchOptions {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  maxChars: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
  lookupFn?: LookupFn;
}

interface BodyReadResult {
  buffer: Buffer;
  bytes: number;
  truncated: boolean;
}

interface ParsedDocumentType {
  kind: DocumentKind;
  contentType: string;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function normalizeContentType(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const [type] = value.split(";", 1);
  const normalized = type.trim().toLowerCase();
  return normalized || undefined;
}

function getUrlExtension(inputUrl: string): string | undefined {
  try {
    const url = new URL(inputUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (!last || !last.includes(".")) {
      return undefined;
    }

    return last.slice(last.lastIndexOf(".")).toLowerCase();
  } catch {
    return undefined;
  }
}

function getContentDispositionFilename(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const starMatch = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[2].trim().replace(/^"|"$/g, ""));
    } catch {
      return starMatch[2].trim().replace(/^"|"$/g, "");
    }
  }

  const plainMatch = /filename\s*=\s*("?)([^";]+)\1/i.exec(value);
  if (plainMatch) {
    return plainMatch[2].trim();
  }

  return undefined;
}

function getFilenameExtension(filename: string | undefined): string | undefined {
  if (!filename || !filename.includes(".")) {
    return undefined;
  }

  return filename.slice(filename.lastIndexOf(".")).toLowerCase();
}

function trimAsciiWhitespace(value: string): string {
  return value.replace(/^[\s\u0000-\u001f]+|[\s\u0000-\u001f]+$/g, "");
}

function bufferStartsWithPdf(buffer: Buffer): boolean {
  const prefix = trimAsciiWhitespace(buffer.subarray(0, 32).toString("latin1"));
  return prefix.startsWith("%PDF-");
}

function bufferLooksLikeHtml(buffer: Buffer): boolean {
  const sample = trimAsciiWhitespace(buffer.subarray(0, 512).toString("utf8")).toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html") || sample.startsWith("<head") || sample.startsWith("<body") || sample.startsWith("<");
}

function bufferLooksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4_096));
  if (sample.includes(0)) {
    return false;
  }

  let printable = 0;
  for (const byte of sample) {
    if (
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126) ||
      byte >= 0xc2
    ) {
      printable += 1;
    }
  }

  return sample.length === 0 ? true : printable / sample.length >= 0.8;
}

function isPdfContentType(contentType: string | undefined): boolean {
  return Boolean(contentType && (contentType === "application/pdf" || contentType.endsWith("+pdf")));
}

function isHtmlContentType(contentType: string | undefined): boolean {
  return Boolean(contentType && (contentType === "text/html" || contentType === "application/xhtml+xml" || contentType.endsWith("+xml")));
}

function isTextContentType(contentType: string | undefined): boolean {
  return Boolean(
    contentType &&
      (contentType.startsWith("text/") ||
        contentType === "application/json" ||
        contentType === "application/xml" ||
        contentType === "application/xhtml+xml")
  );
}

function resolveDocumentType(options: {
  finalUrl: string;
  contentType?: string;
  contentDisposition?: string | null;
  body: Buffer;
}): ParsedDocumentType {
  const extension = getUrlExtension(options.finalUrl);
  const filenameExtension = getFilenameExtension(getContentDispositionFilename(options.contentDisposition ?? null));

  const pdfBySignal =
    isPdfContentType(options.contentType) ||
    extension === ".pdf" ||
    filenameExtension === ".pdf" ||
    bufferStartsWithPdf(options.body);
  if (pdfBySignal) {
    return { kind: "pdf", contentType: "application/pdf" };
  }

  const htmlBySignal =
    isHtmlContentType(options.contentType) ||
    extension === ".html" ||
    extension === ".htm" ||
    bufferLooksLikeHtml(options.body);
  if (htmlBySignal) {
    return { kind: "html", contentType: "text/html" };
  }

  const textBySignal =
    isTextContentType(options.contentType) ||
    extension === ".txt" ||
    extension === ".md" ||
    extension === ".csv" ||
    extension === ".xml" ||
    extension === ".json" ||
    bufferLooksLikeText(options.body);
  if (textBySignal) {
    return {
      kind: "text",
      contentType:
        options.contentType && options.contentType !== "application/octet-stream" ? options.contentType : "text/plain"
    };
  }

  return { kind: "text", contentType: options.contentType ?? "application/octet-stream" };
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<BodyReadResult> {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), bytes: 0, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }

    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(Buffer.from(value));
    bytes += value.byteLength;
  }

  return {
    buffer: Buffer.concat(chunks),
    bytes,
    truncated
  };
}

function normalizePlainText(value: string): string {
  const lines = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+$/g, ""));

  return lines.join("\n").replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function readPdfTitle(info: unknown): string | undefined {
  if (!info || typeof info !== "object") {
    return undefined;
  }

  const candidate = (info as Record<string, unknown>).Title ?? (info as Record<string, unknown>).title;
  if (typeof candidate !== "string") {
    return undefined;
  }

  const title = normalizeWhitespace(candidate);
  return title || undefined;
}

async function extractPdfText(
  buffer: Buffer,
  maxChars: number
): Promise<{ title?: string; text: string; pageCount?: number; truncated: boolean }> {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const document = await loadingTask.promise;

  try {
    const metadata = await document.getMetadata().catch(() => undefined);
    const title = readPdfTitle(metadata?.info) ?? readPdfTitle(metadata?.metadata);
    const parts: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item) =>
            typeof item === "object" && item !== null && "str" in item
              ? String((item as { str?: unknown }).str ?? "")
              : ""
          )
          .filter(Boolean)
          .join(" ");
        const normalized = normalizePlainText(pageText);
        if (normalized) {
          parts.push(normalized);
        }
      } finally {
        await Promise.resolve(page.cleanup());
      }
    }

    const rawText = parts.join("\n\n");
    const text = truncateText(rawText, maxChars);

    return {
      title,
      text: text.value,
      pageCount: document.numPages,
      truncated: text.truncated
    };
  } finally {
    await Promise.resolve(document.destroy());
  }
}

function extractHtmlText(buffer: Buffer, finalUrl: string, maxChars: number): { title?: string; text: string; truncated: boolean } {
  const html = buffer.toString("utf8");
  const extracted = extractMainContent(html, {
    finalUrl,
    maxChars
  });

  return {
    title: extracted.title,
    text: extracted.mainText,
    truncated: extracted.truncated
  };
}

function extractTextFallback(buffer: Buffer, maxChars: number): { text: string; truncated: boolean } {
  const decoded = normalizePlainText(buffer.toString("utf8"));
  const truncated = truncateText(decoded, maxChars);

  return {
    text: truncated.value,
    truncated: truncated.truncated
  };
}

export async function fetchDocumentExtraction(
  input: DocumentFetchOptions,
  config: AppConfig
): Promise<DocumentExtractionResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let currentUrl = (await ensurePublicHttpUrl(input.url, config, input.lookupFn)).toString();

  for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/pdf,text/html,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": input.userAgent
      },
      signal: AbortSignal.timeout(input.timeoutMs)
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect response from ${currentUrl} missing Location header`);
      }

      currentUrl = (
        await ensurePublicHttpUrl(new URL(location, currentUrl).toString(), config, input.lookupFn)
      ).toString();
      continue;
    }

    const contentType = normalizeContentType(response.headers.get("content-type"));
    const contentDisposition = response.headers.get("content-disposition");
    const { buffer, bytes, truncated } = await readLimitedBody(response, config.maxHtmlBytes);
    const documentType = resolveDocumentType({
      finalUrl: currentUrl,
      contentType,
      contentDisposition,
      body: buffer
    });

    if (documentType.kind === "pdf") {
      const pdf = await extractPdfText(buffer, input.maxChars);
      return {
        final_url: currentUrl,
        status: response.status,
        content_type: documentType.contentType,
        title: pdf.title,
        text: pdf.text,
        page_count: pdf.pageCount,
        bytes,
        truncated: truncated || pdf.truncated
      };
    }

    if (documentType.kind === "html") {
      const extracted = extractHtmlText(buffer, currentUrl, input.maxChars);
      return {
        final_url: currentUrl,
        status: response.status,
        content_type: documentType.contentType,
        title: extracted.title,
        text: extracted.text,
        bytes,
        truncated: truncated || extracted.truncated
      };
    }

    const text = extractTextFallback(buffer, input.maxChars);
    return {
      final_url: currentUrl,
      status: response.status,
      content_type: documentType.contentType,
      text: text.text,
      bytes,
      truncated: truncated || text.truncated
    };
  }

  throw new Error(`Too many redirects while fetching ${input.url}`);
}
