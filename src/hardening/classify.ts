/**
 * WAR hardening - result classification (Phase 7).
 *
 * Maps a raw CliRunResult to a hardening-facing classification used by the
 * resilient executor's retry/breaker logic. It mirrors the adapter's error
 * taxonomy (GmgnErrorKind) WITHOUT modifying the adapter. The resilient wrapper's
 * own TIMEOUT marker is mapped to NETWORK_ERROR (a retryable transport failure),
 * so no new error kind is introduced into the sealed adapter enum.
 */

import type { CliRunResult, GmgnErrorKind } from "../adapters/gmgn/gmgnRunner.js";

export type Classification =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: GmgnErrorKind; readonly resetAtMs: number | null };

function parseResetAtMs(headers?: Readonly<Record<string, string>>): number | null {
  if (headers === undefined) return null;
  const raw = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Reset is unix seconds in the sealed contract; convert to ms.
  return n * 1000;
}

/**
 * Classify a CliRunResult. exitCode 0 with output is success. Otherwise the text
 * is matched against the same signals the adapter uses. The wrapper's TIMEOUT
 * marker becomes NETWORK_ERROR (retryable transport).
 */
export function classifyRunResult(res: CliRunResult): Classification {
  if (res.exitCode === 0 && res.stdout.trim().length > 0) {
    return { ok: true };
  }
  const text = `${res.stderr} ${res.stdout}`.toLowerCase();

  if (text.includes("timeout")) {
    return { ok: false, kind: "NETWORK_ERROR", resetAtMs: null };
  }
  if (text.includes("kill_switch") || text.includes("circuit_open")) {
    // These are our own gate refusals; treat as non-retryable network-class stop.
    return { ok: false, kind: "NETWORK_ERROR", resetAtMs: null };
  }
  if (text.includes("command not found") || text.includes("not recognized")) {
    return { ok: false, kind: "CLI_MISSING", resetAtMs: null };
  }
  if (text.includes("401") || text.includes("403") || text.includes("auth")) {
    return { ok: false, kind: "AUTH_ERROR", resetAtMs: null };
  }
  if (text.includes("429") || text.includes("rate limit")) {
    return { ok: false, kind: "RATE_LIMIT", resetAtMs: parseResetAtMs(res.headers) };
  }
  if (res.exitCode === 0) {
    // exit 0 but empty output
    return { ok: false, kind: "FORMAT_ERROR", resetAtMs: null };
  }
  return { ok: false, kind: "NETWORK_ERROR", resetAtMs: null };
}
