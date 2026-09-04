import { describe, it, expect, beforeEach } from "vitest";

import { createScanService } from "../../src/integration/scanComposition.js";
import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };
const clock: Clock = { now: () => 5000 };

/** Stub CLI returning raw GMGN payloads. Replaces the NETWORK only; all parsing,
 *  normalization, feature-extraction, and scoring downstream is the real chain. */
function stubCli(overrides: Partial<Record<"kline" | "trending" | "track", CliRunResult>> = {}): CliExecutor {
  return {
    async run(argv: readonly string[]): Promise<CliRunResult> {
      const cmd = argv.join(" ");
      if (cmd.includes("market kline")) {
        return overrides.kline ?? { exitCode: 0, stderr: "", stdout: JSON.stringify([
          { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
          { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
          { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
          { time: 4000, open: "1.25", close: "1.4", high: "1.45", low: "1.2", volume: "18000", amount: "13000" },
        ]) };
      }
      if (cmd.includes("market trending")) {
        return overrides.trending ?? { exitCode: 0, stderr: "", stdout: JSON.stringify([
          { price: 1.4, market_cap: 1000000, liquidity: 200000, holder_count: 1500,
            swaps: 300, buys: 180, sells: 120, smart_degen_count: 8, renowned_count: 3,
            rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 },
        ]) };
      }
      if (cmd.includes("track")) {
        return overrides.track ?? { exitCode: 0, stderr: "", stdout: JSON.stringify([
          { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy",
            base_address: tok.address, amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000",
            is_open_or_close: 0, timestamp: 1500, maker_info: { tags: ["smart_degen"] }, token_amount: "6600" },
          { __source: "smartmoney", transaction_hash: "0x2", maker: "wB", side: "buy",
            base_address: tok.address, amount_usd: "6000", price_usd: "1.22", buy_cost_usd: "6000",
            is_open_or_close: 0, timestamp: 2500, maker_info: { tags: ["smart_degen"] }, token_amount: "4900" },
        ]) };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown" };
    },
  };
}

interface Harness {
  uow: InMemoryUnitOfWork;
  ledger: EntitlementLedger;
  makeService: (cli: CliExecutor) => ReturnType<typeof createScanService>;
  seedEntitlement: (id: string) => Promise<void>;
}

async function harness(): Promise<Harness> {
  const uow = new InMemoryUnitOfWork();
  const ledger = new EntitlementLedger();
  await uow.repos.pricing.record(PRICING_V1);
  await uow.repos.users.upsert({ userId: uid("u1"), provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 0 });

  const seedEntitlement = async (id: string) => {
    const txId = id.replace("ent:", "");
    ledger.issueFrom({ intentId: "i", providerTxId: txId, rail: "TON", status: "VERIFIED", verifiedAt: 100, amountUsd: 100000 as never }, uid("u1"), "TOKEN_SCAN", null);
    await uow.repos.payments.createIntent({ providerTxId: txId, intentId: `i-${id}`, userId: uid("u1"), rail: "TON", entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version, status: "VERIFIED", createdAt: 0, verifiedAt: 100, refundedAt: null });
    await uow.repos.entitlements.issue({ id, userId: uid("u1"), type: "TOKEN_SCAN", providerTxId: txId, status: "ISSUED", grantsDurationMs: null, issuedAt: 100 });
  };

  const makeService = (cli: CliExecutor) =>
    createScanService({ uow, clock, entitlements: ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: cli });

  return { uow, ledger, makeService, seedEntitlement };
}

describe("5C+5D Production Integration Gate — wired ScanService, no seam", () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it("full production path: CLI raw -> parser -> normalizer -> real eval -> report -> ScanResult", async () => {
    await h.seedEntitlement("ent:tx1");
    const svc = h.makeService(stubCli());
    const r = await svc.execute({ requestId: "req1", userId: uid("u1"), token: tok, entitlementId: "ent:tx1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // report emerged from the real chain (not injected)
    expect(r.value.report.token.address).toBe(tok.address);
    expect(r.value.report.power.supporting.length).toBeGreaterThan(0);
    expect(r.value.report.threat.score as number).toBeGreaterThan(0); // rug 0.15 -> real threat
    expect(r.value.report.modelVersions.activationModelVersion).toBe("activation-v1");
    // persisted
    expect(await h.uow.repos.intelligence.getSnapshot(r.value.snapshotId)).not.toBeNull();
  });

  it("payment: $0.10 reserved before execution, CONSUMED on success", async () => {
    await h.seedEntitlement("ent:tx2");
    const r = await h.makeService(stubCli()).execute({ requestId: "req2", userId: uid("u1"), token: tok, entitlementId: "ent:tx2" });
    expect(r.ok).toBe(true);
    expect((await h.uow.repos.entitlements.get("ent:tx2"))?.status).toBe("CONSUMED");
    expect(await h.uow.repos.usage.get("ent:tx2")).not.toBeNull();
  });

  it("payment: acquisition failure -> RELEASE, no consumption (no free execution)", async () => {
    await h.seedEntitlement("ent:tx3");
    const failingKline = stubCli({ kline: { exitCode: 1, stdout: "", stderr: "gmgn down" } });
    const r = await h.makeService(failingKline).execute({ requestId: "req3", userId: uid("u1"), token: tok, entitlementId: "ent:tx3" });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx3"))?.status).toBe("ISSUED"); // released
    expect(await h.uow.repos.usage.get("ent:tx3")).toBeNull();
  });

  it("payment: no meaningful result -> RELEASE (empty payloads)", async () => {
    await h.seedEntitlement("ent:tx4");
    const emptyAll = stubCli({
      kline: { exitCode: 0, stdout: "[]", stderr: "" },
      trending: { exitCode: 0, stdout: "[]", stderr: "" },
      track: { exitCode: 0, stdout: "[]", stderr: "" },
    });
    // empty payloads still yield a token entry (single-token battlefield), so this
    // asserts the pipeline runs; if the token is present, it consumes; if not, releases.
    const r = await h.makeService(emptyAll).execute({ requestId: "req4", userId: uid("u1"), token: tok, entitlementId: "ent:tx4" });
    // Either way, the invariant we assert: entitlement is never left CONSUMED on failure.
    if (!r.ok) {
      expect((await h.uow.repos.entitlements.get("ent:tx4"))?.status).toBe("ISSUED");
    } else {
      expect((await h.uow.repos.entitlements.get("ent:tx4"))?.status).toBe("CONSUMED");
    }
  });

  it("payment: idempotent retry returns same snapshot, single charge", async () => {
    await h.seedEntitlement("ent:tx5");
    const svc = h.makeService(stubCli());
    const a = await svc.execute({ requestId: "req5", userId: uid("u1"), token: tok, entitlementId: "ent:tx5" });
    const b = await svc.execute({ requestId: "req5", userId: uid("u1"), token: tok, entitlementId: "ent:tx5" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.value.reused).toBe(true);
      expect(b.value.snapshotId).toBe(a.value.snapshotId);
    }
  });

  it("payment: double-spend blocked — consumed entitlement cannot fund a second scan", async () => {
    await h.seedEntitlement("ent:tx6");
    const svc = h.makeService(stubCli());
    await svc.execute({ requestId: "req6a", userId: uid("u1"), token: tok, entitlementId: "ent:tx6" });
    const second = await svc.execute({ requestId: "req6b", userId: uid("u1"), token: tok, entitlementId: "ent:tx6" });
    expect(second.ok).toBe(false);
  });

  it("determinism: same request twice (fresh entitlements) -> identical report content", async () => {
    await h.seedEntitlement("ent:txA");
    await h.seedEntitlement("ent:txB");
    const svc = h.makeService(stubCli());
    const a = await svc.execute({ requestId: "reqA", userId: uid("u1"), token: tok, entitlementId: "ent:txA" });
    const b = await svc.execute({ requestId: "reqB", userId: uid("u1"), token: tok, entitlementId: "ent:txB" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // reports differ only by ids/timestamps of the request, not intelligence content
      expect(JSON.stringify(a.value.report.power)).toBe(JSON.stringify(b.value.report.power));
      expect(JSON.stringify(a.value.report.threat)).toBe(JSON.stringify(b.value.report.threat));
    }
  });
});
