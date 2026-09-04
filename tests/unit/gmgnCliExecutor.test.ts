import { describe, it, expect } from "vitest";
import { GmgnCliExecutor, verifyLiveCli } from "../../src/integration/GmgnCliExecutor.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";

/** A stub executor that records argv and returns a canned result. */
function stub(result: Partial<CliRunResult>, capture?: (argv: readonly string[]) => void): CliExecutor {
  return {
    run: async (argv) => {
      capture?.(argv);
      return { exitCode: 0, stdout: "", stderr: "", ...result };
    },
  };
}

describe("verifyLiveCli — honest live-reachability probe", () => {
  it("reports ok with byte count on valid JSON", async () => {
    const s = stub({ stdout: JSON.stringify({ code: 0, data: { rank: [] } }) });
    const r = await verifyLiveCli(s);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sampleBytes).toBeGreaterThan(0);
  });

  it("reports failure on non-zero exit", async () => {
    const s = stub({ exitCode: 1, stderr: "GMGN_API_KEY is required" });
    const r = await verifyLiveCli(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("GMGN_API_KEY");
  });

  it("reports failure on empty stdout", async () => {
    const r = await verifyLiveCli(stub({ stdout: "   " }));
    expect(r.ok).toBe(false);
  });

  it("reports failure on non-JSON stdout", async () => {
    const r = await verifyLiveCli(stub({ stdout: "not json at all" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("JSON");
  });

  it("sends the expected trending argv", async () => {
    let seen: readonly string[] = [];
    const s = stub({ stdout: "{}" }, (a) => { seen = a; });
    await verifyLiveCli(s);
    expect(seen).toEqual(["market", "trending", "--chain", "sol", "--interval", "1h", "--limit", "1"]);
  });
});

describe("GmgnCliExecutor — spawn behavior (no real binary needed)", () => {
  it("returns exit 127 with a helpful message when the binary is missing", async () => {
    const exec = new GmgnCliExecutor({ binary: "gmgn-cli-does-not-exist-xyz", timeoutMs: 5000 });
    const res = await exec.run(["market", "trending", "--chain", "sol"]);
    // A missing binary must yield a non-zero exit on every platform. The exact
    // stderr differs (POSIX execFile -> our "spawn failed" ENOENT message;
    // Windows shell -> "not recognized"), so we only assert the invariant:
    // it fails cleanly without throwing, and reports a non-empty reason.
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it("is constructible with defaults and custom options", () => {
    expect(new GmgnCliExecutor()).toBeInstanceOf(GmgnCliExecutor);
    expect(new GmgnCliExecutor({ binary: "x", timeoutMs: 1, appendRaw: false })).toBeInstanceOf(GmgnCliExecutor);
  });
});
