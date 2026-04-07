type LogLevel = "info" | "warn" | "error";

function safeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const blockedKeys = new Set(["text", "html", "content", "token", "authorization", "body"]);
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => !blockedKeys.has(key.toLowerCase()))
  );
}

function write(level: LogLevel, event: string, details?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(safeDetails(details) ?? {})
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const log = {
  info: (event: string, details?: Record<string, unknown>) => write("info", event, details),
  warn: (event: string, details?: Record<string, unknown>) => write("warn", event, details),
  error: (event: string, details?: Record<string, unknown>) => write("error", event, details)
};
