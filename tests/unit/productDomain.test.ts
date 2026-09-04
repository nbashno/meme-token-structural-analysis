import { describe, it, expect } from "vitest";

import {
  usd,
  usdMicrosToDollars,
  tokenKey,
  type UserId,
  type TokenId,
} from "../../src/product/domain/identity.js";
import { PricingService, PRICING_V2 } from "../../src/product/pricing/pricing.js";
import {
  TelegramStarsProvider,
  TonProvider,
  type PaymentIntent,
} from "../../src/product/payment/payment.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import * as Scan from "../../src/product/scan/scan.js";
import * as Mon from "../../src/product/monitor/monitor.js";
import {
  AlertService,
  DEFAULT_ALERT_POLICY,
  type SignalPhaseMemory,
} from "../../src/product/intelligence/alerts.js";
import {
  buildIntelligenceReport,
  aggregateEvidence,
  whyNow,
} from "../../src/product/intelligence/report.js";
import {
  fingerprint,
  decidePersist,
  DEFAULT_PERSISTENCE_POLICY,
} from "../../src/product/persistence/tokenMemory.js";

import { makeEntry, makeBattlefield, signal, event } from "./productFixtures.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

// ── Pricing ──────────────────────────────────────────────────────────────────

describe("pricing", () => {
  it("encodes the commercial config in USD micros", () => {
    expect(usdMicrosToDollars(usd(0.1))).toBeCloseTo(0.1, 9);
    const p = new PricingService();
    expect(usdMicrosToDollars(p.priceOf("TOKEN_SCAN"))).toBeCloseTo(0.1, 9);
    expect(usdMicrosToDollars(p.priceOf("TOKEN_MONITOR_24H"))).toBeCloseTo(1.0, 9);
  });

  it("monitor duration is 24h and versioned", () => {
    const p = new PricingService();
    expect(p.monitorDurationMs()).toBe(24 * 60 * 60 * 1000);
    expect(p.version).toBe(PRICING_V2.version);
  });
});

// ── Token identity ─────────────────────────────────────────────────────────────

describe("token identity", () => {
  it("keys on chain+address, never symbol", () => {
    expect(tokenKey({ chain: "sol", address: "abc" as TokenId["address"] })).toBe("sol:abc");
    expect(tokenKey({ chain: "eth", address: "abc" as TokenId["address"] })).not.toBe(
      tokenKey({ chain: "sol", address: "abc" as TokenId["address"] }),
    );
  });
});

// ── Payment idempotency ────────────────────────────────────────────────────────

function intent(id: string, rail: "TELEGRAM_STARS" | "TON"): PaymentIntent {
  return {
    id,
    userId: uid("u1"),
    rail,
    entitlementType: "TOKEN_SCAN",
    amountUsd: usd(0.1),
    pricingVersion: "pricing-v1",
    createdAt: 1000,
  };
}

describe("payment abstraction", () => {
  it("verify is idempotent by provider tx id", () => {
    const p = new TelegramStarsProvider();
    p.createPayment(intent("i1", "TELEGRAM_STARS"));
    p.confirm("i1", "tx-1", 2000);
    const a = p.verifyPayment("tx-1");
    const b = p.verifyPayment("tx-1");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.verifiedAt).toBe(b.value.verifiedAt);
  });

  it("supports both rails without business logic caring which", () => {
    const stars = new TelegramStarsProvider();
    const ton = new TonProvider();
    expect(stars.rail).toBe("TELEGRAM_STARS");
    expect(ton.rail).toBe("TON");
  });

  it("refund flips status and blocks re-verification", () => {
    const p = new TonProvider();
    p.createPayment(intent("i2", "TON"));
    p.confirm("i2", "tx-2", 3000);
    p.refundPayment("tx-2");
    expect(p.verifyPayment("tx-2").ok).toBe(false);
    const st = p.getPaymentStatus("tx-2");
    expect(st.ok && st.value).toBe("REFUNDED");
  });
});

// ── Entitlement: 1 payment => 1 entitlement, single consumption ─────────────────

describe("entitlement ledger", () => {
  it("issues exactly one entitlement for a repeated payment callback", () => {
    const p = new TelegramStarsProvider();
    p.createPayment(intent("i1", "TELEGRAM_STARS"));
    const vp = p.confirm("i1", "tx-9", 5000);
    expect(vp.ok).toBe(true);
    if (!vp.ok) return;

    const led = new EntitlementLedger();
    const e1 = led.issueFrom(vp.value, uid("u1"), "TOKEN_SCAN", null);
    const e2 = led.issueFrom(vp.value, uid("u1"), "TOKEN_SCAN", null);
    const e3 = led.issueFrom(vp.value, uid("u1"), "TOKEN_SCAN", null);
    expect(e1.ok && e2.ok && e3.ok).toBe(true);
    if (e1.ok && e2.ok && e3.ok) {
      expect(e1.value.id).toBe(e2.value.id);
      expect(e2.value.id).toBe(e3.value.id);
    }
  });

  it("a scan entitlement can be consumed at most once", () => {
    const led = new EntitlementLedger();
    const vp = { intentId: "i", providerTxId: "tx-c", rail: "TON" as const, status: "VERIFIED" as const, verifiedAt: 100, amountUsd: usd(0.1) };
    const e = led.issueFrom(vp, uid("u1"), "TOKEN_SCAN", null);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const first = led.consume(e.value.id, uid("u1"), "scanexec-1", 200);
    const second = led.consume(e.value.id, uid("u1"), "scanexec-1", 201);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("rejects consumption by a different user", () => {
    const led = new EntitlementLedger();
    const vp = { intentId: "i", providerTxId: "tx-o", rail: "TON" as const, status: "VERIFIED" as const, verifiedAt: 100, amountUsd: usd(0.1) };
    const e = led.issueFrom(vp, uid("owner"), "TOKEN_SCAN", null);
    if (!e.ok) return;
    expect(led.consume(e.value.id, uid("intruder"), "x", 200).ok).toBe(false);
  });

  it("releaseIfUnused restores a consumed entitlement (failed scan path)", () => {
    const led = new EntitlementLedger();
    const vp = { intentId: "i", providerTxId: "tx-r", rail: "TON" as const, status: "VERIFIED" as const, verifiedAt: 100, amountUsd: usd(0.1) };
    const e = led.issueFrom(vp, uid("u1"), "TOKEN_SCAN", null);
    if (!e.ok) return;
    led.consume(e.value.id, uid("u1"), "scanexec-2", 200);
    const rel = led.releaseIfUnused(e.value.id);
    expect(rel.ok && rel.value.status).toBe("ISSUED");
    // can be consumed again after release
    expect(led.consume(e.value.id, uid("u1"), "scanexec-3", 300).ok).toBe(true);
  });
});

// ── Scan lifecycle ─────────────────────────────────────────────────────────────

describe("scan lifecycle", () => {
  it("follows RESERVED -> EXECUTING -> COMPLETED", () => {
    let ex = Scan.newExecution("ex1", "req1", 100);
    expect(ex.status).toBe("RESERVED");
    const e = Scan.beginExecuting(ex);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    ex = e.value;
    const c = Scan.complete(ex, "report-1", 200);
    expect(c.ok && c.value.status).toBe("COMPLETED");
    if (c.ok) expect(c.value.reportRef).toBe("report-1");
  });

  it("a failed scan is releasable and cannot complete afterwards", () => {
    let ex = Scan.newExecution("ex2", "req2", 100);
    const e = Scan.beginExecuting(ex);
    if (!e.ok) return;
    ex = e.value;
    const f = Scan.fail(ex, "gmgn timeout", 150);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(Scan.shouldReleaseEntitlement(f.value)).toBe(true);
    expect(Scan.complete(f.value, "r", 160).ok).toBe(false);
  });

  it("forbids illegal transitions", () => {
    const ex = Scan.newExecution("ex3", "req3", 100);
    expect(Scan.complete(ex, "r", 110).ok).toBe(false); // cannot COMPLETE from RESERVED
  });
});

// ── Monitor lifecycle ──────────────────────────────────────────────────────────

describe("monitor lifecycle", () => {
  const base = () =>
    Mon.createSession({
      id: "m1",
      userId: uid("u1"),
      token: tok,
      entitlementId: "ent:tx",
      pricingVersion: "pricing-v1",
      startedAt: 1000,
      durationMs: 24 * 60 * 60 * 1000,
    });

  it("computes expiry from startedAt + duration", () => {
    const s = base();
    expect(s.expiresAt).toBe(1000 + 24 * 60 * 60 * 1000);
    expect(s.status).toBe("PENDING");
  });

  it("activates then expires only when the injected clock is due", () => {
    const a = Mon.activate(base());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const notDue = Mon.expireIfDue(a.value, a.value.expiresAt - 1);
    expect(notDue.ok && notDue.value.status).toBe("ACTIVE");
    const due = Mon.expireIfDue(a.value, a.value.expiresAt);
    expect(due.ok && due.value.status).toBe("EXPIRED");
  });

  it("expired monitor allows no acquisition (invariant)", () => {
    const a = Mon.activate(base());
    if (!a.ok) return;
    expect(Mon.isAcquisitionAllowed(a.value, a.value.expiresAt - 1)).toBe(true);
    expect(Mon.isAcquisitionAllowed(a.value, a.value.expiresAt)).toBe(false);
    const paused = Mon.pause(a.value);
    if (paused.ok) expect(Mon.isAcquisitionAllowed(paused.value, 1000)).toBe(false);
  });
});

// ── Attention != Alert, signal continuity ──────────────────────────────────────

describe("alerts: Attention != Alert, signal continuity", () => {
  it("high attention alone does not raise an alert", () => {
    const entry = makeEntry({ attention: 96, events: [], signals: [] });
    const svc = new AlertService();
    const { alerts } = svc.evaluate(entry, {});
    expect(alerts.length).toBe(0);
  });

  it("first sighting of a signal emits NEW_SIGNAL once, not per tick", () => {
    const svc = new AlertService();
    const entry = makeEntry({ signals: [signal("sigA", "EMERGING")] });
    const r1 = svc.evaluate(entry, {});
    expect(r1.alerts.some((a) => a.reason === "NEW_SIGNAL")).toBe(true);
    // same phase next tick => no new alert
    const r2 = svc.evaluate(entry, r1.nextMemory as SignalPhaseMemory);
    expect(r2.alerts.some((a) => a.reason === "NEW_SIGNAL")).toBe(false);
  });

  it("alerts on a meaningful phase transition (EMERGING -> CONFIRMED)", () => {
    const svc = new AlertService();
    const mem: SignalPhaseMemory = { sigA: "EMERGING" };
    const entry = makeEntry({ signals: [signal("sigA", "CONFIRMED")] });
    const r = svc.evaluate(entry, mem);
    expect(r.alerts.some((a) => a.reason === "SIGNAL_CONFIRMED")).toBe(true);
  });

  it("raises event alerts only for policy-listed event types", () => {
    const svc = new AlertService();
    const entry = makeEntry({ events: [event("THREAT_SPIKE"), event("FLOW_CLUSTER")] });
    const { alerts } = svc.evaluate(entry, {});
    expect(alerts.some((a) => a.reason === "THREAT_SPIKE")).toBe(true);
    // FLOW_CLUSTER is not in the default policy
    expect(DEFAULT_ALERT_POLICY.eventTypesToAlert.has("FLOW_CLUSTER")).toBe(false);
  });
});

// ── IntelligenceReport + evidence aggregation ──────────────────────────────────

describe("intelligence report", () => {
  it("builds a renderer-independent report pinned with versions", () => {
    const entry = makeEntry({
      events: [event("STATE_CHANGE", 80)],
      signals: [signal("sigA", "EMERGING")],
    });
    const bf = makeBattlefield([entry]);
    const report = buildIntelligenceReport(bf, bf.tokens[0]!);
    expect(report.token.chain).toBe("sol");
    expect(report.modelVersions.engineVersion).toBe(bf.modelVersions.engineVersion);
    expect(report.generatedAt).toBe(bf.generatedAt as unknown as number);
    expect(report.marketRegime).toBe("RISK_ON");
  });

  it("aggregates evidence ONLY from Core-provided explainability", () => {
    const entry = makeEntry({
      supporting: [{ factor: "flow_accel", magnitude: 10, weight: 0.5 }],
      events: [event("FLOW_DIVERGENCE")],
      signals: [signal("sigA", "EMERGING")],
    });
    const ev = aggregateEvidence(entry);
    expect(ev.some((e) => e.kind === "POWER_SUPPORTING" && e.factor === "flow_accel")).toBe(true);
    expect(ev.some((e) => e.kind === "EVENT")).toBe(true);
    expect(ev.some((e) => e.kind === "SIGNAL")).toBe(true);
  });

  it("whyNow restates Core reasons ordered by event importance", () => {
    const entry = makeEntry({
      events: [event("REVERSAL", 30), event("POWER_BREAKOUT", 90)],
    });
    const w = whyNow(entry);
    expect(w[0]!.startsWith("POWER_BREAKOUT")).toBe(true); // higher importance first
  });
});

// ── Change-aware persistence ───────────────────────────────────────────────────

describe("change-aware persistence", () => {
  it("always persists the first observation", () => {
    const fp = fingerprint(makeEntry({}));
    const d = decidePersist(null, fp, null, 1000);
    expect(d.persist).toBe(true);
  });

  it("does not persist an identical state within the checkpoint window", () => {
    const e = makeEntry({ power: 71, threat: 22, state: "ATTACK" });
    const fp = fingerprint(e);
    const d = decidePersist(fp, fp, 1000, 1000 + 60_000); // 1 min < 15 min interval
    expect(d.persist).toBe(false);
  });

  it("persists on a state transition", () => {
    const prev = fingerprint(makeEntry({ state: "ACCUMULATION" }));
    const next = fingerprint(makeEntry({ state: "ATTACK" }));
    const d = decidePersist(prev, next, 1000, 1000 + 1000);
    expect(d.persist).toBe(true);
    expect(d.reasons).toContain("state transition");
  });

  it("forces a checkpoint after the configured interval", () => {
    const fp = fingerprint(makeEntry({}));
    const later = 1000 + DEFAULT_PERSISTENCE_POLICY.checkpointIntervalMs;
    const d = decidePersist(fp, fp, 1000, later);
    expect(d.persist).toBe(true);
    expect(d.reasons).toContain("checkpoint interval");
  });

  it("persists on a signal lifecycle change", () => {
    const prev = fingerprint(makeEntry({ signals: [signal("s", "EMERGING")] }));
    const next = fingerprint(makeEntry({ signals: [signal("s", "CONFIRMED")] }));
    const d = decidePersist(prev, next, 1000, 1000 + 1000);
    expect(d.persist).toBe(true);
    expect(d.reasons).toContain("signal lifecycle change");
  });
});
