import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Express } from "express";
import type { AppConfig } from "../config.js";
import { createAuthMiddleware, createHostHeaderMiddleware } from "../auth.js";
import { createMcpServer } from "../mcp/mcpServer.js";
import { runWithRequestContext, type RequestContext } from "../util/requestContext.js";
import { log } from "../util/log.js";

const SESSION_HEADER = "mcp-session-id";
const SESSION_TTL_MS = 10 * 60 * 1_000;

interface SessionContext {
  server: ReturnType<typeof createMcpServer>;
  transport: NodeStreamableHTTPServerTransport;
  sessionId?: string;
  cleanupTimer?: NodeJS.Timeout;
  closed: boolean;
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32_000,
        message
      },
      id: null
    })
  );
}

function getSessionHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers[SESSION_HEADER];
  if (Array.isArray(raw)) {
    return raw[0];
  }

  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function createHttpApp(config: AppConfig): Express {
  const app = createMcpExpressApp({
    host: config.mcpBind,
    jsonLimit: "1mb"
  });
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
      reason
    });
  };

  const refreshSession = (context: SessionContext): void => {
    if (!context.sessionId || context.closed) {
      return;
    }

    if (context.cleanupTimer) {
      clearTimeout(context.cleanupTimer);
    }

    context.cleanupTimer = setTimeout(() => {
      void cleanupSession(context, "session_ttl_expired");
    }, SESSION_TTL_MS);
  };

  const createSessionContext = async (): Promise<SessionContext> => {
    const server = createMcpServer(config);
    const context: SessionContext = {
      server,
      transport: undefined as unknown as NodeStreamableHTTPServerTransport,
      closed: false
    };

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: async (sessionId) => {
        context.sessionId = sessionId;
        sessions.set(sessionId, context);
        refreshSession(context);
        log.info("mcp.session.initialized", {
          session_id: sessionId
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
        error: error.message
      });
    };

    await server.connect(transport);
    return context;
  };

  const handleMcp = async (req: IncomingMessage & { body?: unknown }, res: ServerResponse, next: (error?: unknown) => void) => {
    const requestId = randomUUID();
    const requestedSessionId = getSessionHeader(req);
    let context = requestedSessionId ? sessions.get(requestedSessionId) : undefined;

    if (!context && requestedSessionId) {
      log.warn("mcp.transport_session_missing", {
        request_id: requestId,
        session_id: requestedSessionId,
        method: req.method
      });
      jsonRpcError(res, 404, "Session not found");
      return;
    }

    let transientContext = false;
    if (!context) {
      context = await createSessionContext();
      transientContext = true;
    } else {
      refreshSession(context);
      log.info("mcp.session.reused", {
        request_id: requestId,
        session_id: context.sessionId,
        method: req.method
      });
    }

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
        path: req.url
      });
    };

    res.on("finish", () => {
      responseFinished = true;
    });
    req.on("aborted", markDisconnect);
    res.on("close", markDisconnect);

    try {
      await runWithRequestContext(requestContext, async () => {
        await context.transport.handleRequest(req, res, req.body);
      });
      requestContext.sessionId = context.sessionId ?? requestContext.sessionId;
      refreshSession(context);
    } catch (error) {
      next(error);
    } finally {
      req.off("aborted", markDisconnect);
      res.off("close", markDisconnect);

      if (transientContext && !context.sessionId) {
        await cleanupSession(context, "transient_request_complete");
      }
    }
  };

  app.disable("x-powered-by");
  app.use(createHostHeaderMiddleware(config));

  const auth = createAuthMiddleware(config);
  app.use("/health", auth);
  app.use("/mcp", auth);

  app.get("/health", (_req, res) => {
    res.type("text/plain").status(200).send("ok");
  });

  app.get("/mcp", handleMcp);
  app.post("/mcp", handleMcp);
  app.delete("/mcp", handleMcp);

  app.use((error: unknown, _req: unknown, res: { headersSent?: boolean; status: (code: number) => { json: (body: unknown) => void } }, _next: unknown) => {
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
