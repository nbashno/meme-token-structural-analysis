/**
 * WAR API — node:http server binding (Phase: HTTP/API).
 *
 * The ONLY file that touches a real socket. It adapts node:http requests into
 * the pure ApiRequest the Router understands, then writes the HttpResponse. No
 * external HTTP dependency (keeps deploy + Mini App bundle minimal). It holds no
 * intelligence — it is pure transport glue around the router.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Router, ApiRequest } from "./router.js";
import { internalError } from "./httpResult.js";
import { RateLimiter, corsHeaders, securityHeaders, type CorsConfig, type StructuredLogger } from "./security.js";

export interface SecurityOptions {
  readonly rateLimiter?: RateLimiter;
  readonly cors?: CorsConfig;
  readonly logger?: StructuredLogger;
  /** Adds standard security headers to every response. Default: true. */
  readonly securityHeaders?: boolean;
  /** Clock for rate-limit accounting. */
  readonly now?: () => number;
}

const MAX_BODY_BYTES = 1_000_000; // 1MB cap — reject oversized bodies

function parseQuery(url: string): { path: string; query: Record<string, string> } {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return { path: url, query: {} };
  const path = url.slice(0, qIdx);
  const query: Record<string, string> = {};
  for (const pair of url.slice(qIdx + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { path, query };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Create (but do not start) an HTTP server that dispatches to the router. */
export function createHttpServer(router: Router, security: SecurityOptions = {}): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(router, req, res, security);
  });
}

function clientKey(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

async function handle(router: Router, req: IncomingMessage, res: ServerResponse, security: SecurityOptions): Promise<void> {
  const method = req.method ?? "GET";
  const { path, query } = parseQuery(req.url ?? "/");
  const now = security.now ?? (() => Date.now());
  const extraHeaders: Record<string, string> = {
    ...(security.securityHeaders !== false ? securityHeaders() : {}),
    ...(security.cors ? corsHeaders(security.cors) : {}),
  };

  // CORS preflight: answer OPTIONS immediately.
  if (method === "OPTIONS" && security.cors) {
    res.writeHead(204, extraHeaders);
    res.end();
    return;
  }

  // Rate limit per client key.
  if (security.rateLimiter) {
    const key = clientKey(req);
    const verdict = security.rateLimiter.take(key, now());
    if (!verdict.allowed) {
      security.logger?.warn("rate_limited", { key, path });
      write(res, 429, { ok: false, error: "rate limited" }, {
        ...extraHeaders,
        "retry-after": Math.ceil(verdict.retryAfterMs / 1000).toString(),
      });
      return;
    }
  }

  let response;
  try {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "bad request";
      write(res, 400, { ok: false, error: msg }, extraHeaders);
      return;
    }
    const apiReq: ApiRequest = { method, path, query, params: {}, body, headers: req.headers };
    response = await router.dispatch(apiReq);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    security.logger?.error("unhandled", { path, msg });
    response = internalError(msg);
  }
  security.logger?.info("request", { method, path, status: response.status });
  write(res, response.status, response.body, extraHeaders);
}

function write(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json).toString(),
    ...extraHeaders,
  });
  res.end(json);
}

/** Convenience: start listening. Returns the running server. */
export function listen(router: Router, port: number, host = "0.0.0.0", security: SecurityOptions = {}): Server {
  const server = createHttpServer(router, security);
  server.listen(port, host);
  return server;
}
