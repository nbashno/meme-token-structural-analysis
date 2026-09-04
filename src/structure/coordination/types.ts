/**
 * COORDINATION V1 — normalized types.
 *
 * GATED capability (src/structure). Nothing in src/core may import this.
 * These are the ONLY shapes the pure CoordinationDetector consumes; it cannot
 * tell Helius from Alchemy from GMGN. All timing is data, never read from a
 * clock. See COORDINATION_V1_SPEC.md.
 */

/** A wallet's entry into a token, already normalized off the sealed flow path. */
export interface WalletObservation {
  readonly wallet: string;
  readonly token: string;
  readonly side: "buy" | "sell";
  /** unix seconds, or null = INSUFFICIENT (never "did not enter together"). */
  readonly entryTime: number | null;
  /** MUST be false to be eligible. sim=true (trending/synthetic) is rejected (G1). */
  readonly sim: boolean;
  /** optional confirmed supply share [0..1] for this wallet, if derivable. */
  readonly supplyShare?: number | null;
}

/** First-funder record, normalized across chains. funder=null means 404/unknown. */
export interface FundingRecord {
  readonly wallet: string;
  readonly funder: string | null;
  /** identity category or null (unknown → a coordination CANDIDATE, not excluded). */
  readonly funderType: string | null;
  readonly fundingTime: number | null;
  readonly fundingAmount: number | null;
  readonly sourceConfidence: "RESOLVED" | "INSUFFICIENT";
}

export type Evidence =
  | "COMMON_FUNDER"
  | "FUNDING_PROXIMITY"
  | "ENTRY_PROXIMITY"
  | "CLUSTER_SIZE";

export type LinkStrength = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type CoordinationStatus =
  | "OBSERVED"
  | "CANDIDATE"
  | "INSUFFICIENT"
  | "NONE";

export interface LinkedWalletCluster {
  readonly fundingAnchor: string;
  readonly members: readonly string[];
  readonly commonFunder: boolean;
  readonly fundingWindowSec: number | null;
  readonly entryWindowSec: number | null;
  readonly supplyInvolved: number | null;
  readonly evidence: readonly Evidence[];
  readonly linkStrength: LinkStrength;
}

export interface CoordinationObservation {
  readonly token: string;
  readonly cluster: LinkedWalletCluster | null;
  readonly status: CoordinationStatus;
  readonly linkStrength: LinkStrength;
  /** injected as data — the Detector never calls Date.now (C2). */
  readonly observedAt: number;
  /** provisional until offline calibration replaces the placeholder thresholds. */
  readonly thresholdsCalibrated: boolean;
}

/** Placeholder thresholds — NOT calibrated. Replaced by offline calibration. */
export interface CoordinationThresholds {
  readonly minCluster: number;
  readonly fundingWindowTightSec: number;
  readonly entryWindowTightSec: number;
}

export const DEFAULT_THRESHOLDS: CoordinationThresholds = {
  minCluster: 3,
  fundingWindowTightSec: 120,
  entryWindowTightSec: 60,
};

/**
 * funderTypes that are shared infrastructure — excluded from clustering (G3).
 * Matches Helius identity categories. `null` funderType is NOT here: unknown
 * funders are kept as candidates (the counter-intuitive but correct rule).
 */
export const INFRA_FUNDER_TYPES: ReadonlySet<string> = new Set([
  "exchange",
  "centralized exchange",
  "cross-chain bridge",
  "bridge",
  "defi",
  "market maker",
  "validator",
  "stake pool",
  "system",
  "fees",
  "oracle",
]);
