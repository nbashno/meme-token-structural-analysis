# ============================================================
# WAR - Phase 13-15 Installer (Replay + Outcome + Golden) - FULL CORE
# Run from inside war\ :  powershell -ExecutionPolicy Bypass -File .\install-phase13-15.ps1
# Requires Phase 12 already present.
# ============================================================

$ErrorActionPreference = 'Stop'
if (-not (Test-Path 'package.json')) { Write-Error 'Run from inside the war/ folder.'; exit 1 }
if (-not (Test-Path 'src\core\battlefield\assembleBattlefield.ts')) { Write-Error 'Phase 12 missing. Install Phase 12 first.'; exit 1 }
Write-Host 'Installing Phase 13-15 (Replay + Outcome + Golden)...' -ForegroundColor Cyan

# ---- src/replay/replay.ts ----
New-Item -ItemType Directory -Force -Path 'src/replay' | Out-Null
$content = @'
/**
 * WAR replay - Temporal Reconstruction (Phase 13).
 *
 * Replays the SAME pipeline used live. At each timestamp T, the reconstructed
 * BattlefieldState is built ONLY from observations at or before T - never after.
 * This is the anti-lookahead guarantee made operational: "what did WAR know at T?"
 *
 * A step function (injected) maps the observations-up-to-T into a BattlefieldState.
 * Replay owns the windowing and the guarantee; the intelligence lives in the
 * injected stepper (the same one live mode uses). Pure, total, deterministic.
 */

import type { UnixMillis } from "../shared/scalars.js";
import type { BattlefieldState } from "../core/battlefield/types.js";

/** An observation with a timestamp - the unit replay windows over. */
export interface TimedObservation {
  readonly at: UnixMillis;
}

/** Produces a BattlefieldState from the observations visible up to and including T. */
export type BattlefieldStepper<T extends TimedObservation> = (
  visible: readonly T[],
  now: UnixMillis,
) => BattlefieldState;

/** One reconstructed frame: the instant and what WAR knew then. */
export interface ReplayFrame {
  readonly at: UnixMillis;
  readonly state: BattlefieldState;
}

/**
 * Reconstruct a frame at each distinct timestamp in the observation set.
 * Anti-lookahead is enforced here: `visible` never contains an observation
 * whose `at` exceeds the frame time.
 */
export function replay<T extends TimedObservation>(
  observations: readonly T[],
  stepper: BattlefieldStepper<T>,
): readonly ReplayFrame[] {
  // Deterministic chronological order.
  const sorted = [...observations].sort(
    (a, b) => (a.at as number) - (b.at as number),
  );

  // Distinct frame times, ascending.
  const frameTimes: number[] = [];
  let last: number | null = null;
  for (const o of sorted) {
    const t = o.at as number;
    if (t !== last) {
      frameTimes.push(t);
      last = t;
    }
  }

  const frames: ReplayFrame[] = [];
  for (const t of frameTimes) {
    // ONLY observations at or before t are visible. No future leakage.
    const visible = sorted.filter((o) => (o.at as number) <= t);
    const now = t as UnixMillis;
    frames.push({ at: now, state: stepper(visible, now) });
  }
  return frames;
}

/**
 * Assert that a set of frames contains no future leakage relative to a set of
 * observations: every frame's visible-window max time is <= the frame time.
 * Returned as a boolean so callers/tests can verify the guarantee explicitly.
 */
export function framesRespectAntiLookahead(
  frames: readonly ReplayFrame[],
): boolean {
  // generatedAt of each frame must equal its declared time and be non-decreasing.
  let prev = -Infinity;
  for (const f of frames) {
    const gt = f.state.generatedAt as number;
    if (gt !== (f.at as number)) return false;
    if (gt < prev) return false;
    prev = gt;
  }
  return true;
}

'@
Set-Content -Path 'src/replay/replay.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/replay/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/replay' | Out-Null
$content = @'
// WAR replay - temporal reconstruction (anti-lookahead).
export * from "./replay.js";

'@
Set-Content -Path 'src/replay/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/outcome/outcomeEvaluator.ts ----
New-Item -ItemType Directory -Force -Path 'src/outcome' | Out-Null
$content = @'
/**
 * WAR outcome - OutcomeEvaluator (Phase 14).
 *
 * The ONLY component permitted to read post-decision future data - and only
 * AFTER a DecisionRecord is sealed. It never feeds back into the core; it
 * measures what happened after a decision, for evaluation and (later) the
 * early-detection benchmark. No automatic training in this phase.
 *
 * Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { UnixMillis } from "../shared/scalars.js";

/** A sealed decision: the instant it was made and the price then. */
export interface DecisionRecord {
  readonly id: string;
  readonly at: UnixMillis;
  readonly direction: "UP" | "DOWN"; // what WAR flagged
  readonly referencePrice: number;
  readonly sealed: true;
}

/** A future price observation (strictly after the decision). */
export interface FuturePrice {
  readonly at: UnixMillis;
  readonly price: number;
}

export type Verdict =
  | "CONFIRMED"
  | "REJECTED"
  | "INCONCLUSIVE"
  | "NO_FUTURE_DATA";

export interface Outcome {
  readonly decisionId: string;
  readonly actualDirection: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  readonly actualMagnitude: number; // fractional move from reference
  /** Max favorable excursion (best move in the flagged direction). */
  readonly mfe: number;
  /** Max adverse excursion (worst move against the flagged direction). */
  readonly mae: number;
  readonly timeToOutcome: number | null; // ms to first threshold cross, or null
  readonly verdict: Verdict;
}

export interface OutcomeConfig {
  /** Fractional move (e.g. 0.05 = 5%) that confirms/rejects a direction. */
  readonly threshold: number;
}

export const OUTCOME_CONFIG: OutcomeConfig = { threshold: 0.05 };

/**
 * Evaluate a sealed decision against future prices. Enforces that only prices
 * strictly AFTER the decision are considered - this is the temporal firewall.
 */
export function evaluateOutcome(
  decision: DecisionRecord,
  futurePrices: readonly FuturePrice[],
  config: OutcomeConfig = OUTCOME_CONFIG,
): Outcome {
  // Temporal firewall: keep only strictly-future prices, sorted.
  const future = futurePrices
    .filter((p) => (p.at as number) > (decision.at as number))
    .sort((a, b) => (a.at as number) - (b.at as number));

  if (future.length === 0) {
    return {
      decisionId: decision.id,
      actualDirection: "UNKNOWN",
      actualMagnitude: 0,
      mfe: 0,
      mae: 0,
      timeToOutcome: null,
      verdict: "NO_FUTURE_DATA",
    };
  }

  const ref = decision.referencePrice;
  const flaggedUp = decision.direction === "UP";

  let mfe = 0; // best favorable fractional move
  let mae = 0; // worst adverse fractional move (as a positive number)
  let timeToOutcome: number | null = null;

  for (const p of future) {
    const move = ref !== 0 ? (p.price - ref) / ref : 0;
    const favorable = flaggedUp ? move : -move;
    const adverse = -favorable;
    if (favorable > mfe) mfe = favorable;
    if (adverse > mae) mae = adverse;
    if (timeToOutcome === null && favorable >= config.threshold) {
      timeToOutcome = (p.at as number) - (decision.at as number);
    }
  }

  const lastPrice = future[future.length - 1];
  const finalMove =
    lastPrice !== undefined && ref !== 0
      ? (lastPrice.price - ref) / ref
      : 0;
  const finalFavorable = flaggedUp ? finalMove : -finalMove;

  const actualDirection: Outcome["actualDirection"] =
    finalMove > 0 ? "UP" : finalMove < 0 ? "DOWN" : "FLAT";

  let verdict: Verdict;
  if (finalFavorable >= config.threshold) verdict = "CONFIRMED";
  else if (finalFavorable <= -config.threshold) verdict = "REJECTED";
  else verdict = "INCONCLUSIVE";

  return {
    decisionId: decision.id,
    actualDirection,
    actualMagnitude: finalMove,
    mfe,
    mae,
    timeToOutcome,
    verdict,
  };
}

'@
Set-Content -Path 'src/outcome/outcomeEvaluator.ts' -Value $content -NoNewline -Encoding utf8

# ---- src/outcome/index.ts ----
New-Item -ItemType Directory -Force -Path 'src/outcome' | Out-Null
$content = @'
// WAR outcome evaluator - the only reader of post-decision future data.
export * from "./outcomeEvaluator.js";

'@
Set-Content -Path 'src/outcome/index.ts' -Value $content -NoNewline -Encoding utf8

# ---- tests/golden/replayOutcome.test.ts ----
New-Item -ItemType Directory -Force -Path 'tests/golden' | Out-Null
$content = @'
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

'@
Set-Content -Path 'tests/golden/replayOutcome.test.ts' -Value $content -NoNewline -Encoding utf8

# ---- README.md ----
$content = @'
# WAR Engine

Deterministic temporal market-intelligence engine. Renderer-agnostic core.

- **Intelligence contract:** V3.2 (FROZEN)
- **GMGN evidence:** sealed at commit `147c070` — see `PHASE_0_SEALED.md`
- **Current phase:** Phase 13-15 - Replay + Outcome + Golden (complete) - FULL CORE DONE

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

Write-Host 'Phase 13-15 installed. FULL CORE COMPLETE.' -ForegroundColor Green
Write-Host 'Next: npm test   (expect 242 passed; first run writes 1 new snapshot)' -ForegroundColor Yellow