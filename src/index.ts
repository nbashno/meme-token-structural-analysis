/**
 * WAR core — public type surface (Phase 2).
 *
 * The complete frozen V3.2 intelligence contract, expressed as TypeScript types.
 * No runtime implementation yet. Consumers (adapters, physics, replay, tests)
 * import domain types from here.
 */

export type * from "./shared/index.js";
export type * from "./core/timeline/index.js";
export type * from "./core/temporal/index.js";
export type * from "./core/coherence/index.js";
export type * from "./core/power/index.js";
export type * from "./core/state/index.js";
export type * from "./core/battlefield/index.js";

/**
 * Phase 1 (Product Layer, B1 = Option A): the public barrel exposes the ONE
 * legitimate entry point the Product Layer consumes — assembleBattlefield — plus
 * its public input contracts. This is a re-export ONLY. No algorithm, scoring,
 * physics, signal, timeline, replay, outcome, or adapter behaviour is modified.
 *
 * The Product Layer imports assembleBattlefield and these contracts exclusively
 * from "war-engine" (this barrel); it never reaches into src/core/** internals.
 */
export {
  assembleBattlefield,
} from "./core/battlefield/assembleBattlefield.js";
export type {
  AssemblyInput,
  TokenAssemblyInput,
} from "./core/battlefield/assembleBattlefield.js";

/** Version stamp is public so Product persistence can pin every stored result. */
export { MODEL_VERSIONS, ENGINE_VERSION } from "./config/versions.js";
