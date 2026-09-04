import { describe, it, expectTypeOf } from "vitest";
import type { BattlefieldState, TokenBattlefieldEntry } from "../../src/index.js";

/**
 * Phase 2 has no runtime logic — these are compile-time proofs that the frozen
 * V3.2 contract composes. If the types stop assembling, this file fails to
 * typecheck and `npm run typecheck` breaks the build.
 */
describe("domain type composition", () => {
  it("BattlefieldState exposes the required top-level shape", () => {
    expectTypeOf<BattlefieldState>().toHaveProperty("generatedAt");
    expectTypeOf<BattlefieldState>().toHaveProperty("modelVersions");
    expectTypeOf<BattlefieldState>().toHaveProperty("marketRegime");
    expectTypeOf<BattlefieldState>().toHaveProperty("tokens");
    expectTypeOf<BattlefieldState>().toHaveProperty("rankings");
  });

  it("a token entry carries Power, Threat and Confidence as separate members", () => {
    expectTypeOf<TokenBattlefieldEntry>().toHaveProperty("power");
    expectTypeOf<TokenBattlefieldEntry>().toHaveProperty("threat");
    expectTypeOf<TokenBattlefieldEntry>().toHaveProperty("confidence");
    // Independence is structural: three distinct members, not one fused score.
    expectTypeOf<TokenBattlefieldEntry["power"]>().not.toEqualTypeOf<
      TokenBattlefieldEntry["threat"]
    >();
  });
});
