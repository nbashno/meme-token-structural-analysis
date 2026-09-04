import { describe, it, expect } from "vitest";
import { BalanceLedger, FREE_SCAN_GRANT } from "../../src/product/payment/balance.js";
import { PRICING_V2, PricingService } from "../../src/product/pricing/pricing.js";
import { usd } from "../../src/product/domain/identity.js";
import type { UserId } from "../../src/product/domain/identity.js";
import type { VerifiedPayment } from "../../src/product/payment/payment.js";

const U = "u1" as UserId;
const scanPrice = usd(0.1);

function payment(amount: number, tx: string): VerifiedPayment {
  return { intentId: "i", providerTxId: tx, rail: "TELEGRAM_STARS", status: "VERIFIED", verifiedAt: 1, amountUsd: usd(amount) };
}

describe("BalanceLedger — free grant + atomic debit + no double-spend", () => {
  it("grants 3 free scans on register", () => {
    const l = new BalanceLedger();
    const a = l.register(U, 1000);
    expect(a.freeScans).toBe(FREE_SCAN_GRANT);
    expect(a.balanceMicros).toBe(0);
    expect(a.tier).toBe("STANDARD");
  });

  it("consumes free scans first, then falls back to paid balance", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    l.topUp(payment(1, "tx1"), U, 1); // $1 balance
    // 3 free
    for (let i = 0; i < 3; i++) {
      const r = l.charge(U, `op${i}`, scanPrice, i);
      expect(r.ok && r.value.source).toBe("FREE");
    }
    // 4th falls to balance
    const paid = l.charge(U, "op3", scanPrice, 4);
    expect(paid.ok && paid.value.source).toBe("BALANCE");
    expect(l.get(U)!.balanceMicros).toBe(usd(0.9));
  });

  it("is idempotent per opId — same op never double-charges", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    l.topUp(payment(1, "tx1"), U, 1);
    // exhaust free first
    for (let i = 0; i < 3; i++) l.charge(U, `f${i}`, scanPrice, i);
    const a = l.charge(U, "dup", scanPrice, 5);
    const b = l.charge(U, "dup", scanPrice, 6); // replay
    expect(a.ok && b.ok).toBe(true);
    expect(l.get(U)!.balanceMicros).toBe(usd(0.9)); // charged once
  });

  it("refuses when balance insufficient (never negative)", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    for (let i = 0; i < 3; i++) l.charge(U, `f${i}`, scanPrice, i); // burn free
    const r = l.charge(U, "over", scanPrice, 5); // no balance
    expect(r.ok).toBe(false);
    expect(l.get(U)!.balanceMicros).toBe(0);
  });

  it("refunds a failed charge, restoring free scan or balance", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    l.topUp(payment(1, "tx1"), U, 1);
    for (let i = 0; i < 3; i++) l.charge(U, `f${i}`, scanPrice, i);
    l.charge(U, "op", scanPrice, 5);
    expect(l.get(U)!.balanceMicros).toBe(usd(0.9));
    l.refund(U, "op", 6);
    expect(l.get(U)!.balanceMicros).toBe(usd(1)); // restored
    // refund is idempotent
    l.refund(U, "op", 7);
    expect(l.get(U)!.balanceMicros).toBe(usd(1));
  });

  it("refunds a free-scan charge by restoring the counter", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    l.charge(U, "op", scanPrice, 1); // uses a free scan
    expect(l.get(U)!.freeScans).toBe(2);
    l.refund(U, "op", 2);
    expect(l.get(U)!.freeScans).toBe(3);
  });

  it("top-up is idempotent per providerTxId", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    l.topUp(payment(5, "txA"), U, 1);
    l.topUp(payment(5, "txA"), U, 2); // replay same tx
    expect(l.get(U)!.balanceMicros).toBe(usd(5));
  });

  it("charge with allowFree:false skips the free quota", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    l.topUp(payment(1, "tx1"), U, 1);
    const r = l.charge(U, "op", scanPrice, 2, { allowFree: false });
    expect(r.ok && r.value.source).toBe("BALANCE");
    expect(l.get(U)!.freeScans).toBe(3); // untouched
  });
});

describe("pricing v2 — packs + COMMAND tier", () => {
  const p = new PricingService(PRICING_V2);

  it("COMMAND pack costs $1000, grants $200 bonus and the tier", () => {
    const pack = p.packConfig("PACK_COMMAND");
    expect(pack.priceMicros).toBe(usd(1000));
    expect(pack.bonusMicros).toBe(usd(200)); // +20% => $1200 usable
    expect(pack.grantsTier).toBe("COMMAND");
  });

  it("credit packs scale with a bonus", () => {
    expect(p.packConfig("PACK_SMALL").bonusMicros).toBe(usd(0));
    expect(p.packConfig("PACK_MEDIUM").bonusMicros).toBe(usd(1));
    expect(p.packConfig("PACK_LARGE").bonusMicros).toBe(usd(5));
  });

  it("COMMAND lifts caps that STANDARD enforces", () => {
    const std = p.tierLimits("STANDARD");
    const cmd = p.tierLimits("COMMAND");
    expect(std.maxConcurrentMonitors).toBe(3);
    expect(cmd.maxConcurrentMonitors).toBeNull(); // unlimited
    expect(std.cleanShareCards).toBe(false);
    expect(cmd.cleanShareCards).toBe(true);
    expect(cmd.fullReplay).toBe(true);
  });

  it("buying COMMAND pack tops up $1200 and sets tier", () => {
    const l = new BalanceLedger();
    l.register(U, 0);
    const pack = p.packConfig("PACK_COMMAND");
    l.topUp(payment(1000, "txCmd"), U, 1, pack.bonusMicros);
    if (pack.grantsTier) l.setTier(U, pack.grantsTier);
    expect(l.get(U)!.balanceMicros).toBe(usd(1200));
    expect(l.get(U)!.tier).toBe("COMMAND");
  });
});
