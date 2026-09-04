import { describe, it, expect } from "vitest";

import { deriveSignalObservations } from "../../src/core/features/signalObservations.js";
import { advanceSignal } from "../../src/core/signal/signalLifecycle.js";
import type { FactorActivations } from "../../src/core/power/powerEngine.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const AT = 1000 as UnixMillis;

describe("4B-5.4 SignalObservation derivation", () => {
  it("support = the backing activation value; present = support > 0", () => {
    const acts: FactorActivations = { smartMoneyInflow: 0.6, rugRisk: 0.0 };
    const obs = deriveSignalObservations(acts, AT);
    const smart = obs.find((o) => o.identity === "smart_money_accumulation")!;
    expect(smart.support).toBe(0.6);
    expect(smart.present).toBe(true);
    const rug = obs.find((o) => o.identity === "rug_risk_elevated")!;
    expect(rug.support).toBe(0);
    expect(rug.present).toBe(false); // zero support -> not present
  });

  it("UNKNOWN activation (undefined) produces NO observation (not a false absence)", () => {
    const acts: FactorActivations = { smartMoneyInflow: 0.5 }; // rugRisk absent
    const obs = deriveSignalObservations(acts, AT);
    expect(obs.some((o) => o.identity === "smart_money_accumulation")).toBe(true);
    expect(obs.some((o) => o.identity === "rug_risk_elevated")).toBe(false);
  });

  it("washTrading boolean->{0,1} maps to present/absent", () => {
    expect(deriveSignalObservations({ washTrading: 1 }, AT)[0]!.present).toBe(true);
    expect(deriveSignalObservations({ washTrading: 0 }, AT)[0]!.present).toBe(false);
  });

  it("only catalog signals are emitted (no invented signals)", () => {
    const acts: FactorActivations = { smartMoneyInflow: 0.5, sellPressure: 0.9, vectorConflict: 0.8 };
    const obs = deriveSignalObservations(acts, AT);
    const ids = obs.map((o) => o.identity);
    expect(ids).toContain("smart_money_accumulation");
    expect(ids).not.toContain("sellPressure");
    expect(ids).not.toContain("vectorConflict");
  });

  it("feeds advanceSignal: first sighting with support>=0.7 -> EMERGING then CONFIRMED", () => {
    const [obs] = deriveSignalObservations({ smartMoneyInflow: 0.8 }, AT);
    const first = advanceSignal(null, obs!);
    expect(first.phase).toBe("EMERGING"); // first sighting is always EMERGING
    const second = advanceSignal(first, { ...obs!, at: 2000 as UnixMillis });
    expect(second.phase).toBe("CONFIRMED"); // support 0.8 >= confirmSupport 0.7
  });

  it("support is clamped into [0,1]", () => {
    expect(deriveSignalObservations({ rugRisk: 1.5 }, AT)[0]!.support).toBe(1);
    expect(deriveSignalObservations({ rugRisk: -0.3 }, AT)[0]!.support).toBe(0);
  });
});
