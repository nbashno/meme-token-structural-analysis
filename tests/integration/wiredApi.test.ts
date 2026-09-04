import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { createWiredApp } from "../../src/api/wiredApp.js";
import { createWarRuntime } from "../../src/integration/warRuntime.js";
import { CURRENT_LEGAL_VERSION } from "../../src/product/legal/consent.js";
import type { CliExecutor } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { ApiRequest } from "../../src/api/router.js";

const BOT = "123456:TEST_BOT_TOKEN";
const NOW = 1_700_000_000_000; // ms
const NOW_S = Math.floor(NOW / 1000);

/** Build correctly-signed Telegram initData for a user id. */
function initDataFor(id: string): string {
  const user = JSON.stringify({ id: Number(id), first_name: "Test", username: "t" });
  const fields: Record<string, string> = { auth_date: String(NOW_S - 5), user };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return Object.entries({ ...fields, hash }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** Stub executor returns valid empty flow so scans succeed without a network. */
function stubExec(): CliExecutor {
  return { run: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }) };
}

function runtime() {
  return createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW } });
}
function app(rt = runtime(), extra = {}) {
  return createWiredApp(rt, { auth: { botToken: BOT }, now: () => NOW, ...extra });
}
function req(method: string, path: string, opts: Partial<ApiRequest> = {}): ApiRequest {
  return { method, path, query: {}, params: {}, body: undefined, headers: {}, ...opts };
}
function authHeaders(id: string) {
  return { "x-telegram-init-data": initDataFor(id) };
}

describe("wired API — auth enforcement", () => {
  it("rejects /me without initData (401)", async () => {
    const r = await app().dispatch(req("GET", "/me"));
    expect(r.status).toBe(401);
  });
  it("rejects /scan with tampered initData (401)", async () => {
    const bad = initDataFor("1").replace("Test", "Hacked");
    const r = await app().dispatch(req("POST", "/scan", { headers: { "x-telegram-init-data": bad } }));
    expect(r.status).toBe(401);
  });
  it("allows /health and /capabilities without auth", async () => {
    expect((await app().dispatch(req("GET", "/health"))).status).toBe(200);
    expect((await app().dispatch(req("GET", "/capabilities"))).status).toBe(200);
  });
});

describe("wired API — /me registers user + grants free quota", () => {
  it("returns a profile with 3 free scans on first contact", async () => {
    const r = await app().dispatch(req("GET", "/me", { headers: authHeaders("42") }));
    expect(r.status).toBe(200);
    const b = r.body as any;
    expect(b.profile.freeScansRemaining).toBe(3);
    expect(b.profile.tier).toBe("STANDARD");
    expect(b.consent.needsConsent).toBe(true); // hasn't agreed yet
  });
});

describe("wired API — consent gate", () => {
  it("blocks /scan with 409 until consent is recorded", async () => {
    const rt = runtime(); const a = app(rt);
    const h = authHeaders("7");
    const blocked = await a.dispatch(req("POST", "/scan", { headers: h, body: {} }));
    expect(blocked.status).toBe(409);
    // record consent, then scan proceeds
    await a.dispatch(req("POST", "/consent", { headers: h, body: { version: CURRENT_LEGAL_VERSION } }));
    const ok = await a.dispatch(req("POST", "/scan", { headers: h, body: { chain: "sol", address: "So11111111111111111111111111111111111111112" } }));
    expect(ok.status).toBeLessThan(409);
  });
});

describe("wired API — scan charging discipline (charge, refund-on-failure)", () => {
  async function agreedApp(id: string) {
    const rt = runtime(); const a = app(rt); const h = authHeaders(id);
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    // resolve the derived user id via /me
    const me = await a.dispatch(req("GET", "/me", { headers: h }));
    const uid = (me.body as any).profile.userId as string;
    return { rt, a, h, uid };
  }

  it("a successful scan consumes exactly one free scan (3 -> 2)", async () => {
    const { rt, a, h, uid } = await agreedApp("200");
    const before = rt.balances.get(uid as any)!.freeScans;
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    expect(r.status).toBeLessThan(400);
    const after = rt.balances.get(uid as any)!.freeScans;
    expect(after).toBe(before - 1); // charged exactly once
    expect((r.body as any)._meta.charged).toBe("FREE");
  });

  it("refunds when the scan pipeline fails (free scans preserved)", async () => {
    // An executor that errors makes acquisition fail -> scan FAILED -> refund.
    const failExec = { run: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }) };
    const rt = createWarRuntime({ cliExecutor: failExec, clock: { now: () => NOW } });
    const a = app(rt); const h = authHeaders("250");
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    const me = await a.dispatch(req("GET", "/me", { headers: h }));
    const uid = (me.body as any).profile.userId;
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    expect(r.status).toBeGreaterThanOrEqual(400); // scan failed
    expect(rt.balances.get(uid as any)!.freeScans).toBe(3); // refunded
  });

  it("rejects a scan with no token (400) without charging", async () => {
    const { rt, a, h, uid } = await agreedApp("201");
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: {} }));
    expect(r.status).toBe(400);
    expect(rt.balances.get(uid as any)!.freeScans).toBe(3); // untouched
  });

  it("requires top-up (402) once free scans are exhausted and balance is empty", async () => {
    const { rt, a, h, uid } = await agreedApp("202");
    // Drain the 3 free scans directly on the ledger to isolate the paywall path.
    for (let i = 0; i < 3; i++) rt.balances.charge(uid as any, `drain${i}`, rt.pricing.priceOf("TOKEN_SCAN"), NOW);
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    expect(r.status).toBe(402);
  });
});

describe("wired API — launch free window (promotion)", () => {
  it("during the free window, a scan consumes NO free quota (truly free)", async () => {
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW }, freeUntil: new Date(NOW + 86400000).toISOString() });
    const a = app(rt); const h = authHeaders("500");
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    const me = await a.dispatch(req("GET", "/me", { headers: h }));
    const uid = (me.body as any).profile.userId;
    expect((me.body as any).promotion.active).toBe(true);
    const before = rt.balances.get(uid as any)!.freeScans;
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    expect(r.status).toBeLessThan(400);
    expect((r.body as any)._meta.charged).toBe("PROMO");
    expect(rt.balances.get(uid as any)!.freeScans).toBe(before); // quota untouched
  });

  it("after the window closes, normal charging resumes", async () => {
    // cutoff already in the past -> not free
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW }, freeUntil: new Date(NOW - 1000).toISOString() });
    const a = app(rt); const h = authHeaders("501");
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    const me = await a.dispatch(req("GET", "/me", { headers: h }));
    const uid = (me.body as any).profile.userId;
    expect((me.body as any).promotion.active).toBe(false);
    const before = rt.balances.get(uid as any)!.freeScans;
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    expect(r.status).toBeLessThan(400);
    expect((r.body as any)._meta.charged).toBe("FREE"); // used the free quota
    expect(rt.balances.get(uid as any)!.freeScans).toBe(before - 1);
  });
});

describe("wired API — per-user daily cap (protects free resources)", () => {
  it("STANDARD is capped at 20 scans/day even during the free window", async () => {
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW }, freeUntil: new Date(NOW + 86400000).toISOString() });
    const a = app(rt); const h = authHeaders("600");
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    const scan = () => a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    // 20 allowed (promo-free), 21st blocked by the daily cap
    for (let i = 0; i < 20; i++) {
      const r = await scan();
      expect(r.status).toBeLessThan(400);
    }
    const capped = await scan();
    expect(capped.status).toBe(429);
    expect((capped.body as any).error).toContain("daily");
  });

  it("COMMAND tier is uncapped", async () => {
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW }, freeUntil: new Date(NOW + 86400000).toISOString() });
    const a = app(rt); const h = authHeaders("601");
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    const me = await a.dispatch(req("GET", "/me", { headers: h }));
    const uid = (me.body as any).profile.userId;
    rt.balances.setTier(uid as any, "COMMAND");
    const scan = () => a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    for (let i = 0; i < 25; i++) {
      const r = await scan();
      expect(r.status).toBeLessThan(400); // well past the STANDARD cap of 20
    }
  });
});

describe("wired API — GET /trending (public arena view)", () => {
  it("returns trending tokens without auth or consent", async () => {
    const rt = createWarRuntime({
      cliExecutor: stubExec(), clock: { now: () => NOW },
      trendingSeed: [{ chain: "sol", address: "So11111111111111111111111111111111111111112" }],
    });
    const a = app(rt);
    const r = await a.dispatch(req("GET", "/trending", {}));
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
    expect(Array.isArray((r.body as any).tokens)).toBe(true);
  });

  it("serves an empty list honestly when no seed is configured", async () => {
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW } });
    const a = app(rt);
    const r = await a.dispatch(req("GET", "/trending", {}));
    expect(r.status).toBe(200);
    expect((r.body as any).tokens).toEqual([]);
  });
});

describe("wired API — channel membership gate (operations only)", () => {
  it("blocks scan when the user is not a channel member (403)", async () => {
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW }, requiredChannel: "@war", membershipChecker: async () => "left" });
    const a = app(rt); const h = authHeaders("700");
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    expect(r.status).toBe(403);
    expect((r.body as any).joinChannel).toBe("@war");
  });

  it("allows scan when the user IS a channel member", async () => {
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW }, requiredChannel: "@war", membershipChecker: async () => "member" });
    const a = app(rt); const h = authHeaders("701");
    await a.dispatch(req("POST", "/consent", { headers: h, body: {} }));
    const r = await a.dispatch(req("POST", "/scan", { headers: h, body: { token: { chain: "sol", address: "So11111111111111111111111111111111111111112" } } }));
    expect(r.status).toBeLessThan(400);
  });

  it("browsing stays open — /me works without membership", async () => {
    const rt = createWarRuntime({ cliExecutor: stubExec(), clock: { now: () => NOW }, requiredChannel: "@war", membershipChecker: async () => "left" });
    const a = app(rt); const h = authHeaders("702");
    const r = await a.dispatch(req("GET", "/me", { headers: h }));
    expect(r.status).toBe(200);
    expect((r.body as any).membership.enabled).toBe(true);
  });
});

describe("wired API — payment webhooks settle to balance", () => {
  it("credits balance from an authentic Stars webhook", async () => {
    const rt = runtime();
    const a = app(rt, { starsAuthentic: () => true });
    const r = await a.dispatch(req("POST", "/webhook/stars", {
      body: { telegram_payment_charge_id: "chg1", invoice_payload: { pack: "PACK_COMMAND", userId: "300" }, usdMicros: 1000_000000, at: NOW },
    }));
    expect(r.status).toBe(200);
    const acct = rt.balances.get("300" as any)!;
    expect(acct.tier).toBe("COMMAND");
    expect(acct.balanceMicros).toBe(1200_000000); // $1000 + $200 bonus
  });

  it("rejects an inauthentic TON webhook (400)", async () => {
    const rt = runtime();
    const a = app(rt, { tonAuthentic: () => false });
    const r = await a.dispatch(req("POST", "/webhook/ton", { body: { txHash: "x", pack: "PACK_SMALL", userId: "301", usdMicros: 5_000000 } }));
    expect(r.status).toBe(400);
  });
});
