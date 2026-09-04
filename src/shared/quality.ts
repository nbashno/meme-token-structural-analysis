/**
 * WAR core — data quality + versioning (Phase 2, types only).
 */

import type { UnixMillis } from "./scalars.js";

/**
 * Data quality classification. Per V3.2: the engine must distinguish these,
 * and missing data must not silently become zero.
 */
export type DataQuality =
  | "COMPLETE"
  | "PARTIAL"
  | "STALE"
  | "CONFLICTED"
  | "INSUFFICIENT";

/**
 * Version identity stamped on every engine output so historical results stay
 * interpretable as models evolve. All fields required — an unstamped output
 * is not a valid engine output.
 */
export interface ModelVersions {
  readonly engineVersion: string;
  readonly powerModelVersion: string;
  readonly stateModelVersion: string;
  readonly physicsModelVersion: string;
  readonly configurationVersion: string;
  /** Feature-extraction layer version (SignalPoints/vectors/moves builders). */
  readonly featureModelVersion: string;
  /** Factor-activation layer version (observations -> FactorActivations). */
  readonly activationModelVersion: string;
  /** Confidence blend version (weights; measurementStability zeroed in v2). */
  readonly confidenceModelVersion: string;
}

/** A quality assessment attached to a computed value, with the moment it was assessed. */
export interface QualityStamp {
  readonly quality: DataQuality;
  readonly assessedAt: UnixMillis;
  /** Human-readable reasons the quality was classified this way (explainability). */
  readonly reasons: readonly string[];
}
