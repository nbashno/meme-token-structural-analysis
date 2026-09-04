import { describe, it, expect } from "vitest";
import {
  parseKline,
  parseTrending,
  parseFlowEvent,
  stripBannedFields,
} from "../../src/adapters/gmgn/gmgnParsers.js";
import type { RawKline, RawTrending } from "../../src/adapters/gmgn/gmgnParsers.js";
import {
  runGmgnJson,
  klineArgv,
  trackArgv,
  ROUTE_WEIGHTS,
  RATE_LIMIT,
} from "../../src/adapters/gmgn/gmgnRunner.js";
import type {
  CliExecutor,
  CliRunResult,
} from "../../src/adapters/gmgn/gmgnRunner.js";
import type {
  RawKolSmartMoneyEvent,
  RawFollowWalletEvent,
} from "../../src/adapters/gmgn/FlowEventNormalizer.contract.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

describe("parseKline", () => {
  const raw: RawKline = {
    time: 1_700_000_000_000,
    open: "1.5",
    close: "1.8",
    high: "2.0",
    low: "1.4",
    volume: "50000", // USD
    amount: "27000", // token units
  };

  it("parses string numerics and keeps ms time", () => {
    const o = parseKline(raw);
    expect(o).not.toBeNull();
    expect(o?.close).toBe(1.8);
    expect(o?.volumeUsd).toBe(50000);
    expect(o?.amountTokens).toBe(27000);
    expect(o?.meta.coverage).toBe("COMPLETE");
    expect(o?.meta.at as number).toBe(1_700_000_000_000);
  });

  it("returns null on a malformed row (never a fabricated zero candle)", () => {
    const bad = { ...raw, close: "not-a-number" };
    expect(parseKline(bad)).toBeNull();
  });
});

describe("parseTrending - hot_level never enters the core", () => {
  it("parses core analytics fields", () => {
    const raw: RawTrending = {
      price: "0.0002",
      market_cap: "2000000",
      liquidity: "80000",
      holder_count: 1500,
      swaps: 400,
      buys: 250,
      sells: 150,
      smart_degen_count: 8,
      renowned_count: 3,
    };
    const o = parseTrending(raw, 1_700_000_000_000 as UnixMillis);
    expect(o?.price).toBe(0.0002);
    expect(o?.meta.coverage).toBe("SAMPLED");
  });

  it("stripBannedFields removes hot_level so it cannot leak", () => {
    const withHot = { price: "1", hot_level: 99 } as Record<string, unknown>;
    const stripped = stripBannedFields(withHot);
    expect("hot_level" in stripped).toBe(false);
  });

  it("the output observation contains no hot_level key", () => {
    const raw = { price: "1", market_cap: "1", liquidity: "1", hot_level: 99 } as RawTrending;
    const o = parseTrending(raw, 0 as UnixMillis);
    expect(JSON.stringify(o).includes("hot_level")).toBe(false);
  });
});

describe("parseFlowEvent - Sec D applied to live-shaped data", () => {
  it("follow-wallet full buy -> FULL_OPEN via normalizer", () => {
    const raw: RawFollowWalletEvent = {
      __source: "follow-wallet",
      transaction_hash: "0x1", maker: "w1", side: "buy",
      base_address: "T", amount_usd: "1000", price_usd: "1", buy_cost_usd: "0",
      is_open_or_close: 1, timestamp: 1_700_000_000_000,
      quote_address: "SOL", base_amount: "1000", quote_amount: "5",
      price_change: "1", price_now: "1", maker_info: { tags: [] },
    };
    const o = parseFlowEvent(raw);
    expect(o?.positionEvent).toBe("FULL_OPEN");
    expect(o?.meta.provenance).toBe("track.follow-wallet");
    expect(o?.meta.coverage).toBe("ROLLING");
  });

  it("kol event fullness stays UNKNOWN (Sec D I1 preserved through the parser)", () => {
    const raw: RawKolSmartMoneyEvent = {
      __source: "kol",
      transaction_hash: "0x2", maker: "w2", side: "buy",
      base_address: "T", amount_usd: "2000", price_usd: "1", buy_cost_usd: "0",
      is_open_or_close: 0, timestamp: 1_700_000_000_001,
      token_amount: "2000", maker_info: { tags: ["smart_degen"] },
    };
    const o = parseFlowEvent(raw);
    expect(o?.positionEvent).toBe("OPEN_OR_ADD");
    expect(o?.fullness).toBe("UNKNOWN");
  });
});

describe("runGmgnJson - error taxonomy, never throws to core", () => {
  const execOf = (res: Partial<CliRunResult>): CliExecutor => ({
    run: async () => ({
      exitCode: res.exitCode ?? 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      ...(res.headers !== undefined ? { headers: res.headers } : {}),
    }),
  });

  it("parses valid JSON stdout", async () => {
    const r = await runGmgnJson<{ x: number }>(
      execOf({ exitCode: 0, stdout: '{"x":1}' }),
      klineArgv("sol", "T", "1m"),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.x).toBe(1);
  });

  it("classifies 429 as RATE_LIMIT and surfaces reset time", async () => {
    const r = await runGmgnJson(
      execOf({ exitCode: 1, stderr: "HTTP 429 rate limit", headers: { "x-ratelimit-reset": "1700000123" } }),
      trackArgv("kol", "sol"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("RATE_LIMIT");
      expect(r.resetAt).toBe(1700000123);
    }
  });

  it("classifies auth failures", async () => {
    const r = await runGmgnJson(execOf({ exitCode: 1, stderr: "401 Unauthorized" }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("AUTH_ERROR");
  });

  it("classifies missing CLI", async () => {
    const r = await runGmgnJson(execOf({ exitCode: 127, stderr: "command not found" }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("CLI_MISSING");
  });

  it("classifies invalid JSON as FORMAT_ERROR", async () => {
    const r = await runGmgnJson(execOf({ exitCode: 0, stdout: "not json" }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("FORMAT_ERROR");
  });

  it("a thrown executor becomes NETWORK_ERROR, not an exception to the core", async () => {
    const exec: CliExecutor = { run: async () => { throw new Error("boom"); } };
    const r = await runGmgnJson(exec, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("NETWORK_ERROR");
  });
});

describe("sealed rate-limit facts", () => {
  it("kline weight is 2, track weights are 1/1/3, holders/traders 5", () => {
    expect(ROUTE_WEIGHTS["kline"]).toBe(2);
    expect(ROUTE_WEIGHTS["kol"]).toBe(1);
    expect(ROUTE_WEIGHTS["smartmoney"]).toBe(1);
    expect(ROUTE_WEIGHTS["follow-wallet"]).toBe(3);
    expect(ROUTE_WEIGHTS["token-holders"]).toBe(5);
  });
  it("leaky bucket is 20/20", () => {
    expect(RATE_LIMIT.rate).toBe(20);
    expect(RATE_LIMIT.capacity).toBe(20);
  });
});
