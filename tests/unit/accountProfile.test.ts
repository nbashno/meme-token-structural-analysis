import { describe, it, expect } from "vitest";
import { AccountProfileService } from "../../src/product/account/accountProfile.js";
import { BalanceLedger } from "../../src/product/payment/balance.js";
import { PricingService, PRICING_V2 } from "../../src/product/pricing/pricing.js";
import { usd } from "../../src/product/domain/identity.js";
import type { UserId } from "../../src/product/domain/identity.js";
import type { MonitorRepository } from "../../src/product/persistence/contracts/repositories.js";
import type { MonitoringSession } from "../../src/product/monitor/monitor.js";
import type { VerifiedPayment } from "../../src/product/payment/payment.js";

const U = "u1" as UserId;

/** A minimal monitor repo returning a fixed active list. */
function monitorRepo(active: MonitoringSession[]): MonitorRepository {
  return {
    create: async (s) => s,
    update: async (s) => s,
    get: async () => null,
    listActive: async () => active,
  };
}

function session(userId: string, id: string): MonitoringSession {
  return {
    id, userId: userId as UserId,
    token: { chain: "sol", address: "a" as never },
    status: "ACTIVE", startedAt: 0, durationMs: 86400000, expiresAt: 86400000,
  } as unknown as MonitoringSession;
}

function payment(amount: number, tx: string): VerifiedPayment {
  return { intentId: "i", providerTxId: tx, rail: "TON", status: "VERIFIED", verifiedAt: 1, amountUsd: usd(amount) };
}

describe("AccountProfileService — read-only aggregation", () => {
  const pricing = new PricingService(PRICING_V2);

  it("registers a new user with free scans and STANDARD tier", async () => {
    const bal = new BalanceLedger();
    const svc = new AccountProfileService(bal, monitorRepo([]), pricing);
    const p = await svc.profile(U, 1000);
    expect(p.tier).toBe("STANDARD");
    expect(p.freeScansRemaining).toBe(3);
    expect(p.balanceUsd).toBe(0);
    expect(p.activeMonitors).toBe(0);
    expect(p.limits.maxConcurrentMonitors).toBe(3);
  });

  it("reflects balance and counts only the user's active monitors", async () => {
    const bal = new BalanceLedger();
    bal.register(U, 0);
    bal.topUp(payment(20, "tx1"), U, 1);
    const repo = monitorRepo([session("u1", "m1"), session("u1", "m2"), session("other", "m3")]);
    const svc = new AccountProfileService(bal, repo, pricing);
    const p = await svc.profile(U, 1000);
    expect(p.balanceUsd).toBe(20);
    expect(p.activeMonitors).toBe(2); // excludes "other"
  });

  it("STANDARD hits monitor cap at 3; canStartMonitor turns false", async () => {
    const bal = new BalanceLedger();
    bal.register(U, 0);
    const repo = monitorRepo([session("u1", "m1"), session("u1", "m2"), session("u1", "m3")]);
    const svc = new AccountProfileService(bal, repo, pricing);
    const p = await svc.profile(U, 1000);
    expect(p.atMonitorCap).toBe(true);
    expect(await svc.canStartMonitor(U, 1000)).toBe(false);
  });

  it("COMMAND tier is uncapped — never at cap even with many monitors", async () => {
    const bal = new BalanceLedger();
    bal.register(U, 0);
    bal.setTier(U, "COMMAND");
    const many = Array.from({ length: 10 }, (_, i) => session("u1", `m${i}`));
    const svc = new AccountProfileService(bal, monitorRepo(many), pricing);
    const p = await svc.profile(U, 1000);
    expect(p.tier).toBe("COMMAND");
    expect(p.limits.maxConcurrentMonitors).toBeNull();
    expect(p.atMonitorCap).toBe(false);
    expect(await svc.canStartMonitor(U, 1000)).toBe(true);
  });

  it("after COMMAND pack purchase, profile shows $1200 and COMMAND", async () => {
    const bal = new BalanceLedger();
    bal.register(U, 0);
    const pack = pricing.packConfig("PACK_COMMAND");
    bal.topUp(payment(1000, "txCmd"), U, 1, pack.bonusMicros);
    if (pack.grantsTier) bal.setTier(U, pack.grantsTier);
    const svc = new AccountProfileService(bal, monitorRepo([]), pricing);
    const p = await svc.profile(U, 1000);
    expect(p.balanceUsd).toBe(1200);
    expect(p.tier).toBe("COMMAND");
  });
});
