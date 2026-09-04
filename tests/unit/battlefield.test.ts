import { describe, it, expect } from "vitest";
import { assembleBattlefield } from "../../src/core/battlefield/assembleBattlefield.js";
import type {
  TokenAssemblyInput,
  AssemblyInput,
} from "../../src/core/battlefield/assembleBattlefield.js";
import { computePower, computeThreat, computeConfidence } from "../../src/core/power/powerEngine.js";
import { computeAttention } from "../../src/core/attention/attention.js";
import { computeNovelty } from "../../src/core/novelty/novelty.js";
import { computeCoherence } from "../../src/core/coherence/coherence.js";
import { computeLeadLag } from "../../src/core/coherence/coherence.js";
import { classifyTrajectory } from "../../src/core/trajectory/trajectory.js";
import { computeTemporalProfile } from "../../src/core/temporal/temporalEngine.js";
import type {
  Chain,
  TokenAddress,
  UnixMillis,
} from "../../src/shared/scalars.js";
import type { QualityStamp } from "../../src/shared/quality.js";

const NOW = 1_700_000_600_000 as UnixMillis;
const CHAIN: Chain = "sol";

const quality: QualityStamp = {
  quality: "COMPLETE",
  assessedAt: NOW,
  reasons: ["full data"],
};

/** Build a token entry by running real engines end-to-end. */
function realToken(
  address: string,
  priceSeries: [number, number][],
  attentionNovelty: number,
): TokenAssemblyInput {
  const prof = computeTemporalProfile(
    priceSeries.map(([at, v]) => ({ at: at as UnixMillis, value: v })),
  );
  const trajectory = classifyTrajectory(prof);
  const coherence = computeCoherence([
    { name: "price", direction: prof.direction },
    { name: "flow", direction: prof.direction },
  ]);
  const leadLag = computeLeadLag(
    [{ at: 0, sign: 1 }, { at: 1000, sign: 1 }, { at: 2000, sign: 1 }],
    [{ at: 300, sign: 1 }, { at: 1300, sign: 1 }, { at: 2300, sign: 1 }],
  );
  const power = computePower(
    { trajectoryUp: 1, coherenceAlignment: 1, smartMoneyInflow: 0.8, liquidityDepth: 0.7 },
    coherence.netCoherence as number,
  );
  const threat = computeThreat({ rugRisk: 0.2, holderConcentration: 0.3 });
  const confidence = computeConfidence({
    completeness: 1, freshness: 1, historyDepth: 0.8, coherence: coherence.netCoherence as number,
    measurementStability: 0.9, derivativeReliability: prof.derivativeConfidence as number,
    limitingCoverage: "ROLLING", limitingTemporalOrigin: "GMGN_EVENT",
  });
  const attention = computeAttention({
    magnitude: 0.5, acceleration: 0.6, novelty: attentionNovelty, stateTransition: 0.4,
    trajectoryReversal: 0, signalConflict: 0, uncertainty: 0.2, crossTokenImpact: 0,
  });
  const novelty = computeNovelty(`state=ATTACK|traj=${trajectory.classification}`, {});

  return {
    chain: CHAIN,
    address: address as TokenAddress,
    power, threat, confidence,
    state: "ATTACK",
    trajectory, coherence, leadLag, attention, novelty,
    signals: [], events: [], quality,
  };
}

function baseInput(): AssemblyInput {
  return {
    generatedAt: NOW,
    marketRegime: "RISK_ON",
    correlations: [
      { a: "ZZZ" as TokenAddress, b: "AAA" as TokenAddress, comovement: 50 as never },
    ],
    tokens: [
      realToken("TOKEN_B", [[0, 10], [1000, 20], [2000, 40]], 0.9), // high novelty/attn
      realToken("TOKEN_A", [[0, 5], [1000, 6], [2000, 7]], 0.2), // low attn
    ],
  };
}

describe("assembleBattlefield", () => {
  it("stamps model versions and generation time", () => {
    const bf = assembleBattlefield(baseInput());
    expect(bf.generatedAt).toBe(NOW);
    expect(bf.modelVersions.engineVersion).toContain("war-engine");
    expect(bf.marketRegime).toBe("RISK_ON");
  });

  it("orders tokens deterministically by address", () => {
    const bf = assembleBattlefield(baseInput());
    const addrs = bf.tokens.map((t) => t.address as string);
    expect(addrs).toEqual([...addrs].sort());
  });

  it("ranks tokens by attention (highest first)", () => {
    const bf = assembleBattlefield(baseInput());
    // TOKEN_B has higher attention inputs than TOKEN_A
    expect(bf.rankings[0]).toBe("TOKEN_B");
  });

  it("global attention equals the peak token attention", () => {
    const bf = assembleBattlefield(baseInput());
    const peak = Math.max(...bf.tokens.map((t) => t.attention.score as number));
    expect(bf.globalAttention as number).toBe(peak);
  });

  it("keeps Power, Threat and Confidence as separate members per token", () => {
    const bf = assembleBattlefield(baseInput());
    const t = bf.tokens[0];
    expect(t?.power).toBeDefined();
    expect(t?.threat).toBeDefined();
    expect(t?.confidence).toBeDefined();
  });

  it("sorts correlations deterministically by endpoints", () => {
    const bf = assembleBattlefield(baseInput());
    const c = bf.correlations[0];
    expect(c?.a).toBe("ZZZ"); // as provided; single edge stays
  });

  it("is deterministic and order-independent across the whole core", () => {
    const forward = baseInput();
    const reversed: AssemblyInput = {
      ...forward,
      tokens: [...forward.tokens].reverse(),
    };
    const a = assembleBattlefield(forward);
    const b = assembleBattlefield(reversed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces a valid empty battlefield when there are no tokens", () => {
    const bf = assembleBattlefield({
      generatedAt: NOW,
      marketRegime: "QUIET",
      tokens: [],
      correlations: [],
    });
    expect(bf.tokens.length).toBe(0);
    expect(bf.rankings.length).toBe(0);
    expect(bf.globalAttention as number).toBe(0);
  });
});
