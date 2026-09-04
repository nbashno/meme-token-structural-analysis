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
  featureModelVersion: "feature-v1",
  activationModelVersion: "activation-v1",
  confidenceModelVersion: "confidence-v2",
};
