/**
 * WAR Product Layer - Phase 1 - IntelligenceReport + EvidenceRecord.
 *
 * These are PRODUCT representations built by READING Core outputs. The Product
 * Layer never calculates intelligence and never invents evidence:
 *   - Power/Threat/Confidence/State/... come straight from the Core entry.
 *   - Evidence is AGGREGATED from Core-provided explainability that already
 *     exists: Power.supporting / Power.opposing (Contribution[]) and the
 *     reasons[] carried by events, signals, and (upstream) state transitions.
 *   - WHY_NOW is a structured re-statement of Core reasons - not new inference.
 *
 * There is deliberately NO battlefield.evidence field in Core (verified in
 * Phase 0); this builder is how the product surfaces "why did WAR say this".
 */

import type {
  TokenBattlefieldEntry,
  BattlefieldState,
} from "../../core/battlefield/types.js";
import type { Contribution } from "../../core/power/types.js";
import type { TokenId } from "../domain/identity.js";

// -- Evidence -----------------------------------------------------------------

export type EvidenceKind =
  | "POWER_SUPPORTING"
  | "POWER_OPPOSING"
  | "EVENT"
  | "SIGNAL"
  | "STATE";

/** One traceable reason WAR produced an output. Aggregated, never invented. */
export interface EvidenceRecord {
  readonly kind: EvidenceKind;
  readonly factor: string;
  /** Signed weight where the Core provided one (Contribution); else null. */
  readonly magnitude: number | null;
  readonly weight: number | null;
  /** Free-text reason where the Core provided one (events/signals). */
  readonly note: string | null;
}

function fromContribution(k: EvidenceKind, c: Contribution): EvidenceRecord {
  return { kind: k, factor: c.factor, magnitude: c.magnitude, weight: c.weight, note: null };
}

/**
 * Aggregate all Core-provided explainability for one token into a flat,
 * deterministically-ordered evidence list. Order: power-supporting,
 * power-opposing, events, signals - stable within each group by source order.
 */
export function aggregateEvidence(entry: TokenBattlefieldEntry): readonly EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const c of entry.power.supporting) out.push(fromContribution("POWER_SUPPORTING", c));
  for (const c of entry.power.opposing) out.push(fromContribution("POWER_OPPOSING", c));
  for (const ev of entry.events) {
    for (const r of ev.reasons) {
      out.push({ kind: "EVENT", factor: ev.type, magnitude: null, weight: null, note: r });
    }
  }
  for (const s of entry.signals) {
    for (const r of s.reasons) {
      out.push({ kind: "SIGNAL", factor: s.identity, magnitude: null, weight: null, note: r });
    }
  }
  return out;
}

// -- WHY_NOW ------------------------------------------------------------------

/**
 * Structured "why should I care now" derived from Core events + signal phases.
 * Each line is a restatement of a Core reason; no new intelligence is computed.
 */
export function whyNow(entry: TokenBattlefieldEntry): readonly string[] {
  const lines: string[] = [];
  // Events are the primary "what changed" driver, ordered by importance desc.
  const events = [...entry.events].sort(
    (a, b) => (b.importance as number) - (a.importance as number),
  );
  for (const ev of events) {
    const head = ev.reasons.length > 0 ? ev.reasons[0] : ev.type;
    lines.push(`${ev.type}: ${head}`);
  }
  // Signal lifecycle transitions worth surfacing.
  for (const s of entry.signals) {
    if (s.phase === "EMERGING" || s.phase === "CONFIRMED" || s.phase === "WEAKENING") {
      const head = s.reasons.length > 0 ? s.reasons[0] : s.identity;
      lines.push(`SIGNAL_${s.phase}: ${head}`);
    }
  }
  return lines;
}

// -- IntelligenceReport -------------------------------------------------------

/**
 * Renderer-independent product report for one token. This is NOT UI. The future
 * Telegram Mini App renders this without knowing anything about GMGN.
 */
export interface IntelligenceReport {
  readonly token: TokenId;
  readonly generatedAt: number; // mirrors BattlefieldState.generatedAt

  readonly state: TokenBattlefieldEntry["state"];
  readonly power: TokenBattlefieldEntry["power"];
  readonly threat: TokenBattlefieldEntry["threat"];
  readonly confidence: TokenBattlefieldEntry["confidence"];
  readonly attention: TokenBattlefieldEntry["attention"];
  readonly novelty: TokenBattlefieldEntry["novelty"];

  readonly trajectory: TokenBattlefieldEntry["trajectory"];
  readonly coherence: TokenBattlefieldEntry["coherence"];
  readonly leadLag: TokenBattlefieldEntry["leadLag"];

  readonly signals: TokenBattlefieldEntry["signals"];
  readonly events: TokenBattlefieldEntry["events"];

  readonly whyNow: readonly string[];
  readonly evidence: readonly EvidenceRecord[];

  readonly quality: TokenBattlefieldEntry["quality"];
  readonly marketRegime: BattlefieldState["marketRegime"];

  /** Version pinning so a stored report stays interpretable forever. */
  readonly modelVersions: BattlefieldState["modelVersions"];
}

/** Build a report for one token from a Core BattlefieldState. Pure. */
export function buildIntelligenceReport(
  battlefield: BattlefieldState,
  entry: TokenBattlefieldEntry,
): IntelligenceReport {
  return {
    token: { chain: entry.chain, address: entry.address },
    generatedAt: battlefield.generatedAt as number,
    state: entry.state,
    power: entry.power,
    threat: entry.threat,
    confidence: entry.confidence,
    attention: entry.attention,
    novelty: entry.novelty,
    trajectory: entry.trajectory,
    coherence: entry.coherence,
    leadLag: entry.leadLag,
    signals: entry.signals,
    events: entry.events,
    whyNow: whyNow(entry),
    evidence: aggregateEvidence(entry),
    quality: entry.quality,
    marketRegime: battlefield.marketRegime,
    modelVersions: battlefield.modelVersions,
  };
}
