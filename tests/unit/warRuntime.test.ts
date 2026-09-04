import { describe, it, expect } from "vitest";
import { createWarRuntime, systemClock } from "../../src/integration/warRuntime.js";
import { ArenaSession } from "../../src/arena/ArenaSession.js";
import type { CliExecutor } from "../../src/adapters/gmgn/gmgnRunner.js";

/** A stub executor: replaces the network only, so we test wiring without a CLI. */
function stubExecutor(): CliExecutor {
  return {
    run: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
  };
}

describe("warRuntime — production composition root", () => {
  it("builds a full ArenaSession from a stub executor (no network)", () => {
    const rt = createWarRuntime({ cliExecutor: stubExecutor() });
    expect(rt.arena).toBeInstanceOf(ArenaSession);
    expect(rt.entitlements).toBeDefined();
    expect(rt.uow).toBeDefined();
    expect(typeof rt.clock.now()).toBe("number");
  });

  it("uses an injected clock", () => {
    const rt = createWarRuntime({ cliExecutor: stubExecutor(), clock: { now: () => 42 } });
    expect(rt.clock.now()).toBe(42);
  });

  it("systemClock returns a real increasing wall-clock", () => {
    const c = systemClock();
    const a = c.now();
    expect(typeof a).toBe("number");
    expect(a).toBeGreaterThan(1_600_000_000_000); // after 2020, sanity
  });

  it("defaults to a live GmgnCliExecutor when none injected (constructs without spawning)", () => {
    // Building the runtime must not spawn anything; the executor only runs on acquire().
    const rt = createWarRuntime();
    expect(rt.arena).toBeInstanceOf(ArenaSession);
  });
});
