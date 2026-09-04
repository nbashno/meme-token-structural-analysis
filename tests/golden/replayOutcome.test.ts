import { describe, it, expect } from "vitest";
import { replay, framesRespectAntiLookahead } from "../../src/replay/replay.js";
import type { TimedObservation, BattlefieldStepper } from "../../src/replay/replay.js";
import {
  evaluateOutcome,
} from "../../src/outcome/outcomeEvaluator.js";
import type { DecisionRecord, FuturePrice } from "../../src/outcome/outcomeEvaluator.js";
import { assembleBattlefield } from "../../src/core/battlefield/assembleBattlefield.js";
import type { BattlefieldState } from "../../src/core/battlefield/types.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

const at = (ms: number) => ms as UnixMillis;

interface Obs extends TimedObservation {
  readonly value: number;
}

/** A trivial deterministic stepper: builds an empty-token battlefield stamped at `now`. */
const stepper: BattlefieldStepper<Obs> = (visible, now): BattlefieldState => {
  // The peak value influences nothing here except proving `visible` is windowed.
  return assembleBattlefield({
    generatedAt: now,
    marketRegime: visible.length > 3 ? "RISK_ON" : "QUIET",
    tokens: [],
    correlations: [],
  });
};

const OBS: Obs[] = [
  { at: at(1000), value: 1 },
  { at: at(2000), value: 2 },
  { at: at(3000), value: 3 },
  { at: at(4000), value: 4 },
  { at: at(5000), value: 5 },
];

describe("replay - anti-lookahead", () => {
  it("produces one frame per distinct timestamp", () => {
    const frames = replay(OBS, stepper);
    expect(frames.length).toBe(5);
  });

  it("each frame is generated at its own timestamp (no future leakage)", () => {
    const frames = replay(OBS, stepper);
    for (const f of frames) {
      expect(f.state.generatedAt as number).toBe(f.at as number);
    }
    expect(framesRespectAntiLookahead(frames)).toBe(true);
  });

  it("early frames cannot see later observations (regime flips only once enough are visible)", () => {
    const frames = replay(OBS, stepper);
    // QUIET while <=3 visible, RISK_ON once >3 visible
    expect(frames[0]?.state.marketRegime).toBe("QUIET");
    expect(frames[4]?.state.marketRegime).toBe("RISK_ON");
  });

  it("is deterministic and order-independent in input", () => {
    const a = replay(OBS, stepper);
    const b = replay([...OBS].reverse(), stepper);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("GOLDEN: replay reconstruction is byte-identical across runs", () => {
    const a = JSON.stringify(replay(OBS, stepper));
    const b = JSON.stringify(replay(OBS, stepper));
    expect(a).toBe(b);
    expect(replay(OBS, stepper)).toMatchSnapshot();
  });
});

describe("evaluateOutcome - temporal firewall + verdicts", () => {
  const decision: DecisionRecord = {
    id: "d1",
    at: at(1000),
    direction: "UP",
    referencePrice: 100,
    sealed: true,
  };

  const fut = (ms: number, price: number): FuturePrice => ({ at: at(ms), price });

  it("ignores prices at or before the decision (firewall)", () => {
    const out = evaluateOutcome(decision, [
      fut(500, 999), // before decision - must be ignored
      fut(1000, 999), // at decision - must be ignored
      fut(2000, 110), // after - counts
    ]);
    // if the 999s had leaked, mfe would be enormous; it should reflect only 110
    expect(out.mfe).toBeCloseTo(0.1, 6);
  });

  it("CONFIRMED when price moves past threshold in the flagged direction", () => {
    const out = evaluateOutcome(decision, [fut(2000, 106)]);
    expect(out.verdict).toBe("CONFIRMED");
    expect(out.actualDirection).toBe("UP");
  });

  it("REJECTED when price moves against the flagged direction past threshold", () => {
    const out = evaluateOutcome(decision, [fut(2000, 90)]);
    expect(out.verdict).toBe("REJECTED");
  });

  it("INCONCLUSIVE for small moves", () => {
    const out = evaluateOutcome(decision, [fut(2000, 101)]);
    expect(out.verdict).toBe("INCONCLUSIVE");
  });

  it("NO_FUTURE_DATA when nothing follows the decision", () => {
    const out = evaluateOutcome(decision, [fut(500, 200)]);
    expect(out.verdict).toBe("NO_FUTURE_DATA");
  });

  it("records time-to-outcome at the first threshold cross", () => {
    const out = evaluateOutcome(decision, [
      fut(2000, 102),
      fut(3000, 106), // crosses +5% here
    ]);
    expect(out.timeToOutcome).toBe(2000); // 3000 - 1000
  });

  it("tracks MFE and MAE", () => {
    const out = evaluateOutcome(decision, [
      fut(2000, 108), // +8% favorable
      fut(3000, 94), // -6% adverse
    ]);
    expect(out.mfe).toBeCloseTo(0.08, 6);
    expect(out.mae).toBeCloseTo(0.06, 6);
  });

  it("is deterministic", () => {
    const prices = [fut(2000, 108), fut(3000, 94)];
    expect(JSON.stringify(evaluateOutcome(decision, prices))).toBe(
      JSON.stringify(evaluateOutcome(decision, prices)),
    );
  });
});
