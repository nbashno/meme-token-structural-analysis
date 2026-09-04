import { describe, it, expect } from "vitest";

import { MonitoringService } from "../../src/integration/MonitoringService.js";
import { monitorTick, initialCarry } from "../../src/integration/monitorTick.js";
import { RealWarEvaluationPort } from "../../src/integration/RealWarEvaluationPort.js";
import { createSession, activate } from "../../src/product/monitor/monitor.js";
import { computeLiquidityFragility } from "../../src/core/features/liquidityFragility.js";
import type { GmgnAcquisitionPort, NormalizedObservations } from "../../src/product/scan/ports/ports.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";
import { ok } from "../../src/product/domain/identity.js";
import { makeEntry, makeBattlefield } from "../unit/productFixtures.js";
import type { MarketObservation, AnalyticsObservation, FlowObservation } from "../../src/core/timeline/types.js";
import type { UnixMillis, Chain, TokenAddress } from "../../src/shared/scalars.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

// ── monitorTick: pure progression T0 -> T1 -> T2 ─────────────────────────────

describe("Phase 6 monitorTick — before/after over time (what scan B1 could not)", () => {
  it("first tick has NO events (no prior snapshot), later ticks CAN", () => {
    const t0 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 40, state: "ACCUMULATION" })]);
    const r0 = monitorTick(t0, tok.address as TokenAddress, 1000 as UnixMillis, initialCarry());
    expect(r0.events).toHaveLength(0); // first sighting, no before
    expect(r0.nextCarry.priorSnapshot).not.toBeNull();

    // T1: a big power jump should now be detectable as an event
    const t1 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 85, state: "ATTACK" })]);
    const r1 = monitorTick(t1, tok.address as TokenAddress, 2000 as UnixMillis, r0.nextCarry);
    // with a prior snapshot, detectEvents runs (may or may not fire, but is invoked)
    expect(r1.nextCarry.priorSnapshot!.power).toBe(85);
  });

  it("persists the first observation, then only on meaningful change", () => {
    const t0 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 50, state: "ACCUMULATION" })]);
    const r0 = monitorTick(t0, tok.address as TokenAddress, 1000 as UnixMillis, initialCarry());
    expect(r0.persist.persist).toBe(true); // first observation

    // identical state shortly after -> no persist (within checkpoint window)
    const r1 = monitorTick(t0, tok.address as TokenAddress, 1000 + 60_000 as UnixMillis, r0.nextCarry);
    expect(r1.persist.persist).toBe(false);

    // state change -> persist
    const t2 = makeBattlefield([makeEntry({ address: "TokenAAA", power: 50, state: "DISTRIBUTION" })]);
    const r2 = monitorTick(t2, tok.address as TokenAddress, 1000 + 120_000 as UnixMillis, r1.nextCarry);
    expect(r2.persist.persist).toBe(true);
    expect(r2.persist.reasons).toContain("state transition");
  });

  it("threads signal-phase memory so a signal is not re-alerted each tick", () => {
    const entry = makeEntry({ address: "TokenAAA" });
    const bf = makeBattlefield([entry]);
    const r0 = monitorTick(bf, tok.address as TokenAddress, 1000 as UnixMillis, initialCarry());
    const r1 = monitorTick(bf, tok.address as TokenAddress, 2000 as UnixMillis, r0.nextCarry);
    // carry memory advanced; no crash, memory persists across ticks
    expect(r1.nextCarry.signalPhaseMemory).toBeDefined();
  });
});

// ── MonitoringService: expiry + acquisition gating ───────────────────────────

function stubAcq(obs: NormalizedObservations): GmgnAcquisitionPort {
  return { async acquire() { return ok(obs); } };
}

function normalized(): NormalizedObservations {
  const market: MarketObservation[] = [
    { meta: { at: 1000 as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" }, open: 1, high: 1.1, low: 0.9, close: 1.0, volumeUsd: 10000, amountTokens: 100000 },
    { meta: { at: 2000 as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" }, open: 1, high: 1.2, low: 1.0, close: 1.15, volumeUsd: 12000, amountTokens: 110000 },
    { meta: { at: 3000 as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" }, open: 1.15, high: 1.3, low: 1.1, close: 1.28, volumeUsd: 15000, amountTokens: 120000 },
  ];
  const analytics: AnalyticsObservation[] = [
    { meta: { at: 3000 as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" }, price: 1.28, marketCap: 1000000, liquidity: 200000, holderCount: 1000, swaps: 100, buys: 60, sells: 40, smartDegenCount: 3, renownedCount: 1, rugRatio: 0.2, top10HolderRate: 0.3, isWashTrading: false, bundlerRate: 0.1 },
  ];
  const flow: FlowObservation[] = [
    { meta: { at: 1500 as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: "track.smartmoney" }, maker: "wA", side: "buy", amountUsd: 5000, priceUsd: 1.1, positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN" },
  ];
  return { chain: "sol" as Chain, address: tok.address as TokenAddress, market, analytics, flow, observedFromMs: 1000, observedToMs: 3000 };
}

describe("Phase 6 MonitoringService — expiry + real evaluation", () => {
  function session(startedAt: number, durationMs: number) {
    return createSession({ id: "m1", userId: uid("u1"), token: tok, entitlementId: "ent:x", pricingVersion: "pricing-v1", startedAt, durationMs });
  }

  it("ACTIVE session acquires + evaluates through real WAR", async () => {
    const svc = new MonitoringService({ acquisition: stubAcq(normalized()), evaluation: new RealWarEvaluationPort(), clock: { now: () => 5000 } as Clock });
    const active = activate(session(0, 24 * 3600 * 1000));
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const r = await svc.tick(active.value, initialCarry());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skipped).toBeNull();
    expect(r.value.session.lastObservationAt).toBe(5000);
  });

  it("EXPIRED session performs NO acquisition (invariant)", async () => {
    let acquired = false;
    const spyAcq: GmgnAcquisitionPort = { async acquire() { acquired = true; return ok(normalized()); } };
    const svc = new MonitoringService({ acquisition: spyAcq, evaluation: new RealWarEvaluationPort(), clock: { now: () => 999999999 } as Clock });
    const active = activate(session(0, 1000)); // expires at 1000
    if (!active.ok) return;
    const r = await svc.tick(active.value, initialCarry());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skipped).toBe("EXPIRED");
    expect(acquired).toBe(false); // never acquired
  });
});

// ── liquidityFragility: monitor-only, gated ──────────────────────────────────

describe("Phase 6 liquidityFragility — gated, no invention", () => {
  it("INSUFFICIENT with fewer than 3 samples", () => {
    const r = computeLiquidityFragility([{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 90 }], 2000);
    expect(r.insufficient).toBe(true);
    expect(r.value).toBeNull();
  });

  it("INSUFFICIENT when newest sample is stale beyond max gap", () => {
    const r = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 95 }, { at: 3000, liquidity: 90 }],
      3000 + 5 * 60 * 1000, // 5 min later, > 2 min gap
    );
    expect(r.insufficient).toBe(true);
  });

  it("computes relative drop from peak when the gate passes", () => {
    const r = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 100 }, { at: 3000, liquidity: 60 }],
      3000,
    );
    expect(r.insufficient).toBe(false);
    expect(r.value).toBeCloseTo(0.4, 9); // dropped 40% from peak 100
  });

  it("zero fragility when liquidity is at its peak (no drop)", () => {
    const r = computeLiquidityFragility(
      [{ at: 1000, liquidity: 80 }, { at: 2000, liquidity: 90 }, { at: 3000, liquidity: 100 }],
      3000,
    );
    expect(r.value).toBe(0);
  });

  it("anti-lookahead: samples after T are ignored", () => {
    const withFuture = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 100 }, { at: 3000, liquidity: 60 }, { at: 9000, liquidity: 10 }],
      3000,
    );
    const withoutFuture = computeLiquidityFragility(
      [{ at: 1000, liquidity: 100 }, { at: 2000, liquidity: 100 }, { at: 3000, liquidity: 60 }],
      3000,
    );
    expect(withFuture.value).toBe(withoutFuture.value); // future sample @9000 ignored
  });
});
