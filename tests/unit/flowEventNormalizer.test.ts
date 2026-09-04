import { describe, it, expect } from "vitest";
import { flowEventNormalizer } from "../../src/adapters/gmgn/flowEventNormalizer.js";
import type {
  RawFollowWalletEvent,
  RawKolSmartMoneyEvent,
} from "../../src/adapters/gmgn/FlowEventNormalizer.contract.js";

function fw(
  side: "buy" | "sell",
  bit: 0 | 1,
): RawFollowWalletEvent {
  return {
    __source: "follow-wallet",
    transaction_hash: "0xabc",
    maker: "walletA",
    side,
    base_address: "TOKEN",
    amount_usd: "1000",
    price_usd: "1.0",
    buy_cost_usd: "0",
    is_open_or_close: bit,
    timestamp: 1700000000,
    quote_address: "SOL",
    base_amount: "1000",
    quote_amount: "5",
    price_change: "1.2",
    price_now: "1.2",
    maker_info: { tags: ["kol"], tag_rank: { kol: 10 } },
  };
}

function km(
  source: "kol" | "smartmoney",
  side: "buy" | "sell",
  bit: 0 | 1,
): RawKolSmartMoneyEvent {
  return {
    __source: source,
    transaction_hash: "0xdef",
    maker: "walletB",
    side,
    base_address: "TOKEN",
    amount_usd: "2000",
    price_usd: "1.0",
    buy_cost_usd: "0",
    is_open_or_close: bit,
    timestamp: 1700000001,
    token_amount: "2000",
    maker_info: { tags: ["smart_degen"] },
  };
}

describe("FlowEventNormalizer - section D follow-wallet (bit = FULLNESS)", () => {
  it("bit 1 + buy -> FULL_OPEN", () => {
    const n = flowEventNormalizer.normalize(fw("buy", 1));
    expect(n.positionEvent).toBe("FULL_OPEN");
    expect(n.fullness).toBe("FULL");
    expect(n.direction).toBe("OPEN");
  });
  it("bit 1 + sell -> FULL_CLOSE", () => {
    const n = flowEventNormalizer.normalize(fw("sell", 1));
    expect(n.positionEvent).toBe("FULL_CLOSE");
    expect(n.fullness).toBe("FULL");
    expect(n.direction).toBe("CLOSE");
  });
  it("bit 0 + buy -> PARTIAL_ADD", () => {
    const n = flowEventNormalizer.normalize(fw("buy", 0));
    expect(n.positionEvent).toBe("PARTIAL_ADD");
    expect(n.fullness).toBe("PARTIAL");
  });
  it("bit 0 + sell -> PARTIAL_REDUCE", () => {
    const n = flowEventNormalizer.normalize(fw("sell", 0));
    expect(n.positionEvent).toBe("PARTIAL_REDUCE");
    expect(n.fullness).toBe("PARTIAL");
  });
});

describe("FlowEventNormalizer - section D kol/smartmoney (bit = DIRECTION, fullness UNKNOWN)", () => {
  it("bit 0 -> OPEN_OR_ADD, fullness UNKNOWN (I1: never FULL/PARTIAL)", () => {
    for (const src of ["kol", "smartmoney"] as const) {
      const n = flowEventNormalizer.normalize(km(src, "buy", 0));
      expect(n.positionEvent).toBe("OPEN_OR_ADD");
      expect(n.fullness).toBe("UNKNOWN");
      expect(n.direction).toBe("OPEN");
    }
  });
  it("bit 1 -> CLOSE_OR_REDUCE, fullness UNKNOWN", () => {
    const n = flowEventNormalizer.normalize(km("smartmoney", "sell", 1));
    expect(n.positionEvent).toBe("CLOSE_OR_REDUCE");
    expect(n.fullness).toBe("UNKNOWN");
    expect(n.direction).toBe("CLOSE");
  });
  it("I1: kol/smartmoney NEVER produce FULL_* or PARTIAL_* across all bit/side combos", () => {
    const forbidden = new Set([
      "FULL_OPEN", "FULL_CLOSE", "PARTIAL_ADD", "PARTIAL_REDUCE",
    ]);
    for (const src of ["kol", "smartmoney"] as const) {
      for (const side of ["buy", "sell"] as const) {
        for (const bit of [0, 1] as const) {
          const n = flowEventNormalizer.normalize(km(src, side, bit));
          expect(forbidden.has(n.positionEvent)).toBe(false);
        }
      }
    }
  });
});

describe("FlowEventNormalizer - invariants", () => {
  it("I3: the raw bit name never leaks into the normalized output", () => {
    const n = flowEventNormalizer.normalize(fw("buy", 1));
    expect(JSON.stringify(n).includes("is_open_or_close")).toBe(false);
  });
  it("I4: interpretedUnder always equals source", () => {
    expect(flowEventNormalizer.normalize(fw("buy", 1)).interpretedUnder).toBe(
      "follow-wallet",
    );
    expect(
      flowEventNormalizer.normalize(km("kol", "buy", 0)).interpretedUnder,
    ).toBe("kol");
  });
  it("is deterministic", () => {
    const a = flowEventNormalizer.normalize(fw("sell", 0));
    const b = flowEventNormalizer.normalize(fw("sell", 0));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
