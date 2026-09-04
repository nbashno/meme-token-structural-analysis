/**
 * WAR API — pure router (Phase: HTTP/API).
 *
 * A tiny, dependency-free router. It matches an incoming (method, path) to a
 * registered handler, extracting path params (e.g. /replay/:sessionId). It is
 * deliberately decoupled from node:http so the whole routing layer is
 * Node-testable with plain objects — no socket, no server.
 *
 * Handlers receive a normalized ApiRequest and return an HttpResponse (or a
 * promise of one). The router computes NO intelligence.
 */

import type { HttpResponse } from "./httpResult.js";
import { notFound, methodNotAllowed } from "./httpResult.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, string>>;
  /** Parsed JSON body, or undefined for bodyless requests. */
  readonly body: unknown;
  /** Lower-cased request headers (e.g. x-telegram-init-data for auth). */
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export type ApiHandler = (req: ApiRequest) => HttpResponse | Promise<HttpResponse>;

interface Route {
  readonly method: HttpMethod;
  /** Segments; a segment starting with ':' is a param. */
  readonly segments: readonly string[];
  readonly handler: ApiHandler;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: ApiHandler): this {
    this.routes.push({ method, segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: ApiHandler): this { return this.add("GET", pattern, handler); }
  post(pattern: string, handler: ApiHandler): this { return this.add("POST", pattern, handler); }

  /**
   * Resolve a request to a handler + extracted params. Returns null when no
   * path matches at all; returns a `methodMismatch` marker when the path
   * matches but the method does not (so the caller can answer 405 vs 404).
   */
  match(method: string, path: string): { handler: ApiHandler; params: Record<string, string> } | { methodMismatch: true } | null {
    const segs = splitPath(path);
    let pathMatchedButMethod = false;

    for (const route of this.routes) {
      if (route.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const rs = route.segments[i]!;
        const ps = segs[i]!;
        if (rs.startsWith(":")) params[rs.slice(1)] = decodeURIComponent(ps);
        else if (rs !== ps) { ok = false; break; }
      }
      if (!ok) continue;
      if (route.method !== method) { pathMatchedButMethod = true; continue; }
      return { handler: route.handler, params };
    }

    if (pathMatchedButMethod) return { methodMismatch: true };
    return null;
  }

  /** Dispatch a fully-normalized request to its handler. */
  async dispatch(req: ApiRequest): Promise<HttpResponse> {
    const m = this.match(req.method, req.path);
    if (m === null) return notFound(req.path);
    if ("methodMismatch" in m) return methodNotAllowed(req.method, req.path);
    return m.handler({ ...req, params: m.params });
  }
}
