/**
 * WAR Product Layer - Phase 1 - public barrel.
 *
 * Everything the future Product API / UI consumes is re-exported here. The
 * Product Layer sits ABOVE WAR Core: it imports Core CONTRACTS only (from the
 * public barrel or Core type modules), never Core internals' logic, never
 * adapters' raw shapes, never a renderer.
 */

export * from "./domain/identity.js";
export * from "./pricing/pricing.js";
export * from "./payment/payment.js";
export * from "./payment/entitlement.js";
export * from "./intelligence/report.js";
export * from "./intelligence/alerts.js";
export * from "./persistence/index.js";

// scan and monitor both define a `canTransition` guard for their own state
// machines; namespace them so the collision is explicit, not accidental.
export * as scan from "./scan/scan.js";
export * as monitor from "./monitor/monitor.js";
export * from "./scan/ports/ports.js";
export * from "./scan/orchestration/scanService.js";
