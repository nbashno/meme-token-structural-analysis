/**
 * WAR INTEL — collector + card builder.
 *
 * COLLECTOR: given a set of trending tokens, pulls each token's top traders
 * (by realized profit, API-key only) and records them as performance
 * observations. Runs in the background on a schedule; the dataset accumulates.
 *
 * BUILDER: reads the accumulated observations, calibrates anti-gaming
 * thresholds from the real distribution, and assembles the WAR INTEL cards
 * (biggest realized profit, biggest realized ROI, biggest token move, wallet in
 * focus, and — once enough history exists — repeat performer).
 *
 * Every field is REAL. Nothing is invented. An extreme ROI is labelled an
 * outlier, never hidden or capped. Cards missing required data are omitted.
 */

import type { PerfObservationStore, PerfObservation } from "./perfObservationStore.js";
import { calibrate, type CalibrationConfig, DEFAULT_CALIBRATION } from "./calibration.js";

// -- Collector ---------------------------------------------------------------

/** One trending token to harvest traders from. */
export interface TrendingRef {
  readonly chain: string;
  readonly address: string;
  readonly symbol: string | null;
  readonly priceChange1hPct: number | null;  // for the BIGGEST MOVE card
}

/** Pulls top traders for a token (injected — network lives outside). */
export type TopTradersFetcher = (
  chain: string, tokenAddress: string,
) => Promise<readonly {
  wallet: string; realizedProfit: number; realizedRoi: number | null;
  costUsd: number; walletTag: string | null;
}[]>;

export interface CollectorDeps {
  readonly store: PerfObservationStore;
  readonly fetchTopTraders: TopTradersFetcher;
  readonly now: () => number;
  /** Max tokens to process per tick (batch). Keeps each tick fast under
   *  scale-to-zero + serial CLI calls. Default 5. */
  readonly maxTokensPerTick?: number;
  /** Per-token timeout (ms) so one slow CLI call can't hang the whole tick. */
  readonly perTokenTimeoutMs?: number;
}

/** Race a promise against a timeout; resolves to null on timeout. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Harvest observations from a batch of trending tokens into the store. */
export async function collectObservations(
  deps: CollectorDeps, tokens: readonly TrendingRef[],
): Promise<{ tokensProcessed: number; observationsRecorded: number }> {
  const nowMs = deps.now();
  const batchSize = deps.maxTokensPerTick ?? 3;
  const timeoutMs = deps.perTokenTimeoutMs ?? 8000;
  // Rotate which tokens we harvest each tick using a time-based offset, so over
  // several ticks the whole trending set is covered without any single tick
  // making 20 serial CLI calls.
  const offset = tokens.length ? Math.floor(nowMs / 60000) % tokens.length : 0;
  const batch: TrendingRef[] = [];
  for (let i = 0; i < Math.min(batchSize, tokens.length); i++) {
    batch.push(tokens[(offset + i) % tokens.length]!);
  }

  let recorded = 0, processed = 0;
  for (const t of batch) {
    try {
      const traders = await withTimeout(deps.fetchTopTraders(t.chain, t.address), timeoutMs);
      if (!traders) continue; // timed out — skip this token, keep the tick moving
      processed++;
      for (const tr of traders) {
        if (!Number.isFinite(tr.realizedProfit) || !Number.isFinite(tr.costUsd)) continue;
        const obs: PerfObservation = {
          chain: t.chain, wallet: tr.wallet, token: t.address, tokenSymbol: t.symbol,
          realizedProfit: tr.realizedProfit,
          realizedRoi: Number.isFinite(tr.realizedRoi as number) ? tr.realizedRoi : null,
          costUsd: tr.costUsd, walletTag: tr.walletTag,
          source: "gmgn:token_top_traders", observedAt: nowMs,
        };
        await deps.store.record(obs);
        recorded++;
      }
    } catch { /* one token failing must not abort the batch */ }
  }
  return { tokensProcessed: processed, observationsRecorded: recorded };
}

// -- Builder -----------------------------------------------------------------

export type IntelCardType =
  | "biggest_realized_profit" | "biggest_realized_roi"
  | "biggest_move" | "wallet_in_focus" | "repeat_performer";

/** Classify entry-size conviction from average entry cost. */
function convictionOf(avgEntry: number | null): NonNullable<IntelCard["walletDna"]>["conviction"] {
  if (avgEntry == null) return "UNKNOWN";
  if (avgEntry >= 100000) return "WHALE";
  if (avgEntry >= 10000) return "SERIOUS";
  if (avgEntry >= 1000) return "MODERATE";
  return "SMALL";
}

/**
 * Compute WALLET DNA from WAR's own accumulated observations of a wallet.
 * Unique to WAR: a cross-token, cross-day performance fingerprint. Honest about
 * sample size — a single sighting is never "proven".
 */
async function walletDna(store: PerfObservationStore, chain: string, wallet: string): Promise<NonNullable<IntelCard["walletDna"]>> {
  const obs = await store.observationsForWallet(chain, wallet);
  const seenCount = obs.length;
  const tokens = new Set(obs.map((o) => o.token)).size;
  const wins = obs.filter((o) => o.realizedProfit > 0).length;
  const winRate = seenCount ? wins / seenCount : null;
  const costs = obs.map((o) => o.costUsd).filter((c) => c > 0);
  const avgEntry = costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : null;
  return {
    seenCount, tokensTraded: tokens, winRate, avgEntryUsd: avgEntry,
    proven: seenCount >= 3 && tokens >= 2,
    conviction: convictionOf(avgEntry),
  };
}

/** Enrich a wallet card with exit value, ROI %, and DNA. */
async function enrichWalletCard(store: PerfObservationStore, card: IntelCard): Promise<IntelCard> {
  const exit = (card.costUsd != null && card.realizedProfitUsd != null)
    ? card.costUsd + card.realizedProfitUsd : undefined;
  const roiPct = card.realizedRoi != null ? card.realizedRoi * 100 : undefined;
  const dna = card.wallet ? await walletDna(store, card.chain, card.wallet) : undefined;
  return { ...card, ...(exit != null ? { exitUsd: exit } : {}), ...(roiPct != null ? { roiPct } : {}), ...(dna ? { walletDna: dna } : {}) };
}

/** Classify a realized ROI into an honest tier (never call it ALPHA lightly). */
export function roiTier(roi: number | null): "EXTREME_OUTLIER" | "HIGH" | "SOLID" | "MODEST" | "UNKNOWN" {
  if (roi == null) return "UNKNOWN";
  if (roi >= 50) return "EXTREME_OUTLIER";   // >= 50x
  if (roi >= 2) return "HIGH";               // >= 200%
  if (roi >= 0.5) return "SOLID";            // >= 50%
  return "MODEST";
}

export interface IntelCard {
  readonly type: IntelCardType;
  readonly chain: string;
  readonly wallet?: string;
  readonly token?: string;
  readonly symbol?: string | null;
  readonly realizedProfitUsd?: number;
  readonly realizedRoi?: number | null;      // exact, never capped
  readonly costUsd?: number;
  /** Derived exit value = cost + realized profit (what they took out). */
  readonly exitUsd?: number;
  /** ROI as a percentage (realizedRoi * 100), for display. */
  readonly roiPct?: number | null;
  readonly priceChange1hPct?: number | null;
  readonly roiTier?: string;
  readonly observations?: number;            // for repeat_performer
  readonly tokens?: number;
  readonly walletTag?: string | null;
  /**
   * WALLET DNA — a fingerprint computed ONLY from WAR's own accumulated
   * observations of this wallet. Unique to WAR because no one else keeps a
   * cross-token, cross-day performance memory. Honest about sample size.
   */
  readonly walletDna?: {
    readonly seenCount: number;        // how many times WAR observed this wallet
    readonly tokensTraded: number;     // distinct tokens
    readonly winRate: number | null;   // fraction of observations in profit
    readonly avgEntryUsd: number | null;
    readonly proven: boolean;          // seenCount >= 3 across >= 2 tokens
    readonly conviction: "WHALE" | "SERIOUS" | "MODERATE" | "SMALL" | "UNKNOWN";
  };
}

export interface IntelBriefing {
  readonly generatedAt: number;
  readonly cards: readonly IntelCard[];
  readonly calibration: {
    readonly minCostUsd: number;
    readonly minRealizedProfitUsd: number;
    readonly totalObservations: number;
    readonly confidence: string;
  };
}

export interface BuilderConfig {
  readonly calibration?: CalibrationConfig;
  readonly repeatPerformerMinObservations: number;  // e.g. 3
  readonly maxObservationsScan: number;              // bound the read
}

export const DEFAULT_BUILDER: BuilderConfig = {
  repeatPerformerMinObservations: 3,
  maxObservationsScan: 20000,
};

/**
 * Build the WAR INTEL briefing from accumulated observations + a fresh trending
 * snapshot (for the market-move card). Calibrates thresholds, then assembles
 * only cards that have real, complete data.
 */
export async function buildBriefing(
  store: PerfObservationStore,
  trending: readonly TrendingRef[],
  nowMs: number,
  cfg: BuilderConfig = DEFAULT_BUILDER,
): Promise<IntelBriefing> {
  const all = await store.all(cfg.maxObservationsScan);
  const cal = calibrate(all, cfg.calibration ?? DEFAULT_CALIBRATION);
  const filter = { minCostUsd: cal.minCostUsd, minRealizedProfitUsd: cal.minRealizedProfitUsd };
  const cards: IntelCard[] = [];

  // 1) BIGGEST REALIZED PROFIT
  const [topProfit] = await store.topByProfit(filter, 1);
  if (topProfit) {
    cards.push({
      type: "biggest_realized_profit", chain: topProfit.chain, wallet: topProfit.wallet,
      token: topProfit.token, symbol: topProfit.tokenSymbol,
      realizedProfitUsd: topProfit.realizedProfit, realizedRoi: topProfit.realizedRoi,
      costUsd: topProfit.costUsd, roiTier: roiTier(topProfit.realizedRoi),
      walletTag: topProfit.walletTag,
    });
  }

  // 2) BIGGEST REALIZED ROI (post-filter, so no sub-lottery dust)
  const [topRoi] = await store.topByRoi(filter, 1);
  if (topRoi) {
    cards.push({
      type: "biggest_realized_roi", chain: topRoi.chain, wallet: topRoi.wallet,
      token: topRoi.token, symbol: topRoi.tokenSymbol,
      realizedProfitUsd: topRoi.realizedProfit, realizedRoi: topRoi.realizedRoi,
      costUsd: topRoi.costUsd, roiTier: roiTier(topRoi.realizedRoi),
      walletTag: topRoi.walletTag,
    });
  }

  // 3) BIGGEST MOVE (from the live trending snapshot; market data, not wallet)
  const moves = trending.filter((t) => t.priceChange1hPct != null)
    .sort((a, b) => (b.priceChange1hPct ?? 0) - (a.priceChange1hPct ?? 0));
  if (moves[0]) {
    cards.push({
      type: "biggest_move", chain: moves[0].chain, token: moves[0].address,
      symbol: moves[0].symbol, priceChange1hPct: moves[0].priceChange1hPct,
    });
  }

  // 4) WALLET IN FOCUS — the top-profit wallet, framed as a wallet (discovery
  //    hook for Wallet Watch). Only if we have one.
  if (topProfit) {
    cards.push({
      type: "wallet_in_focus", chain: topProfit.chain, wallet: topProfit.wallet,
      token: topProfit.token, symbol: topProfit.tokenSymbol,
      realizedProfitUsd: topProfit.realizedProfit, realizedRoi: topProfit.realizedRoi,
      roiTier: roiTier(topProfit.realizedRoi), walletTag: topProfit.walletTag,
    });
  }

  // 5) REPEAT PERFORMER — only when enough history exists (omit otherwise).
  const repeats = await store.repeatPerformers(cfg.repeatPerformerMinObservations, filter, 1);
  if (repeats[0]) {
    const rp = repeats[0];
    cards.push({
      type: "repeat_performer", chain: rp.chain, wallet: rp.wallet,
      realizedProfitUsd: rp.totalRealizedProfit, realizedRoi: rp.maxRoi,
      roiTier: roiTier(rp.maxRoi), observations: rp.observations, tokens: rp.tokens,
    });
  }

  // Enrich wallet cards with exit value, ROI %, and unique Wallet DNA.
  const enriched = await Promise.all(cards.map((c) => enrichWalletCard(store, c)));

  return {
    generatedAt: nowMs, cards: enriched,
    calibration: {
      minCostUsd: cal.minCostUsd, minRealizedProfitUsd: cal.minRealizedProfitUsd,
      totalObservations: cal.totalObservations, confidence: cal.confidence,
    },
  };
}
