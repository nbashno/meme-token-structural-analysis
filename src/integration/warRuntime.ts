/**
 * WAR integration — production composition root.
 *
 * The single place that assembles the whole live stack into a runnable surface:
 *
 *   GmgnCliExecutor (live gmgn-cli)  ── the only prod/test-varying dependency
 *     -> createScanService (existing)          scan pipeline
 *     -> MonitoringService (existing)          monitor pipeline
 *       -> ArenaSession (existing)             one read-only wiring surface
 *         -> createApp (API layer)             HTTP router over the session
 *
 * This is a WIRING root, not intelligence: it constructs objects and injects
 * dependencies. It computes no Power/Threat, invents no field, and imports no
 * scoring config. The determinism rule that binds src/core does not bind a
 * composition root — a root is where real clocks and real executors are chosen.
 *
 * Injecting a real GmgnCliExecutor makes this a fully LIVE pipeline. Injecting a
 * stub CliExecutor (in tests) exercises the same chain minus the network.
 */

import type { CliExecutor } from "../adapters/gmgn/gmgnRunner.js";
import type { Clock } from "../product/domain/identity.js";
import { EntitlementLedger } from "../product/payment/entitlement.js";
import { BalanceLedger } from "../product/payment/balance.js";
import { ConsentLedger } from "../product/legal/consent.js";
import { PricingService, PRICING_V2 } from "../product/pricing/pricing.js";
import { PromotionPolicy, parseFreeUntil } from "../product/pricing/promotion.js";
import { InMemoryUsageStore, type UsageStore } from "../product/pricing/usageStore.js";
import { InMemoryReferralStore, type ReferralStore } from "../product/referral/referralStore.js";
import { InMemoryWalletWatchStore, type WalletWatchStore } from "../product/watch/walletWatchStore.js";
import { InMemoryFounderFollowerStore, type FounderFollowerStore } from "../product/founder/founderFollowerStore.js";
import { InMemoryPerfObservationStore, type PerfObservationStore } from "../product/intel/perfObservationStore.js";
import { UnavailableNotificationChannel, type NotificationChannel } from "../arena/shareAndNotify.js";
import { MembershipGate, telegramMembershipChecker, type MembershipChecker } from "../product/legal/membershipGate.js";
import { TrendingCache, DEFAULT_TRENDING_TTL_MS, type AddressSource, type TrendingToken } from "../product/trending/trendingCache.js";
import { gmgnTrendingSource, parseTrendingRank, rowToWorldState } from "./gmgnTrendingSource.js";
type RankRow = Parameters<typeof rowToWorldState>[0];
import { trendingArgv } from "../adapters/gmgn/gmgnRunner.js";
import type { Chain } from "../shared/scalars.js";
import { AccountProfileService } from "../product/account/accountProfile.js";
import { PaymentWebhookService } from "../product/payment/paymentWebhook.js";
import { InMemoryUnitOfWork } from "../product/persistence/memory/inMemory.js";
import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../config/versions.js";
import { createScanService } from "./scanComposition.js";
import { MonitoringService } from "./MonitoringService.js";
import { RealGmgnAcquisitionPort, DEFAULT_ACQUISITION_CONFIG, type AcquisitionConfig } from "./RealGmgnAcquisitionPort.js";
import { RealWarEvaluationPort } from "./RealWarEvaluationPort.js";
import { ArenaSession } from "../arena/ArenaSession.js";
import type { WorldState } from "../world/worldAdapter.js";
import { GmgnCliExecutor } from "./GmgnCliExecutor.js";

/** A real wall-clock. Lives at the root only — never inside src/core. */
export function systemClock(): Clock {
  return { now: () => Date.now() };
}

export interface RootConfig {
  /** Live executor (default: a real GmgnCliExecutor). Override in tests. */
  readonly cliExecutor?: CliExecutor;
  readonly clock?: Clock;
  /** Injectable persistence. Defaults to in-memory; server injects PgUnitOfWork
   *  when DATABASE_URL is set so data survives restarts (scale-to-zero). */
  readonly uow?: UnitOfWork;
  /** Injectable daily-usage store. Defaults to in-memory; server injects the
   *  Postgres-backed store when DATABASE_URL is set so quotas survive restarts. */
  readonly usageStore?: UsageStore;
  /** Injectable referral store. Defaults to in-memory; server injects Postgres. */
  readonly referralStore?: ReferralStore;
  /** Injectable wallet-watch store. Defaults to in-memory; server injects Postgres. */
  readonly walletWatchStore?: WalletWatchStore;
  /** Injectable founder-follower store. Defaults to in-memory; server injects Postgres. */
  readonly founderFollowerStore?: FounderFollowerStore;
  /** Injectable perf-observation store (WAR INTEL). Defaults to in-memory. */
  readonly perfObservationStore?: PerfObservationStore;
  /** Injectable notification channel. Defaults to Unavailable (no delivery). */
  readonly notificationChannel?: NotificationChannel;
  readonly acquisitionConfig?: AcquisitionConfig;
  /** Launch free-window cutoff (ISO string). All ops free until then. */
  readonly freeUntil?: string | undefined;
  /** Required Telegram channel for operations (@username or id). */
  readonly requiredChannel?: string | undefined;
  /** Bot token to build the real membership checker (deploy). */
  readonly botToken?: string | undefined;
  /** Override the membership checker (tests inject a stub). */
  readonly membershipChecker?: MembershipChecker;
  /** Seed list of tokens to feature in the arena until a confirmed trending feed is wired. */
  readonly trendingSeed?: readonly TrendingToken[];
  /** Override the trending address source (tests). */
  readonly trendingSource?: AddressSource;
  /** Trending cache TTL in ms (default 4h). */
  readonly trendingTtlMs?: number;
  /** Max trending tokens to pull per chain (default 6). */
  readonly trendingLimitPerChain?: number;
}

export interface WarRuntime {
  readonly arena: ArenaSession;
  readonly entitlements: EntitlementLedger;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly balances: BalanceLedger;
  readonly consent: ConsentLedger;
  readonly pricing: PricingService;
  readonly account: AccountProfileService;
  readonly payments: PaymentWebhookService;
  readonly promotion: PromotionPolicy;
  readonly usage: UsageStore;
  readonly referrals: ReferralStore;
  readonly walletWatch: WalletWatchStore;
  readonly founderFollowers: FounderFollowerStore;
  readonly perfObservations: PerfObservationStore;
  readonly notificationChannel: NotificationChannel;
  readonly membership: MembershipGate;
  readonly trending: TrendingCache<WorldState>;
}

/**
 * Build the full runtime. By default this is LIVE: it spawns gmgn-cli. Persistence
 * defaults to in-memory (swap for pg by injecting a different UnitOfWork once a
 * live DB is wired). Payment uses a real EntitlementLedger; issuing entitlements
 * still requires verified payments upstream — nothing is faked here.
 */
export function createWarRuntime(config: RootConfig = {}): WarRuntime {
  const cliExecutor = config.cliExecutor ?? new GmgnCliExecutor();
  const clock = config.clock ?? systemClock();
  const uow = config.uow ?? new InMemoryUnitOfWork();
  const entitlements = new EntitlementLedger();

  const scanService = createScanService({
    uow,
    clock,
    entitlements,
    engineVersion: ENGINE_VERSION,
    modelVersions: MODEL_VERSIONS,
    cliExecutor,
    acquisitionConfig: config.acquisitionConfig ?? DEFAULT_ACQUISITION_CONFIG,
  });

  const monitoringService = new MonitoringService({
    acquisition: new RealGmgnAcquisitionPort(cliExecutor, config.acquisitionConfig ?? DEFAULT_ACQUISITION_CONFIG),
    evaluation: new RealWarEvaluationPort(),
    clock,
  });

  const arena = new ArenaSession({ scanService, monitoringService, uow });

  // Product layers (accounts, money, consent) — wired for the API.
  const balances = new BalanceLedger();
  const consent = new ConsentLedger();
  const pricing = new PricingService(PRICING_V2);
  const account = new AccountProfileService(balances, uow.repos.monitors, pricing);
  const payments = new PaymentWebhookService(balances, pricing);
  const promotion = new PromotionPolicy({ freeUntilMs: parseFreeUntil(config.freeUntil) });
  const usage = config.usageStore ?? new InMemoryUsageStore();
  const referrals = config.referralStore ?? new InMemoryReferralStore();
  const walletWatch = config.walletWatchStore ?? new InMemoryWalletWatchStore();
  const founderFollowers = config.founderFollowerStore ?? new InMemoryFounderFollowerStore();
  const perfObservations = config.perfObservationStore ?? new InMemoryPerfObservationStore();
  const notificationChannel = config.notificationChannel ?? new UnavailableNotificationChannel();
  const membershipChecker: MembershipChecker =
    config.membershipChecker ?? (config.botToken ? telegramMembershipChecker(config.botToken) : async () => null);
  const membership = new MembershipGate({ requiredChannel: config.requiredChannel }, membershipChecker);

  // Trending cache — the arena's opening "top battles" view. Browsing is free.
  // Real source: `gmgn-cli market trending` per chain returns the trending list
  // AND all display stats in one call, so no per-token scan is needed. If a
  // custom source is injected (tests) it wins; otherwise we build the live one.
  const trendingLimit = config.trendingLimitPerChain ?? 6;
  const gmgnRun = async (chain: Chain): Promise<readonly RankRow[] | null> => {
    try {
      const out = await cliExecutor.run(trendingArgv(chain, "1h"));
      if (out.exitCode !== 0) return null;
      const json = JSON.parse(out.stdout) as unknown;
      return parseTrendingRank(json);
    } catch {
      return null;
    }
  };
  const built = config.trendingSource
    ? { source: config.trendingSource, evaluate: async (_t: TrendingToken) => null as WorldState | null }
    : gmgnTrendingSource(gmgnRun, trendingLimit);
  const trending = new TrendingCache<WorldState>(
    { ttlMs: config.trendingTtlMs ?? DEFAULT_TRENDING_TTL_MS },
    built.source,
    async (t) => built.evaluate(t),
  );

  return { arena, entitlements, uow, clock, balances, consent, pricing, account, payments, promotion, usage, referrals, walletWatch, founderFollowers, perfObservations, notificationChannel, membership, trending };
}
