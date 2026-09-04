/**
 * WAR world - World Adapter (Phase 2).
 *
 * Pure projection: IntelligenceReport (+ flow observations) -> WorldState, a
 * render-ready visual description. It performs ZERO intelligence:
 *   - no scoring, no classification, no weighting, no inference
 *   - every numeric value is PASSED THROUGH unchanged from the report
 *   - visual normalization (0..1 for bar widths) is presentational only and is
 *     kept separate from the raw value, which is always preserved
 *
 * The renderer consumes WorldState and never sees the engine. An architecture
 * guard forbids src/world from importing any core engine or scoring config.
 */

import type { IntelligenceReport } from "../product/intelligence/report.js";
import type { FlowObservation } from "../core/timeline/types.js";

/** Visual archetype for each REAL Core state. No new state is invented. */
export type WorldMood =
  | "UNKNOWN" | "OBSERVING" | "EMERGING" | "ACCUMULATION"
  | "ATTACK" | "DOMINANCE" | "DISTRIBUTION" | "BLEEDING" | "COLLAPSE" | "DORMANT";

/** A force reading: the raw value AND a purely-visual 0..1 for bar width. */
export interface ForceView {
  readonly raw: number; // 0..100 exactly as computed by WAR
  readonly visual01: number; // raw/100, for rendering ONLY
  readonly band: string; // presentational label
}

/** A flow entity — provenance lane only; NO persona (no classifier exists). */
export interface FlowEntityView {
  readonly maker: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number; // passed through, never scored
  readonly lane: "SMART_MONEY" | "KOL" | "FOLLOW_WALLET" | "OTHER";
  readonly persona: "UNKNOWN"; // always UNKNOWN — no classifier in Phase 1
}

export interface WorldEventView {
  readonly type: string;
  readonly importance: number; // raw, drives visual emphasis only
  readonly reason: string;
}

export interface WorldSignalView {
  readonly identity: string;
  readonly phase: string;
}

export interface WorldState {
  readonly chain: string;
  readonly address: string;
  readonly generatedAt: number;

  readonly mood: WorldMood; // = real Core state
  readonly trajectory: string;
  readonly coherence: string;
  readonly leadLag: string;
  readonly regime: string;

  readonly power: ForceView;
  readonly threat: ForceView;
  readonly confidence: ForceView;
  readonly attention: ForceView;

  readonly events: readonly WorldEventView[];
  readonly signals: readonly WorldSignalView[];
  readonly whyNow: readonly string[];
  readonly flowEntities: readonly FlowEntityView[];

  readonly dataQuality: string;
  readonly qualityReasons: readonly string[];
  readonly insufficient: readonly string[]; // surfaced, never hidden

  /** Visual metadata (renderer hints), never intelligence. */
  readonly visual: WorldVisualMeta;
}

/** Purely presentational metadata — position/size/lod. No meaning attached. */
export interface WorldVisualMeta {
  readonly territorySize01: number; // from attention.raw/100 (visual weight only)
  readonly contestBalance01: number; // power vs threat split, presentation only
}

function band(v: number): string {
  if (v >= 75) return "High";
  if (v >= 50) return "Elevated";
  if (v >= 25) return "Moderate";
  return "Low";
}

function force(raw: number): ForceView {
  const clamped = raw < 0 ? 0 : raw > 100 ? 100 : raw;
  return { raw, visual01: clamped / 100, band: band(raw) };
}

function lane(provenance: string): FlowEntityView["lane"] {
  if (provenance === "track.smartmoney") return "SMART_MONEY";
  if (provenance === "track.kol") return "KOL";
  if (provenance === "track.follow-wallet") return "FOLLOW_WALLET";
  return "OTHER";
}

/** Extract the INSUFFICIENT markers already recorded by the engine in quality. */
function insufficientFrom(reasons: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const r of reasons) {
    const m = r.match(/insufficient:\s*(.+)/i);
    if (m && m[1]) out.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

export interface WorldAdapterInput {
  readonly report: IntelligenceReport;
  /** Optional flow observations for entity projection (visual only). */
  readonly flow?: readonly FlowObservation[];
}

export function toWorldState(input: WorldAdapterInput): WorldState {
  const r = input.report;
  const power = force(r.power.score as unknown as number);
  const threat = force(r.threat.score as unknown as number);
  const attention = force(r.attention.score as unknown as number);
  const confidence = force(r.confidence.score as unknown as number);

  const total = power.raw + threat.raw || 1;

  const flowEntities: FlowEntityView[] = (input.flow ?? []).map((f) => ({
    maker: f.maker,
    side: f.side,
    amountUsd: f.amountUsd,
    lane: lane(f.meta.provenance),
    persona: "UNKNOWN",
  }));

  return {
    chain: r.token.chain,
    address: r.token.address as unknown as string,
    generatedAt: r.generatedAt,

    mood: r.state as WorldMood,
    trajectory: r.trajectory.classification,
    coherence: r.coherence.state,
    leadLag: r.leadLag.result,
    regime: r.marketRegime,

    power, threat, confidence, attention,

    events: [...r.events]
      .sort((a, b) => (b.importance as unknown as number) - (a.importance as unknown as number))
      .map((e) => ({ type: e.type, importance: e.importance as unknown as number, reason: e.reasons[0] ?? "" })),
    signals: r.signals.map((s) => ({ identity: s.identity, phase: s.phase })),
    whyNow: r.whyNow,
    flowEntities,

    dataQuality: r.quality.quality,
    qualityReasons: r.quality.reasons,
    insufficient: insufficientFrom(r.quality.reasons),

    visual: {
      territorySize01: attention.raw / 100,
      contestBalance01: power.raw / total,
    },
  };
}
