import { describe, it, expect, beforeEach } from "vitest";

import { createScanService } from "../../src/integration/scanComposition.js";
import { ResilientCliExecutor, type TimeProvider } from "../../src/hardening/ResilientCliExecutor.js";
import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

function virtualTime(): TimeProvider {
  let t = 0;
  return { now: () => t, async sleep(ms) { t += ms; } };
}

function goodPayloads(cmd: string): CliRunResult {
  if (cmd.includes("market kline")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
    { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
    { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
    { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
  ]) };
  if (cmd.includes("market trending")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
    { price: 1.25, market_cap: 1000000, liquidity: 200000, holder_count: 1500, swaps: 300, buys: 180, sells: 120,
      smart_degen_count: 8, renowned_count: 3, rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 },
  ]) };
  if (cmd.includes("track")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
    { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy", base_address: tok.address,
      amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000", is_open_or_close: 0, timestamp: 1500,
      maker_info: { tags: ["smart_degen"] }, token_amount: "6600" },
  ]) };
  return { exitCode: 1, stdout: "", stderr: "unknown" };
}

interface H { uow: InMemoryUnitOfWork; ledger: EntitlementLedger; seed: (id: string) => Promise<void>; }
async function harness(): Promise<H> {
  const uow = new InMemoryUnitOfWork();
  const ledger = new EntitlementLedger();
  await uow.repos.pricing.record(PRICING_V1);
  await uow.repos.users.upsert({ userId: uid("u1"), provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 0 });
  const seed = async (id: string) => {
    const txId = id.replace("ent:", "");
    ledger.issueFrom({ intentId: "i", providerTxId: txId, rail: "TON", status: "VERIFIED", verifiedAt: 100, amountUsd: 100000 as never }, uid("u1"), "TOKEN_SCAN", null);
    await uow.repos.payments.createIntent({ providerTxId: txId, intentId: `i-${id}`, userId: uid("u1"), rail: "TON", entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version, status: "VERIFIED", createdAt: 0, verifiedAt: 100, refundedAt: null });
    await uow.repos.entitlements.issue({ id, userId: uid("u1"), type: "TOKEN_SCAN", providerTxId: txId, status: "ISSUED", grantsDurationMs: null, issuedAt: 100 });
  };
  return { uow, ledger, seed };
}

function makeSvc(h: H, cli: CliExecutor) {
  return createScanService({ uow: h.uow, clock: { now: () => 5000 } as Clock, entitlements: h.ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: cli });
}

describe("7 hardening integration — resilient scan, no false charge", () => {
  let h: H;
  beforeEach(async () => { h = await harness(); });

  it("transient failures are retried, scan succeeds, entitlement CONSUMED", async () => {
    // kline fails once (network), then all good.
    let klineCalls = 0;
    const flaky: CliExecutor = {
      async run(argv) {
        const cmd = argv.join(" ");
        if (cmd.includes("market kline")) {
          klineCalls++;
          if (klineCalls === 1) return { exitCode: 1, stdout: "", stderr: "network error" };
        }
        return goodPayloads(cmd);
      },
    };
    const resilient = new ResilientCliExecutor({ inner: flaky, time: virtualTime() });
    await h.seed("ent:tx1");
    const r = await makeSvc(h, resilient).execute({ requestId: "req1", userId: uid("u1"), token: tok, entitlementId: "ent:tx1" });
    expect(r.ok).toBe(true);
    expect(klineCalls).toBeGreaterThan(1); // retried
    expect((await h.uow.repos.entitlements.get("ent:tx1"))?.status).toBe("CONSUMED");
  });

  it("exhausted retries -> scan fails -> entitlement RELEASED (no false charge)", async () => {
    const alwaysDown: CliExecutor = { async run() { return { exitCode: 1, stdout: "", stderr: "network error" }; } };
    const resilient = new ResilientCliExecutor({ inner: alwaysDown, time: virtualTime() });
    await h.seed("ent:tx2");
    const r = await makeSvc(h, resilient).execute({ requestId: "req2", userId: uid("u1"), token: tok, entitlementId: "ent:tx2" });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx2"))?.status).toBe("ISSUED"); // released
    expect(await h.uow.repos.usage.get("ent:tx2")).toBeNull();
  });

  it("idempotency holds under resilient executor: retry of completed scan reuses snapshot", async () => {
    const resilient = new ResilientCliExecutor({ inner: { async run(a) { return goodPayloads(a.join(" ")); } }, time: virtualTime() });
    await h.seed("ent:tx3");
    const svc = makeSvc(h, resilient);
    const a = await svc.execute({ requestId: "req3", userId: uid("u1"), token: tok, entitlementId: "ent:tx3" });
    const b = await svc.execute({ requestId: "req3", userId: uid("u1"), token: tok, entitlementId: "ent:tx3" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.value.reused).toBe(true);
  });
});
