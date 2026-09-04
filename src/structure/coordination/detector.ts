/**
 * COORDINATION V1 — pure deterministic detector.
 *
 * PURE: no Date.now, no new Date(), no Math.random, no IO, no network. Time is
 * received as data (`observedAt`). Mirrors Helius's own group-by-funder cluster
 * method plus timing tests. Emits a NEUTRAL observation with a link strength —
 * never a verdict, risk number, or price expectation. See COORDINATION_V1_SPEC.md.
 */

import {
  type WalletObservation,
  type FundingRecord,
  type CoordinationObservation,
  type LinkedWalletCluster,
  type CoordinationThresholds,
  type Evidence,
  type LinkStrength,
  DEFAULT_THRESHOLDS,
  INFRA_FUNDER_TYPES,
} from "./types.js";

function windowSec(times: readonly number[]): number | null {
  if (times.length === 0) return null;
  let lo = times[0]!;
  let hi = times[0]!;
  for (const t of times) {
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo;
}

/**
 * Detect a single strongest LINKED_WALLET_CLUSTER for one token.
 *
 * @param token   the token address under observation
 * @param wallets normalized entry observations (already the token's makers)
 * @param funding first-funder records for those wallets
 * @param observedAt injected unix-seconds timestamp (NOT read from a clock)
 */
export function detectCoordination(
  token: string,
  wallets: readonly WalletObservation[],
  funding: readonly FundingRecord[],
  observedAt: number,
  thresholds: CoordinationThresholds = DEFAULT_THRESHOLDS,
): CoordinationObservation {
  const none = (
    status: CoordinationObservation["status"],
  ): CoordinationObservation => ({
    token,
    cluster: null,
    status,
    linkStrength: "NONE",
    observedAt,
    thresholdsCalibrated: false,
  });

  // G1: reject synthetic/trending makers entirely.
  const real = wallets.filter((w) => w.sim === false && w.token === token);
  if (real.length === 0) return none("NONE");

  // Index funding by wallet.
  const fundingByWallet = new Map<string, FundingRecord>();
  for (const f of funding) fundingByWallet.set(f.wallet, f);

  // Build eligible wallets: must have a RESOLVED funder that is not shared infra.
  // G2: INSUFFICIENT funding is tracked, not silently dropped.
  // G3: known-infra funderType excluded; funderType=null kept as candidate.
  type Eligible = {
    wallet: string;
    funder: string;
    fundingTime: number | null;
    entryTime: number | null;
    supplyShare: number | null;
  };
  const eligible: Eligible[] = [];
  let sawInsufficientFunding = false;

  for (const w of real) {
    const f = fundingByWallet.get(w.wallet);
    if (!f || f.sourceConfidence === "INSUFFICIENT" || f.funder === null) {
      sawInsufficientFunding = true;
      continue;
    }
    const typeKey = (f.funderType ?? "").trim().toLowerCase();
    if (typeKey.length > 0 && INFRA_FUNDER_TYPES.has(typeKey)) continue; // G3 exclude
    eligible.push({
      wallet: w.wallet,
      funder: f.funder,
      fundingTime: f.fundingTime,
      entryTime: w.entryTime,
      supplyShare: w.supplyShare ?? null,
    });
  }

  // Group eligible wallets by common funder (the coordination anchor).
  const groups = new Map<string, Eligible[]>();
  for (const e of eligible) {
    const g = groups.get(e.funder);
    if (g) g.push(e);
    else groups.set(e.funder, [e]);
  }

  // Keep only groups at or above MIN_CLUSTER; pick the largest (deterministic
  // tie-break by funder string) as the strongest cluster for V1.
  let best: { funder: string; members: Eligible[] } | null = null;
  for (const [funder, members] of groups) {
    if (members.length < thresholds.minCluster) continue;
    if (
      best === null ||
      members.length > best.members.length ||
      (members.length === best.members.length && funder < best.funder)
    ) {
      best = { funder, members };
    }
  }

  if (best === null) {
    // No qualifying group. If we lost wallets only to insufficient funding,
    // surface INSUFFICIENT (case B family); otherwise genuine NONE.
    return none(sawInsufficientFunding ? "INSUFFICIENT" : "NONE");
  }

  const members = best.members;
  const memberAddrs = members.map((m) => m.wallet);

  const fundingTimes = members
    .map((m) => m.fundingTime)
    .filter((t): t is number => t !== null);
  const entryTimes = members
    .map((m) => m.entryTime)
    .filter((t): t is number => t !== null);

  const fundingComplete = fundingTimes.length === members.length;
  const entryComplete = entryTimes.length === members.length;

  const fundingWindowSec = fundingComplete ? windowSec(fundingTimes) : null;
  const entryWindowSec = entryComplete ? windowSec(entryTimes) : null;

  const supplyShares = members
    .map((m) => m.supplyShare)
    .filter((s): s is number => s !== null);
  const supplyInvolved =
    supplyShares.length === members.length
      ? supplyShares.reduce((a, b) => a + b, 0)
      : null;

  const fundingTight =
    fundingWindowSec !== null &&
    fundingWindowSec <= thresholds.fundingWindowTightSec;
  const entryTight =
    entryWindowSec !== null && entryWindowSec <= thresholds.entryWindowTightSec;

  const evidence: Evidence[] = ["COMMON_FUNDER"];
  if (fundingTight) evidence.push("FUNDING_PROXIMITY");
  if (entryTight) evidence.push("ENTRY_PROXIMITY");
  if (members.length >= 4) evidence.push("CLUSTER_SIZE");

  // linkStrength — placeholder thresholds (NOT calibrated).
  let linkStrength: LinkStrength;
  if (fundingTight && entryTight && members.length >= 4) linkStrength = "HIGH";
  else if (fundingTight || entryTight) linkStrength = "MEDIUM";
  else linkStrength = "LOW";

  // status: entry present + tight → OBSERVED; funder present, entry null → CANDIDATE.
  // G4: entry-null never yields NONE and never OBSERVED.
  const status: CoordinationObservation["status"] = entryComplete
    ? "OBSERVED"
    : "CANDIDATE";

  const cluster: LinkedWalletCluster = {
    fundingAnchor: best.funder,
    members: memberAddrs,
    commonFunder: true,
    fundingWindowSec,
    entryWindowSec,
    supplyInvolved,
    evidence,
    linkStrength,
  };

  return {
    token,
    cluster,
    status,
    linkStrength,
    observedAt,
    thresholdsCalibrated: false,
  };
}
