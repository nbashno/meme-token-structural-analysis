/**
 * WAR UI - view-model (Phase 9).
 *
 * The ONE bridge between intelligence and presentation. It maps an
 * IntelligenceReport (already fully computed by WAR) into display-ready plain
 * data. It performs ZERO intelligence: no scoring, no thresholds that invent
 * meaning, no derived signals. Every number here already exists in the report;
 * this layer only FORMATS (round, label enum->text, order lists).
 *
 * The UI imports ONLY this view-model. An architecture guard forbids the UI from
 * importing any core/engine module, so presentation can never smuggle in
 * computation.
 */

import type { IntelligenceReport } from "../product/intelligence/report.js";

/** A single labelled score, already computed. `value` is 0..100 from the report. */
export interface ScoreView {
  readonly value: number; // 0..100, as computed by WAR
  readonly label: string; // human label for the enum band the report already set
}

export interface ContributionView {
  readonly factor: string;
  readonly magnitude: number;
  readonly weight: number;
}

export interface EvidenceView {
  readonly kind: string;
  readonly factor: string;
  readonly note: string | null;
  readonly magnitude: number | null;
}

export interface SignalView {
  readonly identity: string;
  readonly phase: string;
  readonly reason: string;
}

export interface EventView {
  readonly type: string;
  readonly importance: number;
  readonly reason: string;
}

/** Everything the scan screen renders. All fields sourced 1:1 from the report. */
export interface ScanViewModel {
  readonly chain: string;
  readonly address: string;
  readonly generatedAt: number;

  readonly power: ScoreView;
  readonly threat: ScoreView;
  readonly confidence: ScoreView;
  readonly attention: ScoreView;

  readonly state: string;
  readonly trajectory: string;
  readonly coherence: string;
  readonly leadLag: string;
  readonly marketRegime: string;

  readonly powerSupporting: readonly ContributionView[];
  readonly powerOpposing: readonly ContributionView[];
  readonly threatSupporting: readonly ContributionView[];

  readonly whyNow: readonly string[];
  readonly evidence: readonly EvidenceView[];
  readonly signals: readonly SignalView[];
  readonly events: readonly EventView[];

  readonly dataQuality: string;
  readonly qualityReasons: readonly string[];

  readonly engineVersion: string;
  readonly activationModelVersion: string;
  readonly confidenceModelVersion: string;
}

// -- Pure formatting helpers (NO intelligence) --------------------------------

/** Band label for a 0..100 score. This is presentational binning ONLY — it does
 *  not change the value or feed any decision; the value shown is always the raw
 *  computed number. The band is a reading aid for the human eye. */
function bandLabel(score: number): string {
  if (score >= 75) return "High";
  if (score >= 50) return "Elevated";
  if (score >= 25) return "Moderate";
  return "Low";
}

function score(value: number): ScoreView {
  return { value, label: bandLabel(value) };
}

/** Enum -> spaced Title Case (e.g. ACCELERATING_UP -> "Accelerating up"). */
function humanize(token: string): string {
  const lower = token.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function toScanViewModel(report: IntelligenceReport): ScanViewModel {
  return {
    chain: report.token.chain,
    address: report.token.address as unknown as string,
    generatedAt: report.generatedAt,

    power: score(report.power.score as unknown as number),
    threat: score(report.threat.score as unknown as number),
    confidence: score(report.confidence.score as unknown as number),
    attention: score(report.attention.score as unknown as number),

    state: humanize(report.state),
    trajectory: humanize(report.trajectory.classification),
    coherence: humanize(report.coherence.state),
    leadLag: humanize(report.leadLag.result),
    marketRegime: humanize(report.marketRegime),

    powerSupporting: report.power.supporting.map((c) => ({ factor: humanize(c.factor), magnitude: c.magnitude, weight: c.weight })),
    powerOpposing: report.power.opposing.map((c) => ({ factor: humanize(c.factor), magnitude: c.magnitude, weight: c.weight })),
    threatSupporting: report.threat.supporting.map((c) => ({ factor: humanize(c.factor), magnitude: c.magnitude, weight: c.weight })),

    whyNow: report.whyNow,
    evidence: report.evidence.map((e) => ({ kind: humanize(e.kind), factor: humanize(e.factor), note: e.note, magnitude: e.magnitude })),
    signals: report.signals.map((s) => ({ identity: humanize(s.identity), phase: humanize(s.phase), reason: s.reasons[0] ?? "" })),
    events: [...report.events]
      .sort((a, b) => (b.importance as unknown as number) - (a.importance as unknown as number))
      .map((e) => ({ type: humanize(e.type), importance: e.importance as unknown as number, reason: e.reasons[0] ?? "" })),

    dataQuality: humanize(report.quality.quality),
    qualityReasons: report.quality.reasons,

    engineVersion: report.modelVersions.engineVersion,
    activationModelVersion: report.modelVersions.activationModelVersion,
    confidenceModelVersion: report.modelVersions.confidenceModelVersion,
  };
}
