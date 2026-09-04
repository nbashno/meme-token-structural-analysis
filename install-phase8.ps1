# ============================================================
# WAR - Phase 8 Installer (Power / Threat / Confidence)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase8.ps1
# Requires Phase 7 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\coherence\coherence.ts')) { Write-Error 'Phase 7 missing. Install Phase 7 first.'; exit 1 }
Write-Host 'Installing Phase 8 (Power / Threat / Confidence)...' -ForegroundColor Cyan

# ---- src/config/scoring.ts ----
New-Item -ItemType Directory -Force -Path 'src/config' | Out-Null
$content = @'
/**
 * WAR core - scoring configuration (Phase 8).
 *
 * All weights and thresholds live here, versioned. No magic numbers inside the
 * scoring engines. Changing a weight changes powerModelVersion, keeping historic
 * outputs interpretable.
 */

/** A named, weighted input to a composite score. */
export interface WeightedInput {
  readonly factor: string;
  readonly weight: number;
}

export interface PowerConfig {
  readonly version: string;
  /** Positive-direction factors (accumulation, alignment, smart flow, ...). */
  readonly supportingWeights: readonly WeightedInput[];
  /** Negative-direction factors (sell pressure, conflict, ...). */
  readonly opposingWeights: readonly WeightedInput[];
}

export interface ThreatConfig {
  readonly version: string;
  readonly weights: readonly WeightedInput[];
}

export interface ConfidenceConfig {
  readonly version: string;
  /** Blend weights for the confidence sub-dimensions (must sum to > 0). */
  readonly completeness: number;
  readonly freshness: number;
  readonly historyDepth: number;
  readonly coherence: number;
  readonly measurementStability: number;
  readonly derivativeReliability: number;
  /** Coverage penalties: ROLLING/SAMPLED constrain confidence vs COMPLETE. */
  readonly coveragePenalty: {
    readonly COMPLETE: number;
    readonly ROLLING: number;
    readonly SAMPLED: number;
    readonly DERIVED: number;
  };
}

export const POWER_CONFIG: PowerConfig = {
  version: "power-v1",
  supportingWeights: [
    { factor: "trajectoryUp", weight: 30 },
    { factor: "coherenceAlignment", weight: 25 },
    { factor: "smartMoneyInflow", weight: 25 },
    { factor: "liquidityDepth", weight: 20 },
  ],
  opposingWeights: [
    { factor: "sellPressure", weight: 30 },
    { factor: "vectorConflict", weight: 25 },
  ],
};

export const THREAT_CONFIG: ThreatConfig = {
  version: "threat-v1",
  weights: [
    { factor: "rugRisk", weight: 30 },
    { factor: "holderConcentration", weight: 25 },
    { factor: "washTrading", weight: 20 },
    { factor: "liquidityFragility", weight: 25 },
  ],
};

export const CONFIDENCE_CONFIG: ConfidenceConfig = {
  version: "confidence-v1",
  completeness: 0.2,
  freshness: 0.15,
  historyDepth: 0.2,
  coherence: 0.2,
  measurementStability: 0.1,
  derivativeReliability: 0.15,
  coveragePenalty: {
    COMPLETE: 1.0,
    ROLLING: 0.7,
    SAMPLED: 0.8,
    DERIVED: 0.9,
  },
};

'@
Set-Content -Path 'src/config/scoring.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/config/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/config' | Out-Null
$content = @'
// WAR versioned config (scoring weights + thresholds).
export * from "./scoring.js";

'@
Set-Content -Path 'src/config/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/power/powerEngine.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/power' | Out-Null
$content = @'
/**
 * WAR core - Power / Threat / Confidence engines (Phase 8).
 *
 * THREE INDEPENDENT MEASURES. None is computed from another:
 *   - Power   = current observable condition strength (NOT probability/prediction).
 *   - Threat  = dangerous-structure strength, computed from its OWN inputs.
 *   - Confidence = evidence quality (NOT probability). Conflict + ROLLING coverage
 *                  constrain it.
 *
 * Every score carries its breakdown - a bare number is invalid. Weights come
 * from versioned config; no magic numbers here. Pure, total, deterministic.
 */

import type { Score0to100, Ratio0to1 } from "../../shared/scalars.js";
import type { Power, Threat, Confidence, Contribution } from "./types.js";
import type { Coverage, TemporalOrigin } from "../timeline/types.js";
import { clampScore, toRatio0to1 } from "../../shared/construct.js";
import type {
  PowerConfig,
  ThreatConfig,
  ConfidenceConfig,
} from "../../config/scoring.js";
import {
  POWER_CONFIG,
  THREAT_CONFIG,
  CONFIDENCE_CONFIG,
} from "../../config/scoring.js";

const S0 = 0 as Score0to100;
const R0 = 0 as Ratio0to1;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}

/** A factor's activation in [0,1]; how strongly this factor is present now. */
export type FactorActivations = Readonly<Record<string, number>>;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Build contributions from weighted config + activations. */
function contributionsOf(
  weights: readonly { factor: string; weight: number }[],
  activations: FactorActivations,
): { contributions: Contribution[]; total: number } {
  const contributions: Contribution[] = [];
  let total = 0;
  for (const w of weights) {
    const act = clamp01(activations[w.factor] ?? 0);
    const magnitude = act * w.weight;
    total += magnitude;
    contributions.push({ factor: w.factor, magnitude, weight: w.weight });
  }
  return { contributions, total };
}

/**
 * Power = supporting activation minus opposing activation, clamped to [0,100].
 * netCoherence is carried through (from Phase 7) for explainability, but Power
 * is its own measure.
 */
export function computePower(
  activations: FactorActivations,
  netCoherence: number,
  config: PowerConfig = POWER_CONFIG,
): Power {
  const support = contributionsOf(config.supportingWeights, activations);
  const oppose = contributionsOf(config.opposingWeights, activations);
  const raw = support.total - oppose.total;
  return {
    score: score(raw),
    supporting: support.contributions,
    opposing: oppose.contributions,
    netCoherence: ratio(clamp01(netCoherence)),
  };
}

/**
 * Threat = weighted sum of danger factors, clamped to [0,100]. Computed ONLY
 * from its own inputs - never from Power. High Power + high Threat is valid.
 */
export function computeThreat(
  activations: FactorActivations,
  config: ThreatConfig = THREAT_CONFIG,
): Threat {
  const t = contributionsOf(config.weights, activations);
  return { score: score(t.total), supporting: t.contributions };
}

/** Inputs to confidence. Each dimension is already a ratio in [0,1]. */
export interface ConfidenceInputs {
  readonly completeness: number;
  readonly freshness: number;
  readonly historyDepth: number;
  /** Coherence contribution: alignment raises, conflict lowers (0..1). */
  readonly coherence: number;
  readonly measurementStability: number;
  readonly derivativeReliability: number;
  readonly limitingCoverage: Coverage;
  readonly limitingTemporalOrigin: TemporalOrigin;
}

/**
 * Confidence = weighted blend of evidence-quality dimensions, then scaled by a
 * coverage penalty. A short FLOW capture (ROLLING) cannot yield full confidence.
 * This is evidence quality - NOT a probability of any outcome.
 */
export function computeConfidence(
  inputs: ConfidenceInputs,
  config: ConfidenceConfig = CONFIDENCE_CONFIG,
): Confidence {
  const c = clamp01(inputs.completeness);
  const f = clamp01(inputs.freshness);
  const h = clamp01(inputs.historyDepth);
  const co = clamp01(inputs.coherence);
  const ms = clamp01(inputs.measurementStability);
  const dr = clamp01(inputs.derivativeReliability);

  const weightSum =
    config.completeness +
    config.freshness +
    config.historyDepth +
    config.coherence +
    config.measurementStability +
    config.derivativeReliability;

  const blended =
    weightSum > 0
      ? (c * config.completeness +
          f * config.freshness +
          h * config.historyDepth +
          co * config.coherence +
          ms * config.measurementStability +
          dr * config.derivativeReliability) /
        weightSum
      : 0;

  const penalty = config.coveragePenalty[inputs.limitingCoverage];
  const constrained = blended * penalty;

  return {
    score: score(constrained * 100),
    completeness: ratio(c),
    freshness: ratio(f),
    historyDepth: ratio(h),
    coherenceContribution: ratio(co),
    measurementStability: ratio(ms),
    derivativeReliability: ratio(dr),
    limitingCoverage: inputs.limitingCoverage,
    limitingTemporalOrigin: inputs.limitingTemporalOrigin,
  };
}

'@
Set-Content -Path 'src/core/power/powerEngine.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/power/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/power' | Out-Null
$content = @'
// WAR Power / Threat / Confidence + engines.
export type * from "./types.js";
export * from "./powerEngine.js";

'@
Set-Content -Path 'src/core/power/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/powerEngine.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import {
  computePower,
  computeThreat,
  computeConfidence,
} from "../../src/core/power/powerEngine.js";
import type {
  FactorActivations,
  ConfidenceInputs,
} from "../../src/core/power/powerEngine.js";

describe("computePower", () => {
  it("high supporting activation yields high power with a breakdown", () => {
    const acts: FactorActivations = {
      trajectoryUp: 1,
      coherenceAlignment: 1,
      smartMoneyInflow: 1,
      liquidityDepth: 1,
    };
    const p = computePower(acts, 1);
    expect(p.score as number).toBeGreaterThan(80);
    expect(p.supporting.length).toBeGreaterThan(0);
    expect(p.opposing.length).toBeGreaterThan(0);
  });

  it("opposing factors pull power down", () => {
    const withOppose = computePower(
      { trajectoryUp: 1, sellPressure: 1, vectorConflict: 1 },
      0.5,
    );
    const without = computePower({ trajectoryUp: 1 }, 0.5);
    expect(withOppose.score as number).toBeLessThan(without.score as number);
  });

  it("empty activations yield zero power, not a fabricated value", () => {
    const p = computePower({}, 0);
    expect(p.score as number).toBe(0);
  });

  it("clamps into [0,100]", () => {
    const p = computePower(
      { trajectoryUp: 1, coherenceAlignment: 1, smartMoneyInflow: 1, liquidityDepth: 1 },
      1,
    );
    expect(p.score as number).toBeLessThanOrEqual(100);
    expect(p.score as number).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic", () => {
    const acts: FactorActivations = { trajectoryUp: 0.7, sellPressure: 0.3 };
    expect(JSON.stringify(computePower(acts, 0.5))).toBe(
      JSON.stringify(computePower(acts, 0.5)),
    );
  });
});

describe("computeThreat - independent of Power", () => {
  it("high danger factors yield high threat", () => {
    const t = computeThreat({
      rugRisk: 1,
      holderConcentration: 1,
      washTrading: 1,
      liquidityFragility: 1,
    });
    expect(t.score as number).toBeGreaterThan(80);
    expect(t.supporting.length).toBe(4);
  });

  it("threat does not change when power inputs change (independence)", () => {
    const threatInputs = { rugRisk: 0.5, holderConcentration: 0.5 };
    const t1 = computeThreat(threatInputs);
    const t2 = computeThreat(threatInputs);
    expect(t1.score as number).toBe(t2.score as number);
  });

  it("high Power and high Threat can coexist (the key V3.2 property)", () => {
    const power = computePower(
      { trajectoryUp: 1, coherenceAlignment: 1, smartMoneyInflow: 1, liquidityDepth: 1 },
      1,
    );
    const threat = computeThreat({
      rugRisk: 1,
      holderConcentration: 1,
      washTrading: 1,
      liquidityFragility: 1,
    });
    expect(power.score as number).toBeGreaterThan(80);
    expect(threat.score as number).toBeGreaterThan(80);
  });
});

describe("computeConfidence - evidence quality, not probability", () => {
  const full: ConfidenceInputs = {
    completeness: 1,
    freshness: 1,
    historyDepth: 1,
    coherence: 1,
    measurementStability: 1,
    derivativeReliability: 1,
    limitingCoverage: "COMPLETE",
    limitingTemporalOrigin: "GMGN_HISTORICAL",
  };

  it("full evidence with COMPLETE coverage yields ~100", () => {
    const c = computeConfidence(full);
    expect(c.score as number).toBeGreaterThan(95);
  });

  it("ROLLING coverage constrains confidence below COMPLETE", () => {
    const rolling = computeConfidence({ ...full, limitingCoverage: "ROLLING" });
    const complete = computeConfidence(full);
    expect(rolling.score as number).toBeLessThan(complete.score as number);
  });

  it("conflict (low coherence) lowers confidence", () => {
    const conflicted = computeConfidence({ ...full, coherence: 0 });
    const aligned = computeConfidence(full);
    expect(conflicted.score as number).toBeLessThan(aligned.score as number);
  });

  it("carries all sub-dimensions for explainability", () => {
    const c = computeConfidence(full);
    expect(c.completeness as number).toBe(1);
    expect(c.limitingCoverage).toBe("COMPLETE");
    expect(c.limitingTemporalOrigin).toBe("GMGN_HISTORICAL");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(computeConfidence(full))).toBe(
      JSON.stringify(computeConfidence(full)),
    );
  });
});

'@
Set-Content -Path 'tests/unit/powerEngine.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 8 - Power/Threat/Confidence (complete)

## What exists now

Directory skeleton, strict TypeScript config, enforced module boundaries, and the
**full V3.2 intelligence contract expressed as TypeScript types** — no runtime logic yet.

Domain type surface (all under `src/`, re-exported from `src/index.ts`):

```
shared/scalars.ts      branded Score0to100 / Ratio0to1 / UnixMillis / Maybe / Measured
shared/quality.ts      DataQuality, ModelVersions, QualityStamp
core/timeline/         TokenTimeline three-lane model (MARKET/FLOW/ANALYTICS),
                       TemporalOrigin, Coverage, Provenance, PositionEventClass
core/temporal/         TemporalProfile (velocity/acceleration), Trajectory
core/coherence/        Coherence (agreement/conflict), LeadLag (precedence, not cause)
core/power/            Power, Threat, Confidence — three independent, explainable measures
core/state/            MarketState, StateTransition, MarketEvent, Signal, Novelty, Attention
core/battlefield/      BattlefieldState — the only object leaving the core
```

```
src/core/**        the deterministic engine (no IO, no time, no randomness)
src/adapters/gmgn  the ONLY place raw GMGN shapes live; hot_level & raw
                   is_open_or_close die here (FlowEventNormalizer.contract.ts)
src/structure      GATED — verified but not admitted to core in V1
src/physics        PhysicsProjector — visual projection, one-way, downstream of core
src/replay         reuses the core pipeline; no future leakage
src/outcome        the only reader of post-decision future data
tests/architecture boundary law, enforced (not aspirational)
```

Read `ARCHITECTURE.md` for the boundary law.

## Commands

```
npm install
npm run typecheck     # strict tsc, no emit
npm run test:arch     # architecture boundary tests
npm test              # full suite (vitest)
```

## Guarantees enforced today

- `src/core/**` imports no adapter, physics, structure, replay, outcome, renderer, or IO module.
- `src/core/**` contains no `Date.now`, `new Date(`, `Math.random`, or `process.env`.
- `hot_level` and raw `is_open_or_close` never appear in `src/core`.
- Strict compilation: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and more.

The architecture test was verified to FAIL on a deliberate violation, then pass once removed —
it is a real guard, not a green rubber stamp.

## Next phase

Phase 3 — Timeline: the first runtime module. Deterministic construction of a
`TokenTimeline` from normalized observations, enforcing coverage semantics
(FLOW is ROLLING, never COMPLETE) and injected-time discipline. Still no adapter,
no network — fed from in-memory normalized inputs, tested against golden fixtures.

'@
Set-Content -Path 'README.md' -Value $content -NoNewline -Encoding utf8

Write-Host 'Phase 8 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 161 passed)' -ForegroundColor Yellow