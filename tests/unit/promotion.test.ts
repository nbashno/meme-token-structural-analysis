import { describe, it, expect } from "vitest";
import { PromotionPolicy, parseFreeUntil } from "../../src/product/pricing/promotion.js";

describe("PromotionPolicy — fixed-date launch free window", () => {
  const CUT = 2_000_000_000_000; // fixed cutoff (ms)

  it("is free strictly before the cutoff", () => {
    const p = new PromotionPolicy({ freeUntilMs: CUT });
    expect(p.isFree(CUT - 1)).toBe(true);
    expect(p.isFree(CUT)).toBe(false);      // boundary: cutoff itself is NOT free
    expect(p.isFree(CUT + 1)).toBe(false);
  });

  it("has no promotion when unset (normal billing immediately)", () => {
    const p = new PromotionPolicy({ freeUntilMs: undefined });
    expect(p.isFree(0)).toBe(false);
    expect(p.isFree(CUT)).toBe(false);
    expect(p.freeUntil()).toBeNull();
  });

  it("reports honest status for the UI", () => {
    const p = new PromotionPolicy({ freeUntilMs: CUT });
    const active = p.status(CUT - 5000);
    expect(active.active).toBe(true);
    expect(active.msRemaining).toBe(5000);
    const over = p.status(CUT + 5000);
    expect(over.active).toBe(false);
    expect(over.msRemaining).toBe(0);
  });

  it("parseFreeUntil accepts ISO dates and rejects junk", () => {
    expect(parseFreeUntil("2026-10-01")).toBe(Date.parse("2026-10-01"));
    expect(parseFreeUntil("2026-10-01T00:00:00Z")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseFreeUntil("")).toBeUndefined();
    expect(parseFreeUntil(undefined)).toBeUndefined();
    expect(parseFreeUntil("not-a-date")).toBeUndefined();
  });
});
