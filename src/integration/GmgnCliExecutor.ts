/**
 * WAR integration — GmgnCliExecutor (live transport).
 *
 * The one missing piece for live GMGN: a real CliExecutor that spawns the
 * `gmgn-cli` binary as a subprocess. Everything downstream already exists —
 * RealGmgnAcquisitionPort, the parsers, and the sealed flow normalizer. This
 * executor only replaces the NETWORK: it runs the CLI and returns raw stdout,
 * exactly the CliExecutor contract the transport chain expects.
 *
 * Discipline preserved:
 *  - It computes NO intelligence and interprets NO field — it just runs a process.
 *  - The API key is read from the environment (GMGN_API_KEY); it is NEVER logged,
 *    echoed, or placed on the argv (which can leak via process listings).
 *  - `--raw` is appended so the CLI emits machine JSON, matching the parsers.
 *  - A timeout prevents a hung CLI from blocking a scan forever.
 *
 * Injectable: production wires this; tests keep using stub executors. This file
 * is the only place in the codebase that touches child_process.
 */

import { execFile } from "node:child_process";
import type { CliExecutor, CliRunResult } from "../adapters/gmgn/gmgnRunner.js";

export interface GmgnCliExecutorOptions {
  /** Binary name or absolute path. Default: "gmgn-cli" (must be on PATH). */
  readonly binary?: string;
  /** Per-call timeout in milliseconds. Default: 20_000. */
  readonly timeoutMs?: number;
  /**
   * API key. If omitted, the current process.env.GMGN_API_KEY is used at call
   * time. Passed to the child via env only — never via argv, never logged.
   */
  readonly apiKey?: string;
  /** Append `--raw` so the CLI emits machine-readable JSON. Default: true. */
  readonly appendRaw?: boolean;
  /** Max stdout buffer in bytes. Default: 10MB (trending/kline can be large). */
  readonly maxBufferBytes?: number;
}

export class GmgnCliExecutor implements CliExecutor {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly appendRaw: boolean;
  private readonly maxBufferBytes: number;

  constructor(opts: GmgnCliExecutorOptions = {}) {
    this.binary = opts.binary ?? "gmgn-cli";
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.apiKey = opts.apiKey;
    this.appendRaw = opts.appendRaw ?? true;
    this.maxBufferBytes = opts.maxBufferBytes ?? 10 * 1024 * 1024;
  }

  run(argv: readonly string[]): Promise<CliRunResult> {
    // Append --raw once (idempotent) so the CLI returns JSON.
    const args = this.appendRaw && !argv.includes("--raw") ? [...argv, "--raw"] : [...argv];

    // Resolve the key at call time so a late-loaded .env still works.
    const key = this.apiKey ?? process.env["GMGN_API_KEY"];

    // Child env: inherit, but ensure the key is present. The key never touches
    // argv or logs — only the child's environment.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (key) env["GMGN_API_KEY"] = key;

    // On Windows, `gmgn-cli` is installed as a `.cmd`/`.ps1` shim, not a native
    // executable. execFile does not resolve shims unless run through a shell, so
    // it returns ENOENT even though the CLI works from a shell. Enabling `shell`
    // on Windows lets the shim resolve. On POSIX the binary is a real file and
    // no shell is needed (safer — no shell-quoting surface).
    const useShell = process.platform === "win32";

    return new Promise<CliRunResult>((resolve) => {
      execFile(
        this.binary,
        args,
        { timeout: this.timeoutMs, maxBuffer: this.maxBufferBytes, env, windowsHide: true, shell: useShell },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code === "string") {
            // Spawn-level failure (e.g. ENOENT: binary not found). Surface as a
            // non-zero exit so runGmgnJson classifies it, without throwing.
            resolve({
              exitCode: 127,
              stdout: "",
              stderr: `spawn failed: ${(error as { code: string }).code} (is '${this.binary}' installed and on PATH?)`,
            });
            return;
          }
          const exitCode =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({
            exitCode,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    });
  }
}

/**
 * Self-verification helper (not part of the port). Runs a tiny trending query
 * and reports whether the live CLI is reachable and returning JSON. Intended to
 * be called from a one-off script on the user's machine to flip
 * GMGN_LIVE_VERIFIED honestly — it makes a real call, so it is NOT run in the
 * deterministic test suite.
 */
export async function verifyLiveCli(
  exec: CliExecutor,
): Promise<{ ok: true; sampleBytes: number } | { ok: false; reason: string }> {
  const res = await exec.run(["market", "trending", "--chain", "sol", "--interval", "1h", "--limit", "1"]);
  if (res.exitCode !== 0) return { ok: false, reason: res.stderr.trim() || `exit ${res.exitCode}` };
  const body = res.stdout.trim();
  if (body.length === 0) return { ok: false, reason: "empty stdout" };
  try {
    JSON.parse(body);
  } catch {
    return { ok: false, reason: "stdout is not valid JSON" };
  }
  return { ok: true, sampleBytes: body.length };
}
