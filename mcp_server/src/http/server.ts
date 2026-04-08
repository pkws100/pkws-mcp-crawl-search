import { randomUUID } from "node:crypto";
import type { Server as HttpServer, IncomingHttpHeaders } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import { createAuthMiddleware, createHostHeaderMiddleware } from "../auth.js";
import { createMcpServer } from "../mcp/mcpServer.js";
import { runWithRequestContext, type RequestContext } from "../util/requestContext.js";
import { log } from "../util/log.js";

const SESSION_HEADER = "mcp-session-id";
const SESSION_TTL_MS = 10 * 60 * 1_000;

type TransportMode = "streamable" | "json-compat";

interface SessionContext {
  mode: TransportMode;
  stateful: boolean;
  server: ReturnType<typeof createMcpServer>;
  transport: NodeStreamableHTTPServerTransport;
  sessionId?: string;
  cleanupTimer?: NodeJS.Timeout;
  closed: boolean;
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).type("application/json").send({
    jsonrpc: "2.0",
    error: {
      code: -32_000,
      message
    },
    id: null
  });
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getSessionHeader(req: Request): string | undefined {
  return getSingleHeader(req.headers[SESSION_HEADER]);
}

function getAcceptHeader(headers: IncomingHttpHeaders): string | undefined {
  return getSingleHeader(headers.accept);
}

function wantsEventStream(headers: IncomingHttpHeaders): boolean {
  return getAcceptHeader(headers)?.toLowerCase().includes("text/event-stream") ?? false;
}

function getRequestPath(req: Request): string {
  return req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;
}

function isInitializePayload(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((entry) => typeof entry === "object" && entry !== null && "method" in entry && (entry as { method?: unknown }).method === "initialize");
  }

  return typeof body === "object" && body !== null && "method" in body && (body as { method?: unknown }).method === "initialize";
}

function withPatchedAcceptHeader<T>(req: Request, nextAccept: string | undefined, fn: () => Promise<T>): Promise<T> {
  const originalAccept = req.headers.accept;
  const originalRawHeaders = [...req.rawHeaders];

  if (nextAccept !== undefined) {
    req.headers.accept = nextAccept;

    let replaced = false;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === "accept") {
        req.rawHeaders[index + 1] = nextAccept;
        replaced = true;
      }
    }

    if (!replaced) {
      req.rawHeaders.push("Accept", nextAccept);
    }
  }

  return fn().finally(() => {
    req.headers.accept = originalAccept;
    req.rawHeaders.splice(0, req.rawHeaders.length, ...originalRawHeaders);
  });
}

export function createHttpApp(config: AppConfig): Express {
  const app = express();
  const sessions = new Map<string, SessionContext>();

  const cleanupSession = async (context: SessionContext, reason: string): Promise<void> => {
    if (context.closed) {
      return;
    }

    context.closed = true;
    if (context.cleanupTimer) {
      clearTimeout(context.cleanupTimer);
      context.cleanupTimer = undefined;
    }

    if (context.sessionId) {
      sessions.delete(context.sessionId);
    }

    await context.transport.close().catch(() => undefined);
    await context.server.close().catch(() => undefined);

    log.info("mcp.session.closed", {
      session_id: context.sessionId,
      transport_mode: context.mode,
      reason
    });
  };

  const refreshSession = (context: SessionContext): void => {
    if (!context.stateful || !context.sessionId || context.closed) {
      return;
    }

    if (context.cleanupTimer) {
      clearTimeout(context.cleanupTimer);
    }

    context.cleanupTimer = setTimeout(() => {
      void cleanupSession(context, "session_ttl_expired");
    }, SESSION_TTL_MS);
  };

  const createSessionContext = async (mode: TransportMode, stateful: boolean): Promise<SessionContext> => {
    const server = createMcpServer(config);
    const context: SessionContext = {
      mode,
      stateful,
      server,
      transport: undefined as unknown as NodeStreamableHTTPServerTransport,
      closed: false
    };

    const transport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: mode === "json-compat",
      sessionIdGenerator: stateful ? () => randomUUID() : undefined,
      onsessioninitialized: async (sessionId) => {
        context.sessionId = sessionId;
        sessions.set(sessionId, context);
        refreshSession(context);
        log.info("mcp.session.initialized", {
          session_id: sessionId,
          transport_mode: mode
        });
      },
      onsessionclosed: async (sessionId) => {
        context.sessionId = sessionId;
        await cleanupSession(context, "transport_session_closed");
      }
    });

    context.transport = transport;
    transport.onclose = () => {
      void cleanupSession(context, "transport_closed");
    };
    transport.onerror = (error) => {
      log.warn("mcp.transport.error", {
        session_id: context.sessionId,
        transport_mode: mode,
        error: error.message
      });
    };

    await server.connect(transport);
    return context;
  };

  const applyCompatibilityHeaders = async (req: Request, context: SessionContext, run: () => Promise<void>): Promise<void> => {
    if (req.method !== "POST") {
      await run();
      return;
    }

    const currentAccept = getAcceptHeader(req.headers);
    const needsCompatAccept = context.mode === "json-compat"
      && (!currentAccept?.includes("application/json") || !currentAccept.includes("text/event-stream"));

    if (!needsCompatAccept) {
      await run();
      return;
    }

    await withPatchedAcceptHeader(req, "application/json, text/event-stream", run);
  };

  const logRequest = (req: Request, details?: Record<string, unknown>): void => {
    if (!config.mcpLogRequests) {
      return;
    }

    log.info("http.request", {
      method: req.method,
      route: getRequestPath(req),
      host: req.headers.host,
      accept: getAcceptHeader(req.headers),
      ...details
    });
  };

  const sendNegotiationInfo = (req: Request, res: Response): void => {
    res.status(200).json({
      status: "ok",
      endpoint: "/mcp",
      modes: ["streamable", "json-compat"],
      legacy_sse_path: config.mcpEnableLegacySse ? config.mcpLegacySsePath : null
    });

    logRequest(req, {
      transport_mode: "json-compat",
      reason: "reachability_probe"
    });
  };

  const executeTransport = async (req: Request, res: Response, next: NextFunction, options: { forceMode?: TransportMode; statefulOnly?: boolean } = {}): Promise<void> => {
    const requestId = randomUUID();
    const requestedSessionId = getSessionHeader(req);
    const existingContext = requestedSessionId ? sessions.get(requestedSessionId) : undefined;

    if (requestedSessionId && !existingContext) {
      log.warn("mcp.transport_session_missing", {
        request_id: requestId,
        session_id: requestedSessionId,
        method: req.method,
        route: getRequestPath(req)
      });
      jsonRpcError(res, 404, "Session not found");
      return;
    }

    let mode: TransportMode;
    let stateful: boolean;

    if (existingContext) {
      mode = existingContext.mode;
      stateful = existingContext.stateful;
    } else if (options.forceMode) {
      mode = options.forceMode;
      stateful = options.statefulOnly ?? true;
    } else if (req.method === "GET" && !wantsEventStream(req.headers)) {
      sendNegotiationInfo(req, res);
      return;
    } else if (wantsEventStream(req.headers)) {
      mode = "streamable";
      stateful = true;
    } else if (req.method === "POST" && isInitializePayload(req.body)) {
      mode = "json-compat";
      stateful = true;
    } else {
      mode = "json-compat";
      stateful = false;
    }

    let context = existingContext;
    let transientContext = false;

    if (!context) {
      context = await createSessionContext(mode, stateful);
      transientContext = !stateful;
    } else {
      refreshSession(context);
      log.info("mcp.session.reused", {
        request_id: requestId,
        session_id: context.sessionId,
        transport_mode: context.mode,
        method: req.method
      });
    }

    logRequest(req, {
      transport_mode: context.mode,
      stateful: context.stateful,
      has_session_id: Boolean(requestedSessionId)
    });

    const requestContext: RequestContext = {
      requestId,
      sessionId: requestedSessionId ?? context.sessionId,
      clientDisconnected: false
    };
    let responseFinished = false;

    const markDisconnect = () => {
      if (responseFinished || requestContext.clientDisconnected) {
        return;
      }

      requestContext.clientDisconnected = true;
      log.warn("http.client_disconnected", {
        request_id: requestId,
        session_id: requestContext.sessionId,
        method: req.method,
        path: req.originalUrl
      });
    };

    res.on("finish", () => {
      responseFinished = true;
    });
    req.on("aborted", markDisconnect);
    res.on("close", markDisconnect);

    try {
      await applyCompatibilityHeaders(req, context, async () => {
        await runWithRequestContext(requestContext, async () => {
          await context.transport.handleRequest(req, res, req.body);
        });
      });
      requestContext.sessionId = context.sessionId ?? requestContext.sessionId;
      refreshSession(context);
    } catch (error) {
      next(error);
    } finally {
      req.off("aborted", markDisconnect);
      res.off("close", markDisconnect);

      if (transientContext || (stateful && !context.sessionId)) {
        await cleanupSession(context, transientContext ? "transient_request_complete" : "stateful_request_without_session");
      }
    }
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  if (config.mcpLogRequests) {
    app.use((req, _res, next) => {
      logRequest(req);
      next();
    });
  }

  app.use(createHostHeaderMiddleware(config));

  const auth = createAuthMiddleware(config);
  app.use("/health", auth);
  app.use("/mcp", auth);

  if (config.mcpEnableLegacySse) {
    app.use(config.mcpLegacySsePath, auth);
  }

  app.get("/health", (_req, res) => {
    res.type("text/plain").status(200).send("ok");
  });

  app.get("/mcp", (req, res, next) => {
    void executeTransport(req, res, next);
  });
  app.post("/mcp", (req, res, next) => {
    void executeTransport(req, res, next);
  });
  app.delete("/mcp", (req, res, next) => {
    void executeTransport(req, res, next);
  });

  if (config.mcpEnableLegacySse) {
    app.get(config.mcpLegacySsePath, (req, res, next) => {
      void executeTransport(req, res, next, { forceMode: "streamable", statefulOnly: true });
    });
    app.post(config.mcpLegacySsePath, (req, res, next) => {
      void executeTransport(req, res, next, { forceMode: "streamable", statefulOnly: true });
    });
    app.delete(config.mcpLegacySsePath, (req, res, next) => {
      void executeTransport(req, res, next, { forceMode: "streamable", statefulOnly: true });
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error("http.unhandled", {
      error: error instanceof Error ? error.message : "Unknown error"
    });

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      error: "internal_server_error"
    });
  });

  return app;
}

export async function startHttpServer(config: AppConfig): Promise<HttpServer> {
  const app = createHttpApp(config);

  return new Promise((resolve, reject) => {
    const server = app.listen(config.mcpPort, config.mcpBind, () => {
      log.info("http.started", {
        bind: config.mcpBind,
        port: config.mcpPort
      });
      resolve(server);
    });

    server.on("error", reject);
  });
}
