# ============================================================
# WAR - Phase 11 Installer (Attention + Novelty + Evidence)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase11.ps1
# Requires Phase 10 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\signal\signalLifecycle.ts')) { Write-Error 'Phase 10 missing. Install Phase 10 first.'; exit 1 }
Write-Host 'Installing Phase 11 (Attention + Novelty + Evidence)...' -ForegroundColor Cyan

# ---- src/core/novelty/novelty.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/novelty' | Out-Null
$content = @'
/**
 * WAR core - Novelty (Phase 11).
 *
 * Novelty is NOT anomaly. Anomaly asks "how unusual is the current value?".
 * Novelty asks "how rarely has WAR seen this PATTERN before?". A recurring
 * anomaly can be low-novelty; a brand-new combination can be high-novelty.
 *
 * Novelty feeds ATTENTION, never Power. Pure, total, deterministic: the pattern
 * memory (seen-counts) is passed in, not held as hidden state.
 */

import type { Ratio0to1 } from "../../shared/scalars.js";
import type { Novelty } from "../state/types.js";
import { toRatio0to1 } from "../../shared/construct.js";

const R0 = 0 as Ratio0to1;
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}

/** A deterministic signature describing the current pattern (e.g. state+trajectory+coherence bucket). */
export type PatternSignature = string;

/** Read-only view of how many times each pattern has been seen before. */
export type PatternMemory = Readonly<Record<PatternSignature, number>>;

/**
 * Compute novelty for a pattern given prior sightings. rarity = 1/(1+seen):
 *   - never seen (0)      -> rarity 1.0  (maximally novel)
 *   - seen once           -> rarity 0.5
 *   - seen many times     -> rarity -> 0 (familiar, low novelty)
 */
export function computeNovelty(
  signature: PatternSignature,
  memory: PatternMemory,
): Novelty {
  const seen = memory[signature] ?? 0;
  const safeSeen = seen < 0 || !Number.isFinite(seen) ? 0 : seen;
  const rarity = 1 / (1 + safeSeen);
  const reasons =
    safeSeen === 0
      ? [`pattern "${signature}" not seen before`]
      : [`pattern "${signature}" seen ${safeSeen}x`];
  return { rarity: ratio(rarity), reasons };
}

/**
 * Record a pattern sighting, returning a NEW memory (immutable update).
 * Deterministic; callers thread the memory through time explicitly.
 */
export function recordPattern(
  signature: PatternSignature,
  memory: PatternMemory,
): PatternMemory {
  const seen = memory[signature] ?? 0;
  return { ...memory, [signature]: seen + 1 };
}

'@
Set-Content -Path 'src/core/novelty/novelty.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/novelty/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/novelty' | Out-Null
$content = @'
// WAR novelty.
export * from "./novelty.js";

'@
Set-Content -Path 'src/core/novelty/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/attention/attention.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/attention' | Out-Null
$content = @'
/**
 * WAR core - Attention (Phase 11).
 *
 * Attention answers "why should the operator look HERE, right NOW?" - it is
 * INDEPENDENT of Power. Power 52 with Attention 96 is valid: a low-strength
 * token doing something rare/accelerating/conflicting deserves a look.
 *
 * Config-driven weights, no magic numbers. Pure, total, deterministic.
 */

import type { Score0to100 } from "../../shared/scalars.js";
import type { Attention, AttentionContributor } from "../state/types.js";
import { clampScore } from "../../shared/construct.js";

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Each attention driver as an activation in [0,1]. */
export interface AttentionInputs {
  readonly magnitude: number;
  readonly acceleration: number;
  readonly novelty: number;
  readonly stateTransition: number;
  readonly trajectoryReversal: number;
  readonly signalConflict: number;
  readonly uncertainty: number;
  readonly crossTokenImpact: number;
}

export interface AttentionConfig {
  readonly version: string;
  readonly weights: Readonly<Record<AttentionContributor, number>>;
  /** Activation at/above this counts a driver as a listed contributor. */
  readonly contributorThreshold: number;
}

export const ATTENTION_CONFIG: AttentionConfig = {
  version: "attention-v1",
  weights: {
    MAGNITUDE: 15,
    ACCELERATION: 20,
    NOVELTY: 20,
    STATE_TRANSITION: 15,
    TRAJECTORY_REVERSAL: 15,
    SIGNAL_CONFLICT: 10,
    UNCERTAINTY: 5,
    CROSS_TOKEN_IMPACT: 10,
  },
  contributorThreshold: 0.3,
};

const DRIVERS: readonly (readonly [AttentionContributor, keyof AttentionInputs])[] = [
  ["MAGNITUDE", "magnitude"],
  ["ACCELERATION", "acceleration"],
  ["NOVELTY", "novelty"],
  ["STATE_TRANSITION", "stateTransition"],
  ["TRAJECTORY_REVERSAL", "trajectoryReversal"],
  ["SIGNAL_CONFLICT", "signalConflict"],
  ["UNCERTAINTY", "uncertainty"],
  ["CROSS_TOKEN_IMPACT", "crossTokenImpact"],
];

/**
 * Compute attention as a weighted sum of drivers, independent of Power.
 * Lists which drivers materially contributed (>= threshold) for explainability.
 */
export function computeAttention(
  inputs: AttentionInputs,
  config: AttentionConfig = ATTENTION_CONFIG,
): Attention {
  let total = 0;
  const contributors: AttentionContributor[] = [];

  for (const [name, key] of DRIVERS) {
    const act = clamp01(inputs[key]);
    total += act * config.weights[name];
    if (act >= config.contributorThreshold) contributors.push(name);
  }

  return { score: score(total), contributors };
}

'@
Set-Content -Path 'src/core/attention/attention.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/attention/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/attention' | Out-Null
$content = @'
// WAR attention.
export * from "./attention.js";

'@
Set-Content -Path 'src/core/attention/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/evidence/evidence.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/evidence' | Out-Null
$content = @'
/**
 * WAR core - Evidence (Phase 11).
 *
 * An explainability record: for any conclusion, what evidence supported it and
 * what contradicted it. WAR never hides uncertainty - opposing evidence is
 * first-class and always retained. Pure, total, deterministic.
 */

import type { Ratio0to1, UnixMillis } from "../../shared/scalars.js";
import type { Provenance } from "../timeline/types.js";
import { toRatio0to1 } from "../../shared/construct.js";

const R0 = 0 as Ratio0to1;
function ratio(n: number): Ratio0to1 {
  const r = toRatio0to1(n);
  return r.ok ? r.value : R0;
}

/** One piece of evidence bearing on a conclusion. */
export interface EvidenceItem {
  readonly claim: string;
  /** How strongly this item bears on the conclusion, in [0,1]. */
  readonly weight: Ratio0to1;
  /** Which data lane this evidence came from. */
  readonly provenance: Provenance;
  readonly at: UnixMillis;
}

/** The evidence supporting and opposing a single conclusion. */
export interface EvidenceRecord {
  readonly conclusion: string;
  readonly supporting: readonly EvidenceItem[];
  readonly opposing: readonly EvidenceItem[];
  /** Net support in [-1,1]: (sum supporting - sum opposing) / total, or 0 if none. */
  readonly netSupport: number;
}

export interface EvidenceInput {
  readonly claim: string;
  readonly weight: number;
  readonly provenance: Provenance;
  readonly at: UnixMillis;
}

function toItem(i: EvidenceInput): EvidenceItem {
  const w = Number.isFinite(i.weight) ? Math.max(0, Math.min(1, i.weight)) : 0;
  return { claim: i.claim, weight: ratio(w), provenance: i.provenance, at: i.at };
}

/**
 * Build an evidence record. Deterministically sorts each side by (claim) so the
 * output is order-independent, and computes net support.
 */
export function buildEvidence(
  conclusion: string,
  supporting: readonly EvidenceInput[],
  opposing: readonly EvidenceInput[],
): EvidenceRecord {
  const sup = supporting.map(toItem).sort(byClaim);
  const opp = opposing.map(toItem).sort(byClaim);

  const supSum = sup.reduce((s, i) => s + (i.weight as number), 0);
  const oppSum = opp.reduce((s, i) => s + (i.weight as number), 0);
  const total = supSum + oppSum;
  const netSupport = total > 0 ? (supSum - oppSum) / total : 0;

  return { conclusion, supporting: sup, opposing: opp, netSupport };
}

function byClaim(a: EvidenceItem, b: EvidenceItem): number {
  return a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : 0;
}

'@
Set-Content -Path 'src/core/evidence/evidence.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/evidence/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/evidence' | Out-Null
$content = @'
// WAR evidence.
export * from "./evidence.js";

'@
Set-Content -Path 'src/core/evidence/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/attentionNoveltyEvidence.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
import { describe, it, expect } from "vitest";
import { computeAttention } from "../../src/core/attention/attention.js";
import type { AttentionInputs } from "../../src/core/attention/attention.js";
import {
  computeNovelty,
  recordPattern,
} from "../../src/core/novelty/novelty.js";
import type { PatternMemory } from "../../src/core/novelty/novelty.js";
import { buildEvidence } from "../../src/core/evidence/evidence.js";
import type { EvidenceInput } from "../../src/core/evidence/evidence.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

function att(over: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    magnitude: over.magnitude ?? 0,
    acceleration: over.acceleration ?? 0,
    novelty: over.novelty ?? 0,
    stateTransition: over.stateTransition ?? 0,
    trajectoryReversal: over.trajectoryReversal ?? 0,
    signalConflict: over.signalConflict ?? 0,
    uncertainty: over.uncertainty ?? 0,
    crossTokenImpact: over.crossTokenImpact ?? 0,
  };
}

describe("computeAttention - independent of Power", () => {
  it("high novelty + acceleration yields high attention regardless of any power", () => {
    const a = computeAttention(
      att({ novelty: 1, acceleration: 1, trajectoryReversal: 1, stateTransition: 1 }),
    );
    expect(a.score as number).toBeGreaterThan(60);
  });

  it("lists the drivers that materially contributed", () => {
    const a = computeAttention(att({ novelty: 1, acceleration: 0.5 }));
    expect(a.contributors).toContain("NOVELTY");
    expect(a.contributors).toContain("ACCELERATION");
    expect(a.contributors).not.toContain("UNCERTAINTY");
  });

  it("zero inputs yield zero attention, not a fabricated value", () => {
    expect(computeAttention(att()).score as number).toBe(0);
  });

  it("stays within [0,100] even if all drivers maxed", () => {
    const a = computeAttention(
      att({
        magnitude: 1, acceleration: 1, novelty: 1, stateTransition: 1,
        trajectoryReversal: 1, signalConflict: 1, uncertainty: 1, crossTokenImpact: 1,
      }),
    );
    expect(a.score as number).toBeLessThanOrEqual(100);
  });

  it("is deterministic", () => {
    const i = att({ novelty: 0.7, acceleration: 0.4 });
    expect(JSON.stringify(computeAttention(i))).toBe(
      JSON.stringify(computeAttention(i)),
    );
  });
});

describe("computeNovelty - rarity, distinct from anomaly", () => {
  it("a never-seen pattern is maximally novel (rarity 1)", () => {
    const n = computeNovelty("state=ATTACK|traj=ACCEL_UP", {});
    expect(n.rarity as number).toBe(1);
  });

  it("a frequently seen pattern has low novelty", () => {
    const memory: PatternMemory = { "state=DORMANT|traj=FLAT": 99 };
    const n = computeNovelty("state=DORMANT|traj=FLAT", memory);
    expect(n.rarity as number).toBeLessThan(0.02);
  });

  it("recording a pattern lowers its future novelty (immutably)", () => {
    const sig = "state=EMERGING|traj=RISING";
    const before = computeNovelty(sig, {});
    const mem2 = recordPattern(sig, {});
    const after = computeNovelty(sig, mem2);
    expect(after.rarity as number).toBeLessThan(before.rarity as number);
    // original memory not mutated
    expect(computeNovelty(sig, {}).rarity as number).toBe(1);
  });

  it("is deterministic", () => {
    const mem: PatternMemory = { x: 3 };
    expect(JSON.stringify(computeNovelty("x", mem))).toBe(
      JSON.stringify(computeNovelty("x", mem)),
    );
  });
});

describe("buildEvidence - opposing evidence is retained", () => {
  const at = (ms: number) => ms as UnixMillis;
  const supp: EvidenceInput[] = [
    { claim: "smart money inflow", weight: 0.8, provenance: "track.smartmoney", at: at(1) },
    { claim: "liquidity expanding", weight: 0.6, provenance: "market.trending", at: at(2) },
  ];
  const opp: EvidenceInput[] = [
    { claim: "sell pressure rising", weight: 0.5, provenance: "track.kol", at: at(3) },
  ];

  it("keeps both supporting and opposing evidence", () => {
    const e = buildEvidence("ACCUMULATION likely", supp, opp);
    expect(e.supporting.length).toBe(2);
    expect(e.opposing.length).toBe(1);
  });

  it("net support reflects the balance and stays in [-1,1]", () => {
    const e = buildEvidence("ACCUMULATION likely", supp, opp);
    expect(e.netSupport).toBeGreaterThan(0);
    expect(e.netSupport).toBeLessThanOrEqual(1);
  });

  it("all-opposing yields negative net support", () => {
    const e = buildEvidence("bullish", [], opp);
    expect(e.netSupport).toBeLessThan(0);
  });

  it("no evidence yields zero net support, not a fabricated lean", () => {
    const e = buildEvidence("unknown", [], []);
    expect(e.netSupport).toBe(0);
  });

  it("is order-independent (deterministic sort by claim)", () => {
    const a = buildEvidence("c", supp, opp);
    const b = buildEvidence("c", [...supp].reverse(), opp);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

'@
Set-Content -Path 'tests/unit/attentionNoveltyEvidence.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 11 - Attention + Novelty + Evidence (complete)

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

Write-Host 'Phase 11 files installed.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 218 passed)' -ForegroundColor Yellow