/**
 * WAR API — security & observability primitives.
 *
 * Pure, injectable building blocks the HTTP layer composes:
 *   - RateLimiter: per-key token bucket (refills over time), for per-IP/user caps
 *   - corsHeaders / securityHeaders: standard hardening headers
 *   - StructuredLogger: JSON log lines with levels + request ids (no secrets)
 *
 * All deterministic over an injected clock; no sockets, no intelligence. The
 * httpServer wires these; tests drive them directly.
 */

// ---------------------------------------------------------------------------
// Rate limiter — token bucket per key.
// ---------------------------------------------------------------------------
export interface RateLimitConfig {
  /** Bucket capacity (max burst). */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly cfg: RateLimitConfig) {}

  /**
   * Try to spend one token for `key` at time `nowMs`. Returns allowed + how many
   * tokens remain and (when blocked) how many ms until the next token.
   */
  take(key: string, nowMs: number): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const b = this.buckets.get(key) ?? { tokens: this.cfg.capacity, lastRefillMs: nowMs };
    // Refill based on elapsed time.
    const elapsedS = Math.max(0, (nowMs - b.lastRefillMs) / 1000);
    b.tokens = Math.min(this.cfg.capacity, b.tokens + elapsedS * this.cfg.refillPerSecond);
    b.lastRefillMs = nowMs;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    this.buckets.set(key, b);
    const needed = 1 - b.tokens;
    const retryAfterMs = Math.ceil((needed / this.cfg.refillPerSecond) * 1000);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  /** Drop stale buckets to bound memory (call periodically). */
  prune(nowMs: number, idleMs = 600_000): void {
    for (const [k, b] of this.buckets) if (nowMs - b.lastRefillMs > idleMs) this.buckets.delete(k);
  }
}

// ---------------------------------------------------------------------------
// CORS + security headers.
// ---------------------------------------------------------------------------
export interface CorsConfig {
  /** Allowed origin. Use the Mini App origin in production; "*" only for dev. */
  readonly allowOrigin: string;
  readonly allowMethods?: string;
  readonly allowHeaders?: string;
}

export function corsHeaders(cfg: CorsConfig): Record<string, string> {
  return {
    "access-control-allow-origin": cfg.allowOrigin,
    "access-control-allow-methods": cfg.allowMethods ?? "GET,POST,OPTIONS",
    "access-control-allow-headers": cfg.allowHeaders ?? "content-type,x-telegram-init-data",
    "access-control-max-age": "600",
  };
}

/** Conservative security headers for a JSON API. */
export function securityHeaders(): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };
}

// ---------------------------------------------------------------------------
// Structured logger — JSON lines, leveled, secret-safe.
// ---------------------------------------------------------------------------
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A sink is where lines go (console in prod, an array in tests). */
export type LogSink = (line: string) => void;

const SECRET_KEYS = /(api[_-]?key|token|secret|authorization|private[_-]?key|initdata)/i;

function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
  return out;
}

export class StructuredLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel = "info",
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  private emit(level: LogLevel, msg: string, meta: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = JSON.stringify({ t: this.nowMs(), level, msg, ...redact(meta) });
    this.sink(line);
  }
  debug(msg: string, meta: Record<string, unknown> = {}): void { this.emit("debug", msg, meta); }
  info(msg: string, meta: Record<string, unknown> = {}): void { this.emit("info", msg, meta); }
  warn(msg: string, meta: Record<string, unknown> = {}): void { this.emit("warn", msg, meta); }
  error(msg: string, meta: Record<string, unknown> = {}): void { this.emit("error", msg, meta); }
}

/** Generate a short request id for correlating logs. */
export function requestId(seed: number): string {
  return `req_${seed.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
