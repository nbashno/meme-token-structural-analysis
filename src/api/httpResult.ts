/**
 * WAR API — HTTP result mapping (Phase: HTTP/API).
 *
 * Pure translation between the domain's DomainResult<T> and an HTTP response
 * shape. Contains NO intelligence: it does not compute, score, or interpret —
 * it maps ok/err to status codes and serializes the value. Node-testable
 * without a real socket.
 */

import type { DomainResult } from "../product/domain/identity.js";

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** A successful envelope. */
export function httpOk(value: unknown, status = 200): HttpResponse {
  return { status, body: { ok: true, data: value } };
}

/** An error envelope with an explicit status. */
export function httpErr(error: string, status = 400): HttpResponse {
  return { status, body: { ok: false, error } };
}

/**
 * Map a DomainResult to an HTTP response. Domain errors are client errors (400)
 * by default; the caller can override for cases like 404/409. Never leaks stack
 * traces — only the domain's own error string.
 */
export function fromDomain<T>(result: DomainResult<T>, okStatus = 200, errStatus = 400): HttpResponse {
  return result.ok ? httpOk(result.value, okStatus) : httpErr(result.error, errStatus);
}

/** 404 helper for unmatched routes. */
export function notFound(path: string): HttpResponse {
  return httpErr(`no route for ${path}`, 404);
}

/** 405 helper for wrong method on a known path. */
export function methodNotAllowed(method: string, path: string): HttpResponse {
  return httpErr(`method ${method} not allowed on ${path}`, 405);
}

/** 500 helper for unexpected failures (message is sanitized by the caller). */
export function internalError(message: string): HttpResponse {
  return httpErr(message, 500);
}
