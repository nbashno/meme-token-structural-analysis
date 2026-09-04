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
