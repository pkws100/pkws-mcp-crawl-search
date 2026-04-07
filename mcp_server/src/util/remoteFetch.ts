import type { AppConfig } from "../config.js";
import { ensurePublicHttpUrl, type LookupFn } from "./ssrfGuard.js";

export interface RemoteFetchResult {
  finalUrl: string;
  status: number;
  contentType?: string;
  bytes: number;
  truncated: boolean;
  buffer: Buffer;
}

export interface RemoteFetchOptions {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  accept?: string;
  fetchImpl?: typeof fetch;
  lookupFn?: LookupFn;
}

async function readBody(response: Response, maxBytes: number): Promise<{ buffer: Buffer; bytes: number; truncated: boolean }> {
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

  return { buffer: Buffer.concat(chunks), bytes, truncated };
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

export async function fetchRemoteResource(config: AppConfig, options: RemoteFetchOptions): Promise<RemoteFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    accept: options.accept ?? "*/*",
    "user-agent": options.userAgent
  };

  let currentUrl = (await ensurePublicHttpUrl(options.url, config, options.lookupFn)).toString();

  for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs)
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect response from ${currentUrl} missing Location header`);
      }

      currentUrl = (
        await ensurePublicHttpUrl(new URL(location, currentUrl).toString(), config, options.lookupFn)
      ).toString();
      continue;
    }

    const { buffer, bytes, truncated } = await readBody(response, options.maxBytes);
    return {
      finalUrl: currentUrl,
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      bytes,
      truncated,
      buffer
    };
  }

  throw new Error(`Too many redirects while fetching ${options.url}`);
}
