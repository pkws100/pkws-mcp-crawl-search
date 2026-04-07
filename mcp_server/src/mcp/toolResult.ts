function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function toToolResult<T>(payload: T) {
  const content = [
    {
      type: "text" as const,
      text: JSON.stringify(payload, null, 2)
    }
  ];

  if (isPlainObject(payload)) {
    return {
      content,
      structuredContent: payload
    };
  }

  return {
    content
  };
}

export function isStructuredContentCandidate(value: unknown): boolean {
  return isPlainObject(value);
}
