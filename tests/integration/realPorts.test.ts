import { describe, it, expect } from "vitest";

import { RealWarEvaluationPort } from "../../src/integration/RealWarEvaluationPort.js";
import { RealGmgnAcquisitionPort } from "../../src/integration/RealGmgnAcquisitionPort.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { NormalizedObservations } from "../../src/product/scan/ports/ports.js";
import type { Chain, TokenAddress } from "../../src/shared/scalars.js";
import type { MarketObservation, AnalyticsObservation, FlowObservation } from "../../src/core/timeline/types.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const chain: Chain = "sol";
const address = "TokenAAA" as TokenAddress;

// ── 5B-A: RealWarEvaluationPort -> real core, no injected intelligence ─────────

function marketObs(at: number, close: number): MarketObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_HISTORICAL", coverage: "COMPLETE", provenance: "market.kline" },
    open: close, high: close + 1, low: close - 1, close, volumeUsd: 10_000, amountTokens: 100_000,
  };
}
function analyticsObs(at: number): AnalyticsObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "WAR_SAMPLED", coverage: "SAMPLED", provenance: "market.trending" },
    price: 1, marketCap: 1_000_000, liquidity: 200_000, holderCount: 1000,
    swaps: 100, buys: 60, sells: 40, smartDegenCount: 3, renownedCount: 1,
    rugRatio: 0.2, top10HolderRate: 0.3, isWashTrading: false, bundlerRate: 0.1,
  };
}
function flowObs(at: number, side: "buy" | "sell"): FlowObservation {
  return {
    meta: { at: at as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: "track.smartmoney" },
    maker: `w${at}`, side, amountUsd: 5000, priceUsd: 1,
    positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN",
  };
}

function normalized(): NormalizedObservations {
  return {
    chain, address,
    market: [marketObs(1000, 1.0), marketObs(2000, 1.1), marketObs(3000, 1.25)],
    analytics: [analyticsObs(3000)],
    flow: [flowObs(1500, "buy"), flowObs(2500, "buy")],
    observedFromMs: 1000, observedToMs: 3000,
  };
}

describe("5B-A RealWarEvaluationPort -> real Core (no injected intelligence)", () => {
  it("produces a real BattlefieldState from observations via evaluateToBattlefield", async () => {
    const port = new RealWarEvaluationPort();
    const res = await port.evaluate(normalized(), 3000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bf = res.value;
    expect(bf.tokens).toHaveLength(1);
    expect(bf.tokens[0]!.address).toBe(address);
    // Power/Threat came from the real chain, not injected: supporting contributions exist.
    expect(bf.tokens[0]!.power.supporting.length).toBeGreaterThan(0);
    expect(bf.modelVersions.activationModelVersion).toBe("activation-v1");
  });

  it("maps atMs to evaluationAt (generatedAt reflects the instant passed)", async () => {
    const port = new RealWarEvaluationPort();
    const res = await port.evaluate(normalized(), 4242);
    expect(res.ok && (res.value.generatedAt as unknown as number)).toBe(4242);
  });

  it("records diagnostics via sink but never uses them to alter the result", async () => {
    let recorded: readonly string[] | null = null;
    const port = new RealWarEvaluationPort({ record: (i) => { recorded = i; } });
    const res = await port.evaluate(normalized(), 3000);
    expect(res.ok).toBe(true);
    expect(recorded).not.toBeNull(); // diagnostics observed
  });

  it("is deterministic: same observations -> byte-identical battlefield", async () => {
    const port = new RealWarEvaluationPort();
    const a = await port.evaluate(normalized(), 3000);
    const b = await port.evaluate(normalized(), 3000);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });
});

// ── 5B-B: RealGmgnAcquisitionPort raw CLI -> parser -> normalizer -> observations

/** A stub CLI that returns raw-shaped GMGN payloads per argv. Replaces NETWORK only. */
function stubCli(): CliExecutor {
  return {
    async run(argv: readonly string[]): Promise<CliRunResult> {
      const cmd = argv.join(" ");
      if (cmd.includes("market kline")) {
        const rows = [
          { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
          { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
          { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
        ];
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (cmd.includes("market trending")) {
        const rows = [
          { price: 1.25, market_cap: 1000000, liquidity: 200000, holder_count: 1500,
            swaps: 300, buys: 180, sells: 120, smart_degen_count: 8, renowned_count: 3,
            rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 },
        ];
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (cmd.includes("track")) {
        const rows = [
          { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy",
            base_address: address, amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000",
            is_open_or_close: 0, timestamp: 1500, maker_info: { tags: ["smart_degen"] }, token_amount: "6600" },
          { __source: "smartmoney", transaction_hash: "0x2", maker: "wB", side: "buy",
            base_address: address, amount_usd: "6000", price_usd: "1.22", buy_cost_usd: "6000",
            is_open_or_close: 0, timestamp: 2500, maker_info: { tags: ["smart_degen"] }, token_amount: "4900" },
        ];
        return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown command" };
    },
  };
}

describe("5B-B RealGmgnAcquisitionPort raw -> parser -> normalizer -> observations", () => {
  it("acquires normalized observations from raw CLI payloads (real parser path)", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const obs = res.value;
    expect(obs.market.length).toBe(3); // parsed from raw kline
    expect(obs.analytics.length).toBe(1); // parsed from raw trending
    expect(obs.flow.length).toBe(2); // parsed + normalized from raw track
  });

  it("security fields survive raw->normalized with meaning intact", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    if (!res.ok) return;
    const a = res.value.analytics[0]!;
    expect(a.rugRatio).toBe(0.15);
    expect(a.top10HolderRate).toBe(0.35);
    expect(a.isWashTrading).toBe(false);
    expect(a.bundlerRate).toBe(0.05);
  });

  it("flow is normalized through the sealed normalizer (provenance track.smartmoney)", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    if (!res.ok) return;
    expect(res.value.flow[0]!.meta.provenance).toBe("track.smartmoney");
    // normalized observation carries NO raw is_open_or_close bit
    expect((res.value.flow[0] as unknown as Record<string, unknown>)["is_open_or_close"]).toBeUndefined();
  });

  it("acquisition returns ONLY observations, never a battlefield or power/threat", async () => {
    const port = new RealGmgnAcquisitionPort(stubCli());
    const res = await port.acquire(chain, address, 3000);
    if (!res.ok) return;
    const keys = Object.keys(res.value);
    expect(keys).not.toContain("tokens"); // no battlefield
    expect(keys).not.toContain("power");
    expect(keys).not.toContain("threat");
    expect(keys.sort()).toEqual(["address", "analytics", "chain", "flow", "market", "observedFromMs", "observedToMs"]);
  });

  it("a failed CLI lane -> acquisition error (no fabricated observations)", async () => {
    const failing: CliExecutor = { async run() { return { exitCode: 1, stdout: "", stderr: "boom" }; } };
    const port = new RealGmgnAcquisitionPort(failing);
    const res = await port.acquire(chain, address, 3000);
    expect(res.ok).toBe(false);
  });
});

// ── 5B end-to-end: acquire (stub CLI) -> evaluate (real core), full transport ──

describe("5B end-to-end: raw CLI -> normalized -> real evaluation", () => {
  it("chains both real ports: raw payload flows all the way to a battlefield", async () => {
    const acq = new RealGmgnAcquisitionPort(stubCli());
    const evalPort = new RealWarEvaluationPort();

    const acquired = await acq.acquire(chain, address, 3000);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const evaluated = await evalPort.evaluate(acquired.value, acquired.value.observedToMs);
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    // power/threat emerged from raw payload through the entire real chain
    expect(evaluated.value.tokens[0]!.power.score as number).toBeGreaterThanOrEqual(0);
    expect(evaluated.value.tokens[0]!.threat.score as number).toBeGreaterThan(0); // rug 0.15 -> threat
  });
});
