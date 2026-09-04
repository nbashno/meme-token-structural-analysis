import { describe, it, expect } from "vitest";
import { RateLimiter, corsHeaders, securityHeaders, StructuredLogger } from "../../src/api/security.js";

describe("RateLimiter — token bucket", () => {
  it("allows up to capacity, then blocks", () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1 });
    expect(rl.take("ip1", 0).allowed).toBe(true);
    expect(rl.take("ip1", 0).allowed).toBe(true);
    expect(rl.take("ip1", 0).allowed).toBe(true);
    const blocked = rl.take("ip1", 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1 });
    rl.take("ip", 0); rl.take("ip", 0); // drained
    expect(rl.take("ip", 0).allowed).toBe(false);
    // 1 second later -> 1 token back
    expect(rl.take("ip", 1000).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(rl.take("a", 0).allowed).toBe(true);
    expect(rl.take("b", 0).allowed).toBe(true); // different key, own bucket
    expect(rl.take("a", 0).allowed).toBe(false);
  });

  it("prune drops idle buckets", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    rl.take("old", 0);
    rl.prune(700_000); // > default idle
    // after prune, the key is fresh again (full capacity)
    expect(rl.take("old", 700_000).allowed).toBe(true);
  });
});

describe("CORS + security headers", () => {
  it("emits the configured origin and methods", () => {
    const h = corsHeaders({ allowOrigin: "https://app.example.com" });
    expect(h["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(h["access-control-allow-headers"]).toContain("x-telegram-init-data");
  });
  it("security headers deny framing and sniffing", () => {
    const h = securityHeaders();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});

describe("StructuredLogger — leveled, secret-safe JSON", () => {
  it("emits JSON lines at or above min level", () => {
    const lines: string[] = [];
    const log = new StructuredLogger((l) => lines.push(l), "info", () => 123);
    log.debug("skip me");     // below min
    log.info("hello", { a: 1 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ t: 123, level: "info", msg: "hello", a: 1 });
  });

  it("redacts secret-looking keys", () => {
    const lines: string[] = [];
    const log = new StructuredLogger((l) => lines.push(l), "info");
    log.info("auth", { apiKey: "SECRET", token: "T", initData: "x", safe: "ok" });
    const p = JSON.parse(lines[0]!);
    expect(p.apiKey).toBe("[redacted]");
    expect(p.token).toBe("[redacted]");
    expect(p.initData).toBe("[redacted]");
    expect(p.safe).toBe("ok");
    expect(lines[0]).not.toContain("SECRET");
  });

  it("error level always passes an info threshold", () => {
    const lines: string[] = [];
    const log = new StructuredLogger((l) => lines.push(l), "info");
    log.error("boom", {});
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).level).toBe("error");
  });
});
