import os from "node:os";
import { isIP } from "node:net";
import type { RequestHandler } from "express";
import type { AppConfig } from "./config.js";
import { log } from "./util/log.js";

export function createAuthMiddleware(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (!config.mcpAuthToken) {
      next();
      return;
    }

    const header = req.header("authorization");
    if (header !== `Bearer ${config.mcpAuthToken}`) {
      log.warn("http.request.rejected", {
        reason: "unauthorized",
        method: req.method,
        route: req.originalUrl,
        host: req.headers.host,
        accept: req.header("accept")
      });
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
}

function normalizeHost(host: string): string {
  if (host.startsWith("[")) {
    const bracketIndex = host.indexOf("]");
    return (bracketIndex === -1 ? host : host.slice(0, bracketIndex + 1)).toLowerCase();
  }

  return host.split(":")[0].toLowerCase();
}

function hostVariants(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const normalized = value.toLowerCase();
  if (normalized === "::1") {
    return ["[::1]", "::1"];
  }

  if (normalized.startsWith("::ffff:")) {
    return [normalized, normalized.slice("::ffff:".length)];
  }

  if (normalized.includes(":") && !normalized.startsWith("[")) {
    return [normalized, `[${normalized}]`];
  }

  return [normalized];
}

function buildAllowedHosts(config: AppConfig, localAddress: string | undefined): Set<string> {
  const allowedHosts = new Set<string>(["localhost", "127.0.0.1", "[::1]", "host.docker.internal", os.hostname().toLowerCase()]);

  for (const host of config.mcpAllowedHosts) {
    for (const variant of hostVariants(normalizeHost(host))) {
      allowedHosts.add(variant);
    }
  }

  for (const variant of hostVariants(localAddress)) {
    allowedHosts.add(variant);
  }

  if (config.mcpBind !== "0.0.0.0" && config.mcpBind !== "::") {
    for (const variant of hostVariants(config.mcpBind)) {
      allowedHosts.add(variant);
    }
  }

  return allowedHosts;
}

export function createHostHeaderMiddleware(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      log.warn("http.request.rejected", {
        reason: "missing_host_header",
        method: req.method,
        route: req.originalUrl,
        accept: req.header("accept")
      });
      res.status(400).json({ error: "missing_host_header" });
      return;
    }

    const allowedHosts = buildAllowedHosts(config, req.socket.localAddress);
    const normalized = normalizeHost(hostHeader);
    if (isIP(normalized.replace(/^\[|\]$/g, "")) !== 0) {
      next();
      return;
    }

    if (!allowedHosts.has(normalized)) {
      log.warn("http.request.rejected", {
        reason: "invalid_host_header",
        method: req.method,
        route: req.originalUrl,
        host: hostHeader,
        normalized_host: normalized,
        accept: req.header("accept")
      });
      res.status(403).json({ error: "invalid_host_header" });
      return;
    }

    next();
  };
}
