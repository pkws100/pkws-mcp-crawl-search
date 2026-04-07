export type UrlMatchMode = "url" | "pathname" | "host";

export interface UrlFilterOptions {
  includePatterns?: string[];
  excludePatterns?: string[];
  excludePaths?: string[];
  excludeQueryParams?: string[];
  sameDomainOnly?: boolean;
  startUrl?: string | URL;
}

export interface UrlFilterDecision {
  allowed: boolean;
  reason?: "included" | "same_domain_only" | "include_pattern" | "exclude_pattern" | "exclude_path";
  normalizedUrl: string;
  matchedPattern?: string;
}

export interface NormalizedUrlResult {
  url: URL;
  normalizedUrl: string;
  strippedQueryParams: string[];
}

function toUrl(input: string | URL): URL {
  return input instanceof URL ? new URL(input.toString()) : new URL(input);
}

function globToRegExp(pattern: string, mode: UrlMatchMode): RegExp {
  let expression = "^";

  for (const char of pattern) {
    if (char === "*") {
      expression += ".*";
      continue;
    }

    if (char === "?") {
      expression += ".";
      continue;
    }

    if (/[\\^$.*+?()[\]{}|]/.test(char)) {
      expression += `\\${char}`;
      continue;
    }

    expression += char;
  }

  if (mode === "url") {
    expression = expression.replace(/^\^/, "").replace(/\$$/, "");
  } else {
    expression += "$";
  }

  return new RegExp(expression, "i");
}

function matchAny(value: string, patterns: string[] | undefined, mode: UrlMatchMode): string | undefined {
  if (!patterns || patterns.length === 0) {
    return undefined;
  }

  for (const pattern of patterns) {
    try {
      if (globToRegExp(pattern, mode).test(value)) {
        return pattern;
      }
    } catch {
      if (value.toLowerCase().includes(pattern.toLowerCase())) {
        return pattern;
      }
    }
  }

  return undefined;
}

export function normalizeUrlForCrawl(
  input: string | URL,
  options: Pick<UrlFilterOptions, "excludeQueryParams"> = {}
): NormalizedUrlResult {
  const url = toUrl(input);
  const strippedQueryParams: string[] = [];

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  for (const param of options.excludeQueryParams ?? []) {
    if (url.searchParams.has(param)) {
      strippedQueryParams.push(param);
      url.searchParams.delete(param);
    }
  }

  return {
    url,
    normalizedUrl: url.toString(),
    strippedQueryParams
  };
}

export function shouldIncludeUrl(input: string | URL, options: UrlFilterOptions = {}): UrlFilterDecision {
  const normalized = normalizeUrlForCrawl(input, options);

  if (options.sameDomainOnly && options.startUrl) {
    const start = toUrl(options.startUrl);
    if (normalized.url.origin !== start.origin) {
      return {
        allowed: false,
        reason: "same_domain_only",
        normalizedUrl: normalized.normalizedUrl
      };
    }
  }

  const excludedPath = matchAny(normalized.url.pathname, options.excludePaths, "pathname");
  if (excludedPath) {
    return {
      allowed: false,
      reason: "exclude_path",
      matchedPattern: excludedPath,
      normalizedUrl: normalized.normalizedUrl
    };
  }

  const excludedPattern = matchAny(normalized.normalizedUrl, options.excludePatterns, "url");
  if (excludedPattern) {
    return {
      allowed: false,
      reason: "exclude_pattern",
      matchedPattern: excludedPattern,
      normalizedUrl: normalized.normalizedUrl
    };
  }

  if (options.includePatterns && options.includePatterns.length > 0) {
    const includedPattern = matchAny(normalized.normalizedUrl, options.includePatterns, "url");
    if (!includedPattern) {
      return {
        allowed: false,
        reason: "include_pattern",
        normalizedUrl: normalized.normalizedUrl
      };
    }

    return {
      allowed: true,
      reason: "included",
      matchedPattern: includedPattern,
      normalizedUrl: normalized.normalizedUrl
    };
  }

  return {
    allowed: true,
    normalizedUrl: normalized.normalizedUrl
  };
}

export function filterUrls(inputs: Array<string | URL>, options: UrlFilterOptions = {}): UrlFilterDecision[] {
  return inputs.map((input) => shouldIncludeUrl(input, options));
}
