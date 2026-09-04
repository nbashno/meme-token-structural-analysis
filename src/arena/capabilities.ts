/**
 * WAR arena - Capability status (Phase 3).
 *
 * The single, honest source of every feature's real state. The UI renders these
 * verbatim — it never converts one status into another to look complete. This is
 * the enforcement of the non-negotiable rule: unavailable stays unavailable.
 */

export type CapabilityState =
  | "VERIFIED"
  | "AVAILABLE"
  | "BLOCKED_BY_CONTRACT"
  | "BLOCKED_BY_HISTORY_READ_CONTRACT"
  | "BLOCKED_BY_SEARCH_CONTRACT"
  | "BLOCKED_BY_GMGN_CLI"
  | "PENDING_BROWSER_BENCH"
  | "REQUIRES_EXTERNAL_ENVIRONMENT"
  | "NOT_IMPLEMENTED";

export interface Capability {
  readonly key: string;
  readonly state: CapabilityState;
  readonly note: string;
}

/**
 * The authoritative capability map for this build. Each entry reflects what was
 * actually verified from source in PHASE_3_PREBUILD_AUDIT — nothing is upgraded
 * for presentation.
 */
export const CAPABILITIES: readonly Capability[] = [
  { key: "scan", state: "VERIFIED", note: "$0.10 scan: acquisition->WAR->report->persist->consume" },
  { key: "monitoring", state: "VERIFIED", note: "T0->T1->T2 ticks, expiry, carry, alerts" },
  { key: "payment", state: "VERIFIED", note: "reserve/consume/release, idempotent, no double-spend" },
  { key: "hardening", state: "VERIFIED", note: "retry/timeout/breaker/kill/cost over CLI" },
  { key: "world", state: "VERIFIED", note: "adapter/engine/instances/camera/LOD/streaming" },
  { key: "alerts_storage", state: "AVAILABLE", note: "AlertService + AlertRepository store/list" },
  { key: "search", state: "AVAILABLE", note: "TokenRepository.searchByText (Phase 3 read contract added)" },
  { key: "replay", state: "AVAILABLE", note: "MonitoringObservationRepository.list (Phase 3 read contract added)" },
  { key: "share_card", state: "AVAILABLE", note: "deterministic projection of WorldState" },
  { key: "notifications_delivery", state: "AVAILABLE", note: "DeliveryChannel contract + dispatcher; concrete channel wired at deploy" },
  { key: "auth_identity", state: "VERIFIED", note: "Telegram initData HMAC verification + identity mapping + middleware" },
  { key: "social", state: "NOT_IMPLEMENTED", note: "no social persistence contract exists" },
  { key: "hunter_profile_scores", state: "NOT_IMPLEMENTED", note: "no reputation calculation contract exists" },
  { key: "sponsorship", state: "NOT_IMPLEMENTED", note: "SPONSORSHIP_BACKEND_UNAVAILABLE" },
  { key: "http_api", state: "VERIFIED", note: "node:http router + wired app (auth/billing/consent/webhooks)" },
  { key: "deployment", state: "AVAILABLE", note: "Dockerfile + env schema + server entry + health + CI" },
  { key: "gmgn_live", state: "VERIFIED", note: "GmgnCliExecutor spawns gmgn-cli; end-to-end verified" },
  { key: "billing_balance", state: "VERIFIED", note: "BalanceLedger: free grant, atomic debit, refund, top-up, tiers" },
  { key: "consent", state: "VERIFIED", note: "ConsentLedger: versioned, timestamped, auditable" },
  { key: "security", state: "VERIFIED", note: "rate limiter + CORS + security headers + structured logger" },
  { key: "browser_benchmark", state: "PENDING_BROWSER_BENCH", note: "no GPU/WebGL/DOM in this env" },
];

export function capability(key: string): Capability {
  return CAPABILITIES.find((c) => c.key === key) ?? { key, state: "NOT_IMPLEMENTED", note: "unknown capability" };
}

/** True only for states a user can actually use right now. */
export function isUsable(state: CapabilityState): boolean {
  return state === "VERIFIED" || state === "AVAILABLE";
}
