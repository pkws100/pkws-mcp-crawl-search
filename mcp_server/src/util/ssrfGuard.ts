import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AppConfig } from "../config.js";

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFError";
  }
}

export type LookupFn = typeof lookup;

function stripIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }

  return value;
}

function ipv4ToNumbers(ip: string): number[] {
  return ip.split(".").map((segment) => Number(segment));
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ipv4ToNumbers(ip);

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(rawIp: string): boolean {
  const ip = stripIpv6Brackets(rawIp).toLowerCase();

  if (ip === "::" || ip === "::1") {
    return true;
  }

  if (ip.startsWith("::ffff:")) {
    return isPrivateIpv4(ip.slice("::ffff:".length));
  }

  if (ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }

  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
    return true;
  }

  return ip.startsWith("ff");
}

export function isPrivateIp(ip: string): boolean {
  const normalized = stripIpv6Brackets(ip);
  const version = isIP(normalized);

  if (version === 4) {
    return isPrivateIpv4(normalized);
  }

  if (version === 6) {
    return isPrivateIpv6(normalized);
  }

  return true;
}

async function resolveAddresses(hostname: string, lookupFn: LookupFn): Promise<string[]> {
  const resolved = await lookupFn(hostname, { all: true, verbatim: true });
  return resolved.map((entry) => entry.address);
}

export async function ensurePublicHttpUrl(
  input: string,
  config: Pick<AppConfig, "allowPrivateNet" | "blockPrivateNet">,
  lookupFn: LookupFn = lookup
): Promise<URL> {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new SSRFError(`Invalid URL: ${input}`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new SSRFError(`Unsupported URL protocol: ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new SSRFError("Credentialed URLs are not supported");
  }

  if (!config.blockPrivateNet || config.allowPrivateNet) {
    return url;
  }

  const hostname = stripIpv6Brackets(url.hostname);
  if (hostname.toLowerCase() === "localhost") {
    throw new SSRFError("localhost targets are blocked");
  }

  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    if (isPrivateIp(hostname)) {
      throw new SSRFError(`Private network target blocked: ${hostname}`);
    }

    return url;
  }

  const addresses = await resolveAddresses(hostname, lookupFn);
  if (addresses.length === 0) {
    throw new SSRFError(`Unable to resolve hostname: ${hostname}`);
  }

  const privateAddress = addresses.find((address) => isPrivateIp(address));
  if (privateAddress) {
    throw new SSRFError(`Resolved private network address blocked: ${privateAddress}`);
  }

  return url;
}
