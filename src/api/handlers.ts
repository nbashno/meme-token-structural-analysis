/**
 * WAR API — handlers (Phase: HTTP/API).
 *
 * Each handler is a THIN wrapper over the existing ArenaSession (the one
 * read-only wiring surface). Handlers validate input shape, call the session,
 * and serialize the DomainResult. They compute NO intelligence, touch no core,
 * and invent no field. Payment/GMGN wiring remains the caller's concern and is
 * honestly PENDING where a live provider is required.
 */

import type { ArenaSession } from "../arena/ArenaSession.js";
import { CAPABILITIES } from "../arena/capabilities.js";
import type { ApiRequest } from "./router.js";
import { fromDomain, httpOk, httpErr, type HttpResponse } from "./httpResult.js";

/** GET /health — liveness only; no domain logic. */
export function health(): HttpResponse {
  return httpOk({ status: "ok", service: "war-api" });
}

/** GET /capabilities — the honest status map (NOT_IMPLEMENTED/BLOCKED/READY). */
export function capabilities(): HttpResponse {
  return httpOk(CAPABILITIES);
}

/** GET /search?q=... — real search over the repository. */
export async function search(session: ArenaSession, req: ApiRequest): Promise<HttpResponse> {
  const text = req.query["q"];
  if (typeof text !== "string" || text.trim().length === 0) {
    return httpErr("query parameter 'q' is required", 400);
  }
  const results = await session.searchTokens(text);
  return httpOk(results);
}

/** GET /replay/:sessionId — persisted history references for replay. */
export async function replay(session: ArenaSession, req: ApiRequest): Promise<HttpResponse> {
  const sessionId = req.params["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return httpErr("path parameter 'sessionId' is required", 400);
  }
  const entries = await session.replayHistory(sessionId);
  return httpOk(entries);
}

/**
 * POST /scan — run a scan. Body must carry the scan input + a world position.
 * The scan pipeline requires a real entitlement (payment). This handler
 * validates and delegates; whether the entitlement resolves is the domain's
 * decision (a failed/absent entitlement surfaces as a domain error, not a fake
 * success). GMGN acquisition remains BLOCKED_BY_GMGN_CLI until a live executor
 * is injected at composition — no fake data is produced here.
 */
export async function scan(session: ArenaSession, req: ApiRequest): Promise<HttpResponse> {
  const b = req.body;
  if (typeof b !== "object" || b === null) {
    return httpErr("JSON body required", 400);
  }
  const body = b as Record<string, unknown>;

  const requestId = body["requestId"];
  const userId = body["userId"];
  const token = body["token"];
  const entitlementId = body["entitlementId"];
  const position = body["position"];

  if (typeof requestId !== "string" || typeof userId !== "string" || typeof entitlementId !== "string") {
    return httpErr("requestId, userId, entitlementId are required strings", 400);
  }
  if (typeof token !== "object" || token === null) {
    return httpErr("token { chain, address } is required", 400);
  }
  const t = token as Record<string, unknown>;
  if (typeof t["chain"] !== "string" || typeof t["address"] !== "string") {
    return httpErr("token.chain and token.address are required strings", 400);
  }
  const pos = (typeof position === "object" && position !== null ? position : {}) as Record<string, unknown>;
  const worldPosition = {
    x: typeof pos["x"] === "number" ? pos["x"] : 0,
    y: typeof pos["y"] === "number" ? pos["y"] : 0,
  };

  const input = {
    requestId,
    userId: userId as never, // UserId is a branded string; the domain validates identity
    token: { chain: t["chain"], address: t["address"] } as never,
    entitlementId,
  };

  const result = await session.scan(input as never, worldPosition as never);
  // A domain failure (e.g. entitlement not usable) is a 409 conflict, not 400.
  return fromDomain(result, 200, 409);
}
