export type DedupeMode = "canonical" | "content_hash" | "canonical_and_hash" | "none";

export interface DedupeCandidate {
  url: string;
  canonicalUrl?: string;
  contentHash?: string;
}

export interface DedupeDecision {
  duplicate: boolean;
  matchedOn?: "url" | "canonical_url" | "content_hash";
  normalizedUrl: string;
  normalizedCanonicalUrl?: string;
  normalizedContentHash?: string;
}

export interface DedupeState {
  mode: DedupeMode;
  seenUrls: Set<string>;
  seenCanonicalUrls: Set<string>;
  seenContentHashes: Set<string>;
}

export function createDedupeState(mode: DedupeMode = "canonical_and_hash"): DedupeState {
  return {
    mode,
    seenUrls: new Set<string>(),
    seenCanonicalUrls: new Set<string>(),
    seenContentHashes: new Set<string>()
  };
}

function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

function normalizeContentHash(input: string): string {
  return input.trim().toLowerCase();
}

export function checkDuplicate(candidate: DedupeCandidate, state: DedupeState): DedupeDecision {
  const normalizedUrl = normalizeUrl(candidate.url);
  const normalizedCanonicalUrl = candidate.canonicalUrl ? normalizeUrl(candidate.canonicalUrl) : undefined;
  const normalizedContentHash = candidate.contentHash ? normalizeContentHash(candidate.contentHash) : undefined;

  if (state.mode === "none") {
    state.seenUrls.add(normalizedUrl);
    if (normalizedCanonicalUrl) {
      state.seenCanonicalUrls.add(normalizedCanonicalUrl);
    }
    if (normalizedContentHash) {
      state.seenContentHashes.add(normalizedContentHash);
    }

    return {
      duplicate: false,
      normalizedUrl,
      normalizedCanonicalUrl,
      normalizedContentHash
    };
  }

  if (state.seenUrls.has(normalizedUrl)) {
    return {
      duplicate: true,
      matchedOn: "url",
      normalizedUrl,
      normalizedCanonicalUrl,
      normalizedContentHash
    };
  }

  if ((state.mode === "canonical" || state.mode === "canonical_and_hash") && normalizedCanonicalUrl) {
    if (state.seenCanonicalUrls.has(normalizedCanonicalUrl)) {
      return {
        duplicate: true,
        matchedOn: "canonical_url",
        normalizedUrl,
        normalizedCanonicalUrl,
        normalizedContentHash
      };
    }
  }

  if ((state.mode === "content_hash" || state.mode === "canonical_and_hash") && normalizedContentHash) {
    if (state.seenContentHashes.has(normalizedContentHash)) {
      return {
        duplicate: true,
        matchedOn: "content_hash",
        normalizedUrl,
        normalizedCanonicalUrl,
        normalizedContentHash
      };
    }
  }

  state.seenUrls.add(normalizedUrl);
  if (normalizedCanonicalUrl) {
    state.seenCanonicalUrls.add(normalizedCanonicalUrl);
  }
  if (normalizedContentHash) {
    state.seenContentHashes.add(normalizedContentHash);
  }

  return {
    duplicate: false,
    normalizedUrl,
    normalizedCanonicalUrl,
    normalizedContentHash
  };
}

export function isDuplicate(candidate: DedupeCandidate, state: DedupeState): boolean {
  return checkDuplicate(candidate, state).duplicate;
}
