/**
 * WAR hardening layer (Phase 7) - transport resilience + operational safety.
 * Composes over existing primitives (rate limiter, error taxonomy) without
 * touching intelligence, config, or the adapter's sealed behaviour.
 */
export * from "./retryPolicy.js";
export * from "./guards.js";
export * from "./classify.js";
export {
  ResilientCliExecutor,
  NOOP_OBSERVER,
  DEFAULT_RESILIENT_CONFIG,
  type TimeProvider,
  type Observer,
  type ResilientConfig,
  type ResilientDeps,
} from "./ResilientCliExecutor.js";
