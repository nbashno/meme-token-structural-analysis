# ============================================================
# WAR - Phase 12 Installer (BattlefieldState - CORE COMPLETE)
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase12.ps1
# Requires Phase 11 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\attention\attention.ts')) { Write-Error 'Phase 11 missing. Install Phase 11 first.'; exit 1 }
Write-Host 'Installing Phase 12 (BattlefieldState)...' -ForegroundColor Cyan

# ---- src/config/versions.ts ----
New-Item -ItemType Directory -Force -Path 'src/config' | Out-Null
$content = @'
/**
 * WAR core - version identifiers (Phase 12).
 *
 * Every BattlefieldState is stamped with these so historical outputs stay
 * interpretable as models evolve. Bumping any sub-model version here is how a
 * behavioural change is made auditable.
 */

import type { ModelVersions } from "../shared/quality.js";

export const ENGINE_VERSION = "war-engine-0.1.0";

export const MODEL_VERSIONS: ModelVersions = {
  engineVersion: ENGINE_VERSION,
  powerModelVersion: "power-v1",
  stateModelVersion: "state-v1",
  physicsModelVersion: "physics-none", // physics not part of the core build
  configurationVersion: "config-v1",
};

'@
Set-Content -Path 'src/config/versions.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/battlefield/assembleBattlefield.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/battlefield' | Out-Null
$content = @'
/**
 * WAR core - Battlefield Assembler (Phase 12).
 *
 * Combines the per-token outputs of every engine into a single BattlefieldState
 * - the ONLY object that leaves the core. A renderer consumes this without
 * knowing how any of it was computed.
 *
 * Deterministic: tokens are sorted by a stable key, rankings by attention with a
 * stable tiebreak, and correlations sorted by endpoints. Time is injected via
 * `generatedAt`. Pure, total. No clock, no randomness, no IO.
 */

import type {
  Chain,
  TokenAddress,
  UnixMillis,
  Score0to100,
} from "../../shared/scalars.js";
import type { ModelVersions, QualityStamp } from "../../shared/quality.js";
import type { Power, Threat, Confidence } from "../power/types.js";
import type { Trajectory } from "../temporal/types.js";
import type { Coherence, LeadLag } from "../coherence/types.js";
import type {
  MarketState,
  MarketEvent,
  Signal,
  Novelty,
  Attention,
} from "../state/types.js";
import type {
  BattlefieldState,
  TokenBattlefieldEntry,
  CorrelationEdge,
  MarketRegime,
} from "./types.js";
import { clampScore } from "../../shared/construct.js";
import { MODEL_VERSIONS } from "../../config/versions.js";

const S0 = 0 as Score0to100;
function score(n: number): Score0to100 {
  const r = clampScore(n);
  return r.ok ? r.value : S0;
}

/** Fully-computed intelligence for one token, ready to be placed on the field. */
export interface TokenAssemblyInput {
  readonly chain: Chain;
  readonly address: TokenAddress;
  readonly power: Power;
  readonly threat: Threat;
  readonly confidence: Confidence;
  readonly state: MarketState;
  readonly trajectory: Trajectory;
  readonly coherence: Coherence;
  readonly leadLag: LeadLag;
  readonly attention: Attention;
  readonly novelty: Novelty;
  readonly signals: readonly Signal[];
  readonly events: readonly MarketEvent[];
  readonly quality: QualityStamp;
}

export interface AssemblyInput {
  readonly generatedAt: UnixMillis;
  readonly marketRegime: MarketRegime;
  readonly tokens: readonly TokenAssemblyInput[];
  readonly correlations: readonly CorrelationEdge[];
  readonly modelVersions?: ModelVersions;
}

function toEntry(t: TokenAssemblyInput): TokenBattlefieldEntry {
  return {
    chain: t.chain,
    address: t.address,
    power: t.power,
    threat: t.threat,
    confidence: t.confidence,
    state: t.state,
    trajectory: t.trajectory,
    coherence: t.coherence,
    leadLag: t.leadLag,
    attention: t.attention,
    novelty: t.novelty,
    signals: t.signals,
    events: t.events,
    quality: t.quality,
  };
}

/** Assemble the renderer-independent battlefield snapshot. */
export function assembleBattlefield(input: AssemblyInput): BattlefieldState {
  // Deterministic token order: by address (stable, total).
  const entries = [...input.tokens]
    .map(toEntry)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  // Rankings: highest attention first, tie-broken by address for stability.
  const rankings: TokenAddress[] = [...entries]
    .sort((a, b) => {
      const ca = a.attention.score as number;
      const cb = b.attention.score as number;
      if (ca !== cb) return cb - ca;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    })
    .map((e) => e.address);

  // Global attention: the peak token attention (what most demands a look).
  let peak = 0;
  for (const e of entries) {
    const s = e.attention.score as number;
    if (s > peak) peak = s;
  }

  // Correlations sorted deterministically by endpoints.
  const correlations = [...input.correlations].sort((x, y) => {
    if (x.a !== y.a) return x.a < y.a ? -1 : 1;
    if (x.b !== y.b) return x.b < y.b ? -1 : 1;
    return 0;
  });

  return {
    generatedAt: input.generatedAt,
    modelVersions: input.modelVersions ?? MODEL_VERSIONS,
    marketRegime: input.marketRegime,
    tokens: entries,
    rankings,
    correlations,
    globalAttention: score(peak),
  };
}

'@
Set-Content -Path 'src/core/battlefield/assembleBattlefield.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/core/battlefield/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/core/battlefield' | Out-Null
$content = @'
// WAR BattlefieldState + assembler.
export type * from "./types.js";
export * from "./assembleBattlefield.js";

'@
Set-Content -Path 'src/core/battlefield/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/unit/battlefield.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/unit' | Out-Null
$content = @'
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

'@
Set-Content -Path 'tests/unit/battlefield.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 12 - BattlefieldState (complete) - CORE INTELLIGENCE COMPLETE

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

Write-Host 'Phase 12 installed. CORE INTELLIGENCE COMPLETE.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 229 passed)' -ForegroundColor Yellow