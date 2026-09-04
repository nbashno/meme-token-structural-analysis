import { describe, it, expect } from "vitest";
import { UsageLimiter } from "../../src/product/pricing/usageLimiter.js";
import type { UserId } from "../../src/product/domain/identity.js";

const U = "u1" as UserId;
const DAY = 24 * 60 * 60 * 1000;

describe("UsageLimiter — rolling 24h per-user caps", () => {
  it("allows up to the cap, then blocks", () => {
    const l = new UsageLimiter();
    for (let i = 0; i < 3; i++) {
      expect(l.check(U, "scan", 3, 1000).allowed).toBe(true);
      l.record(U, "scan", 1000);
    }
    const blocked = l.check(U, "scan", 3, 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAtMs).toBe(1000 + DAY);
  });

  it("null cap is unlimited (COMMAND)", () => {
    const l = new UsageLimiter();
    for (let i = 0; i < 100; i++) l.record(U, "scan", 1000);
    expect(l.check(U, "scan", null, 1000).allowed).toBe(true);
    expect(l.check(U, "scan", null, 1000).remaining).toBeNull();
  });

  it("counts roll off after 24h", () => {
    const l = new UsageLimiter();
    for (let i = 0; i < 3; i++) l.record(U, "scan", 1000);
    expect(l.check(U, "scan", 3, 1000).allowed).toBe(false);
    // a day and a bit later, the old ones have aged out
    expect(l.check(U, "scan", 3, 1000 + DAY + 1).allowed).toBe(true);
  });

  it("scan and monitor are tracked separately", () => {
    const l = new UsageLimiter();
    for (let i = 0; i < 3; i++) l.record(U, "scan", 1000);
    expect(l.check(U, "scan", 3, 1000).allowed).toBe(false);
    expect(l.check(U, "monitor", 3, 1000).allowed).toBe(true); // own bucket
  });

  it("used() reports current window count", () => {
    const l = new UsageLimiter();
    l.record(U, "scan", 1000);
    l.record(U, "scan", 2000);
    expect(l.used(U, "scan", 3000)).toBe(2);
    expect(l.used(U, "scan", 2000 + DAY + 1)).toBe(0); // all aged out
  });

  it("remaining decrements as the window fills", () => {
    const l = new UsageLimiter();
    expect(l.check(U, "scan", 3, 1000).remaining).toBe(2);
    l.record(U, "scan", 1000);
    expect(l.check(U, "scan", 3, 1000).remaining).toBe(1);
  });
});
