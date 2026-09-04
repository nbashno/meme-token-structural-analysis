import { describe, it, expect } from "vitest";
import { Router } from "../../src/api/router.js";
import { fromDomain, httpOk, httpErr, notFound } from "../../src/api/httpResult.js";
import * as handlers from "../../src/api/handlers.js";
import { createApp } from "../../src/api/app.js";
import { ok, err } from "../../src/product/domain/identity.js";

// ── httpResult ───────────────────────────────────────────────────────────────
describe("httpResult — pure domain->HTTP mapping", () => {
  it("maps ok to 200 with data envelope", () => {
    const r = fromDomain(ok({ a: 1 }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, data: { a: 1 } });
  });
  it("maps err to configured status with error envelope", () => {
    const r = fromDomain(err("nope"), 200, 409);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, error: "nope" });
  });
  it("helpers build correct envelopes", () => {
    expect(httpOk("x").status).toBe(200);
    expect(httpErr("bad", 400).status).toBe(400);
    expect(notFound("/none").status).toBe(404);
  });
});

// ── router ───────────────────────────────────────────────────────────────────
describe("router — pure matching + params", () => {
  const r = new Router();
  r.get("/health", () => httpOk("ok"));
  r.get("/replay/:sessionId", (req) => httpOk(req.params["sessionId"]));
  r.post("/scan", () => httpOk("scanned"));

  it("matches a static route", () => {
    const m = r.match("GET", "/health");
    expect(m).not.toBeNull();
  });
  it("extracts path params", () => {
    const m = r.match("GET", "/replay/sess-123");
    expect(m && "params" in m ? m.params["sessionId"] : null).toBe("sess-123");
  });
  it("returns null for unknown path", () => {
    expect(r.match("GET", "/nope")).toBeNull();
  });
  it("flags method mismatch (405) vs not found (404)", () => {
    const m = r.match("DELETE", "/health");
    expect(m).toEqual({ methodMismatch: true });
  });
  it("dispatch answers 404 / 405 / 200", async () => {
    expect((await r.dispatch({ method: "GET", path: "/none", query: {}, params: {}, body: undefined })).status).toBe(404);
    expect((await r.dispatch({ method: "DELETE", path: "/health", query: {}, params: {}, body: undefined })).status).toBe(405);
    expect((await r.dispatch({ method: "GET", path: "/health", query: {}, params: {}, body: undefined })).status).toBe(200);
  });
});

// ── handlers over a fake ArenaSession ────────────────────────────────────────
function fakeSession(over: Partial<Record<string, unknown>> = {}) {
  return {
    searchTokens: async (t: string) => [{ chain: "solana", address: "a", symbol: t }],
    replayHistory: async (id: string) => [{ sessionId: id }],
    scan: async () => ok({ result: { requestId: "r", snapshotId: "s", reused: false }, world: {} }),
    ...over,
  } as never;
}

describe("handlers — thin wrappers, validation + serialization", () => {
  it("health returns ok envelope", () => {
    expect(handlers.health().status).toBe(200);
  });
  it("capabilities returns the honest status map", () => {
    const r = handlers.capabilities();
    expect(r.status).toBe(200);
    expect(Array.isArray((r.body as { data: unknown }).data)).toBe(true);
  });
  it("search requires q", async () => {
    const bad = await handlers.search(fakeSession(), { method: "GET", path: "/search", query: {}, params: {}, body: undefined });
    expect(bad.status).toBe(400);
    const okr = await handlers.search(fakeSession(), { method: "GET", path: "/search", query: { q: "vult" }, params: {}, body: undefined });
    expect(okr.status).toBe(200);
  });
  it("replay requires sessionId", async () => {
    const okr = await handlers.replay(fakeSession(), { method: "GET", path: "/replay/x", query: {}, params: { sessionId: "x" }, body: undefined });
    expect(okr.status).toBe(200);
  });
  it("scan validates body shape", async () => {
    const noBody = await handlers.scan(fakeSession(), { method: "POST", path: "/scan", query: {}, params: {}, body: undefined });
    expect(noBody.status).toBe(400);
    const goodBody = await handlers.scan(fakeSession(), {
      method: "POST", path: "/scan", query: {}, params: {},
      body: { requestId: "r", userId: "u", entitlementId: "e", token: { chain: "solana", address: "a" }, position: { x: 0, y: 0 } },
    });
    expect(goodBody.status).toBe(200);
  });
  it("scan surfaces a domain error as 409, not a fake success", async () => {
    const session = fakeSession({ scan: async () => err("entitlement not usable") });
    const r = await handlers.scan(session, {
      method: "POST", path: "/scan", query: {}, params: {},
      body: { requestId: "r", userId: "u", entitlementId: "e", token: { chain: "solana", address: "a" } },
    });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe("entitlement not usable");
  });
});

// ── app wiring ───────────────────────────────────────────────────────────────
describe("createApp — routes wired to handlers", () => {
  it("dispatches health and capabilities and search", async () => {
    const app = createApp(fakeSession());
    expect((await app.dispatch({ method: "GET", path: "/health", query: {}, params: {}, body: undefined })).status).toBe(200);
    expect((await app.dispatch({ method: "GET", path: "/capabilities", query: {}, params: {}, body: undefined })).status).toBe(200);
    expect((await app.dispatch({ method: "GET", path: "/search", query: { q: "x" }, params: {}, body: undefined })).status).toBe(200);
  });
});
