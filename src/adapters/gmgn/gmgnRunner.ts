/**
 * WAR adapter - GMGN CLI runner (Phase 16).
 *
 * A thin, INJECTABLE wrapper over `gmgn-cli`. The actual command executor is
 * passed in, so this module is fully testable without a network or the CLI
 * installed. The core never imports this - it lives at the adapter boundary.
 *
 * Rate limits (sealed at 147c070): leaky bucket rate=20 cap=20 for market/track/
 * portfolio; weights per route. On 429, honor X-RateLimit-Reset / reset_at.
 */

import type { Chain } from "../../shared/scalars.js";

/** Error taxonomy - callers distinguish these explicitly (never collapse to 0). */
export type GmgnErrorKind =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "MALFORMED_FIELD"
  | "MISSING_FIELD"
  | "CHAIN_ERROR"
  | "FORMAT_ERROR"
  | "CLI_MISSING"
  | "NETWORK_ERROR";

export interface GmgnError {
  readonly ok: false;
  readonly kind: GmgnErrorKind;
  readonly message: string;
  /** For RATE_LIMIT: when the bucket resets (unix seconds), if known. */
  readonly resetAt?: number;
}

export interface GmgnSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export type GmgnResult<T> = GmgnSuccess<T> | GmgnError;

/** The injected executor: runs argv, returns stdout or throws a typed-ish error. */
export interface CliExecutor {
  run(argv: readonly string[]): Promise<CliRunResult>;
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Optional response headers surfaced by the CLI (e.g. X-RateLimit-Reset). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Weights per route group (sealed). Used for local rate accounting. */
export const ROUTE_WEIGHTS: Readonly<Record<string, number>> = {
  kline: 2,
  trending: 1,
  trenches: 3,
  signal: 3,
  "hot-searches": 3,
  search: 1,
  "follow-wallet": 3,
  kol: 1,
  smartmoney: 1,
  "token-holders": 5,
  "token-traders": 5,
};

export const RATE_LIMIT = { rate: 20, capacity: 20 } as const;

function classifyError(res: CliRunResult): GmgnError {
  const text = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (res.exitCode === 0) {
    return { ok: false, kind: "FORMAT_ERROR", message: "empty/unparseable output" };
  }
  if (text.includes("command not found") || text.includes("not recognized")) {
    return { ok: false, kind: "CLI_MISSING", message: "gmgn-cli not installed" };
  }
  if (text.includes("401") || text.includes("403") || text.includes("auth")) {
    return { ok: false, kind: "AUTH_ERROR", message: "authentication failed" };
  }
  if (text.includes("429") || text.includes("rate limit")) {
    const resetAt = parseResetAt(res.headers);
    return resetAt === null
      ? { ok: false, kind: "RATE_LIMIT", message: "rate limited" }
      : { ok: false, kind: "RATE_LIMIT", message: "rate limited", resetAt };
  }
  if (text.includes("chain")) {
    return { ok: false, kind: "CHAIN_ERROR", message: "chain error" };
  }
  return { ok: false, kind: "NETWORK_ERROR", message: res.stderr || "unknown error" };
}

function parseResetAt(headers?: Readonly<Record<string, string>>): number | null {
  if (headers === undefined) return null;
  const raw = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Run a gmgn-cli command and parse JSON stdout. Deterministic given the injected
 * executor. Returns a typed result - errors are classified, never thrown to the
 * core, never coerced to zero.
 */
export async function runGmgnJson<T>(
  exec: CliExecutor,
  argv: readonly string[],
): Promise<GmgnResult<T>> {
  let res: CliRunResult;
  try {
    res = await exec.run(argv);
  } catch (e) {
    return {
      ok: false,
      kind: "NETWORK_ERROR",
      message: e instanceof Error ? e.message : "executor threw",
    };
  }

  if (res.exitCode !== 0) return classifyError(res);

  const trimmed = res.stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, kind: "FORMAT_ERROR", message: "empty stdout" };
  }

  try {
    const data = JSON.parse(trimmed) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, kind: "FORMAT_ERROR", message: "invalid JSON" };
  }
}

/** Build argv for `gmgn-cli market kline`. */
export function klineArgv(chain: Chain, address: string, resolution: string): string[] {
  return ["market", "kline", "--chain", chain, "--address", address, "--resolution", resolution];
}

/** Build argv for `gmgn-cli market trending`. */
export function trendingArgv(chain: Chain, interval: string): string[] {
  return ["market", "trending", "--chain", chain, "--interval", interval];
}

/** Build argv for `gmgn-cli track <sub>`. */
export function trackArgv(sub: "kol" | "smartmoney" | "follow-wallet", chain: Chain): string[] {
  return ["track", sub, "--chain", chain];
}
