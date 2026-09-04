import { describe, it, expect } from "vitest";
import { TrendingCache, seedAddressSource, type TrendingToken } from "../../src/product/trending/trendingCache.js";

const SEED: TrendingToken[] = [{ chain: "sol", address: "A" }, { chain: "bsc", address: "B" }];
const TTL = 4 * 60 * 60 * 1000;

describe("TrendingCache", () => {
  it("evaluates each seed token on first get", async () => {
    const c = new TrendingCache<string>({ ttlMs: TTL }, seedAddressSource(SEED), async (t) => `${t.chain}:${t.address}`);
    const s = await c.get(1000);
    expect(s.tokens).toEqual(["sol:A", "bsc:B"]);
    expect(s.stale).toBe(false);
  });

  it("serves cache within TTL without re-evaluating", async () => {
    let calls = 0;
    const c = new TrendingCache<string>({ ttlMs: TTL }, seedAddressSource(SEED), async (t) => { calls++; return t.address; });
    await c.get(0);
    await c.get(TTL - 1);       // still fresh
    expect(calls).toBe(2);      // 2 tokens, evaluated once total
  });

  it("refreshes after TTL expires", async () => {
    let round = 0;
    const src = async () => { round++; return SEED; };
    const c = new TrendingCache<string>({ ttlMs: TTL }, src, async (t) => `${round}:${t.address}`);
    await c.get(0);
    expect(c.isStale(TTL - 1)).toBe(false);
    expect(c.isStale(TTL)).toBe(true);
    const s2 = await c.get(TTL);
    expect(s2.tokens[0]).toBe("2:A"); // second source round
  });

  it("shares a single in-flight refresh across concurrent callers (no herd)", async () => {
    let sourceCalls = 0;
    const src = async () => { sourceCalls++; await new Promise((r) => setTimeout(r, 10)); return SEED; };
    const c = new TrendingCache<string>({ ttlMs: TTL }, src, async (t) => t.address);
    const [a, b, d] = await Promise.all([c.get(0), c.get(0), c.get(0)]);
    expect(sourceCalls).toBe(1);         // one refresh, not three
    expect(a).toBe(b); expect(b).toBe(d);
  });

  it("serves last good snapshot as stale when a refresh source fails", async () => {
    let ok = true;
    const src = async () => (ok ? SEED : null);
    const c = new TrendingCache<string>({ ttlMs: TTL }, src, async (t) => t.address);
    await c.get(0);            // good snapshot
    ok = false;
    const s = await c.get(TTL); // source now fails
    expect(s.stale).toBe(true);
    expect(s.tokens).toEqual(["A", "B"]); // still the last good data
  });

  it("returns an empty stale snapshot when there is no prior data and source fails", async () => {
    const c = new TrendingCache<string>({ ttlMs: TTL }, async () => null, async (t) => t.address);
    const s = await c.get(0);
    expect(s.tokens).toEqual([]);
    expect(s.stale).toBe(true);
  });

  it("drops tokens whose evaluation fails (never fabricates)", async () => {
    const c = new TrendingCache<string>({ ttlMs: TTL }, seedAddressSource(SEED),
      async (t) => (t.address === "A" ? null : t.address));
    const s = await c.get(0);
    expect(s.tokens).toEqual(["B"]); // A dropped, B kept
  });

  it("empty seed is valid (arena shows nothing, honestly)", async () => {
    const c = new TrendingCache<string>({ ttlMs: TTL }, seedAddressSource([]), async (t) => t.address);
    const s = await c.get(0);
    expect(s.tokens).toEqual([]);
    expect(s.stale).toBe(false);
  });
});
