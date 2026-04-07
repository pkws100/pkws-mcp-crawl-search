export function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }

  return {
    value: value.slice(0, maxChars),
    truncated: true
  };
}

export function truncateUtf8ByBytes(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return {
      value,
      bytes: buffer.byteLength,
      truncated: false
    };
  }

  return {
    value: buffer.subarray(0, maxBytes).toString("utf8"),
    bytes: maxBytes,
    truncated: true
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
