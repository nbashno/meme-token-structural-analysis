/**
 * WAR Product Layer - Phase 1 - Pricing.
 *
 * Prices are VERSIONED and CONFIGURABLE - never hardcoded into business logic.
 * Commercial config (spec sec.10, sec.12):
 *   1 TOKEN_SCAN        = $0.10
 *   1 TOKEN_MONITOR_24H = $1.00 / 24h
 *
 * PricingService resolves a capability to a USD-canonical amount at a pinned
 * pricing version. Payment adapters (Stars/TON) convert USD -> their native unit;
 * conversion logic lives at the adapter, never scattered through the app.
 */

import type { UsdMicros } from "../domain/identity.js";
import { usd } from "../domain/identity.js";

export type EntitlementType =
  | "TOKEN_SCAN"
  | "TOKEN_MONITOR_24H"
  | "PRO_ACCESS"
  | "WALLET_WATCH_MONTHLY";

/** Prepaid credit packs (top-ups). Each grants balance + an optional bonus. */
export type CreditPack = "PACK_SMALL" | "PACK_MEDIUM" | "PACK_LARGE" | "PACK_COMMAND";

export interface CreditPackConfig {
  /** What the user pays. */
  readonly priceMicros: UsdMicros;
  /** Bonus credit added on top of the paid amount. */
  readonly bonusMicros: UsdMicros;
  /** If set, buying this pack also upgrades the account to this tier. */
  readonly grantsTier?: "COMMAND";
}

/** Per-tier limits — read when enforcing caps. NOT intelligence, just policy. */
export interface TierLimits {
  /** Max concurrent active monitors. null = unlimited. */
  readonly maxConcurrentMonitors: number | null;
  /** How many stored alerts the user can list. null = unlimited. */
  readonly alertsHistory: number | null;
  /** Whether share cards are watermark-free. */
  readonly cleanShareCards: boolean;
  /** Whether replay can read full history (vs last scan only). */
  readonly fullReplay: boolean;
  /** Max scans per rolling 24h. null = unlimited. Protects free resources. */
  readonly dailyScans: number | null;
  /** Max new monitors started per rolling 24h. null = unlimited. */
  readonly dailyMonitors: number | null;
}

export interface PricingConfig {
  readonly version: string;
  readonly prices: Readonly<Record<EntitlementType, UsdMicros>>;
  /** Monitor duration, in ms, that a TOKEN_MONITOR_24H entitlement grants. */
  readonly monitorDurationMs: number;
  readonly packs: Readonly<Record<CreditPack, CreditPackConfig>>;
  readonly tierLimits: Readonly<Record<"STANDARD" | "COMMAND", TierLimits>>;
}

/** The initial commercial config (v1) — unchanged, kept for provenance/tests. */
export const PRICING_V1: PricingConfig = {
  version: "pricing-v1",
  prices: {
    TOKEN_SCAN: usd(0.1),
    TOKEN_MONITOR_24H: usd(1.0),
    PRO_ACCESS: usd(0.0),
    WALLET_WATCH_MONTHLY: usd(9.99),
  },
  monitorDurationMs: 24 * 60 * 60 * 1000,
  packs: {
    PACK_SMALL: { priceMicros: usd(5), bonusMicros: usd(0) },
    PACK_MEDIUM: { priceMicros: usd(20), bonusMicros: usd(1) },
    PACK_LARGE: { priceMicros: usd(50), bonusMicros: usd(5) },
    PACK_COMMAND: { priceMicros: usd(1000), bonusMicros: usd(200), grantsTier: "COMMAND" },
  },
  tierLimits: {
    STANDARD: { maxConcurrentMonitors: 3, alertsHistory: 50, cleanShareCards: false, fullReplay: false, dailyScans: 20, dailyMonitors: 3 },
    COMMAND: { maxConcurrentMonitors: null, alertsHistory: null, cleanShareCards: true, fullReplay: true, dailyScans: null, dailyMonitors: null },
  },
};

/** Current commercial config (v2): adds credit packs + COMMAND tier. */
export const PRICING_V2: PricingConfig = {
  ...PRICING_V1,
  version: "pricing-v2",
};

export class PricingService {
  private readonly config: PricingConfig;

  constructor(config: PricingConfig = PRICING_V2) {
    this.config = config;
  }

  get version(): string {
    return this.config.version;
  }

  priceOf(type: EntitlementType): UsdMicros {
    return this.config.prices[type];
  }

  monitorDurationMs(): number {
    return this.config.monitorDurationMs;
  }

  packConfig(pack: import("./pricing.js").CreditPack): CreditPackConfig {
    return this.config.packs[pack];
  }

  tierLimits(tier: "STANDARD" | "COMMAND"): TierLimits {
    return this.config.tierLimits[tier];
  }

  /** Full snapshot, so a persisted record can pin the exact pricing used. */
  snapshot(): PricingConfig {
    return this.config;
  }
}

// ============================================================================
// Wallet-Watch subscription tiers.
// ----------------------------------------------------------------------------
// A subscription unlocks a QUOTA of watched wallets — adding a wallet within the
// quota is free. This is deliberate: Alpha Convergence only fires when a user
// watches SEVERAL wallets, so per-wallet pricing would starve the flagship
// feature. Tiers let casual users try (Free = 1) while serious traders unlock
// the convergence signal (Pro = 10) and power users scale up (Elite = 50).
// ============================================================================

export type WatchTier = "FREE" | "PRO" | "ELITE";

export interface WatchTierPlan {
  readonly tier: WatchTier;
  readonly priceUsd: number;      // monthly, USD (0 = free)
  readonly maxWallets: number;    // concurrent watched-wallet quota
  readonly label: string;
}

export const WATCH_TIERS: Readonly<Record<WatchTier, WatchTierPlan>> = {
  FREE:  { tier: "FREE",  priceUsd: 0,     maxWallets: 1,  label: "Free" },
  PRO:   { tier: "PRO",   priceUsd: 9.99,  maxWallets: 10, label: "Pro" },
  ELITE: { tier: "ELITE", priceUsd: 29.99, maxWallets: 50, label: "Elite" },
};

/** Resolve a tier from its id, defaulting to FREE for unknown/absent values. */
export function watchTierOf(id: string | null | undefined): WatchTierPlan {
  if (id === "PRO") return WATCH_TIERS.PRO;
  if (id === "ELITE") return WATCH_TIERS.ELITE;
  return WATCH_TIERS.FREE;
}
