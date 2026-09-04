/**
 * WAR Integration — real GMGN trending source for the arena.
 *
 * Calls `gmgn-cli market trending --chain <c>` and reads `data.rank[]`. Each row
 * already carries the token's address, symbol, and a rich set of metrics
 * (holders, top-10 rate, market cap, liquidity, buys/sells, rug ratio, honeypot,
 * smart-money count, ...). So one call per chain yields BOTH the trending list
 * AND every stat we display — no per-token scan needed.
 *
 * DISCIPLINE:
 *  - Only fields present in the live response are surfaced. Missing → omitted,
 *    never fabricated.
 *  - Fields banned from the intelligence CORE (hot_level, bundler_rate, etc.)
 *    are NOT fed to the engine. Here we only build a DISPLAY view (WorldState +
 *    stats) for browsing — the paid scan path still runs the real engine. We
 *    deliberately do not read hot_level. bundler_rate is shown as a display-only
 *    risk hint, never as a core input.
 *  - This is a browse/preview surface (free), so it maps raw metrics to a
 *    WorldState-shaped view directly rather than invoking the deterministic core.
 */

import type { Chain } from "../shared/scalars.js";
import type { WorldState } from "../world/worldAdapter.js";
import type { TrendingToken } from "../product/trending/trendingCache.js";
import { analyze } from "../product/analysis/warIndices.js";

/** Chains to pull trending from (data-API confirmed). */
const TRENDING_CHAINS: readonly Chain[] = ["sol", "bsc", "base", "eth"];

interface RankRow {
  readonly chain?: string;
  readonly address?: string;
  readonly symbol?: string;
  readonly name?: string;
  readonly price?: number;
  readonly market_cap?: number;
  readonly liquidity?: number;
  readonly holder_count?: number;
  readonly top_10_holder_rate?: number;
  readonly swaps?: number;
  readonly buys?: number;
  readonly sells?: number;
  readonly smart_degen_count?: number;
  readonly renowned_count?: number;
  readonly rug_ratio?: number;
  readonly is_wash_trading?: boolean;
  readonly is_honeypot?: number;
  readonly is_renounced?: number;
  readonly sniper_count?: number;
  readonly dev_team_hold_rate?: number;
  readonly buy_tax?: string;
  readonly sell_tax?: string;
  readonly price_change_percent1h?: number;
  readonly price_change_percent5m?: number;
  readonly bundler_rate?: number;
  readonly volume?: number;
  readonly total_supply?: number;
  readonly history_highest_market_cap?: number;
  readonly initial_liquidity?: number;
  readonly burn_ratio?: number;
  readonly burn_status?: string;
  readonly lock_percent?: number;
  readonly is_open_source?: number;
  readonly renounced_mint?: number;
  readonly renounced_freeze_account?: number;
  readonly bluechip_owner_percentage?: number;
  readonly top70_sniper_hold_rate?: number;
  readonly bot_degen_rate?: number;
  readonly entrapment_ratio?: number;
  readonly rat_trader_amount_rate?: number;
  readonly launchpad_platform?: string;
  readonly exchange?: string;
  readonly creator?: string;
  readonly creator_token_status?: string;
  readonly twitter_username?: string;
  readonly website?: string;
  readonly telegram?: string;
  readonly creation_timestamp?: number;
  readonly price_change_percent1m?: number;
}

// Cache the last good rows per address so evaluate() can build a view without
// a second network call. Keyed by `${chain}:${address}`.
const rowCache = new Map<string, RankRow>();

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Map 1h price change + buy/sell balance into a coarse display mood. */
function deriveMood(r: RankRow): string {
  const ch = num(r.price_change_percent1h) ?? 0;
  const buys = num(r.buys) ?? 0;
  const sells = num(r.sells) ?? 0;
  const rug = num(r.rug_ratio) ?? 0;
  if (rug > 0.5) return "COLLAPSE";
  if (ch > 50 && buys > sells) return "ATTACK";
  if (ch > 10 && buys > sells) return "EMERGING";
  if (ch < -30) return "BLEEDING";
  if (ch < -8) return "DISTRIBUTION";
  if (buys > sells * 1.3) return "ACCUMULATION";
  if (Math.abs(ch) < 3 && buys + sells < 50) return "DORMANT";
  return "OBSERVING";
}

/** A hue per mood for the arena star color (display only). */
export function hueForMood(mood: string): number {
  switch (mood) {
    case "ATTACK": case "DOMINANCE": return 0.60;
    case "ACCUMULATION": return 0.45;
    case "EMERGING": return 0.55;
    case "DISTRIBUTION": return 0.11;
    case "BLEEDING": case "COLLAPSE": return 0.99;
    default: return 0.55;
  }
}

/** clamp helper -> 0..100 */
function pctScore(x: number): number { return Math.max(0, Math.min(100, Math.round(x))); }

/**
 * Build a WorldState-shaped display view from a trending row. This is a browse
 * view (free), not a core evaluation. Forces are simple, transparent projections
 * of confirmed metrics — clearly display-only, never claimed as engine output.
 */
export function rowToWorldState(r: RankRow, chain: Chain): WorldState {
  const mood = deriveMood(r);
  const buys = num(r.buys) ?? 0;
  const sells = num(r.sells) ?? 0;
  const tot = buys + sells;
  const buyRatio = tot > 0 ? buys / tot : 0.5;
  const ch1h = num(r.price_change_percent1h) ?? 0;

  // Display-only force projections (transparent):
  const attention = pctScore(Math.min(100, (num(r.swaps) ?? 0) / 200 + (num(r.smart_degen_count) ?? 0) * 2));
  const power = pctScore(buyRatio * 100 * 0.7 + Math.max(0, ch1h) * 0.3);
  const threat = pctScore((num(r.rug_ratio) ?? 0) * 60 + (num(r.top_10_holder_rate) ?? 0) * 40 + (r.is_wash_trading ? 20 : 0));
  const confidence = pctScore(100 - (num(r.rug_ratio) ?? 0) * 50 - (num(r.top_10_holder_rate) ?? 0) * 30);

  const fv = (raw: number) => ({ raw, visual01: raw / 100, band: raw >= 67 ? "HIGH" : raw >= 34 ? "MODERATE" : "LOW" });

  const addr = r.address ?? "";
  const events: WorldState["events"] =
    buys > sells * 1.5 && tot > 100 ? [{ type: "BUY_CLUSTER", importance: pctScore(buyRatio * 100), reason: "Buys dominate recent swaps" }]
    : sells > buys * 1.5 && tot > 100 ? [{ type: "SELL_CLUSTER", importance: pctScore((1 - buyRatio) * 100), reason: "Sells dominate recent swaps" }]
    : [];

  return {
    chain,
    address: addr,
    generatedAt: Date.now(),
    mood: mood as WorldState["mood"],
    trajectory: ch1h > 5 ? "RISING" : ch1h < -5 ? "FALLING" : "FLAT",
    coherence: "UNKNOWN",
    leadLag: "UNKNOWN",
    regime: "UNKNOWN",
    power: fv(power),
    threat: fv(threat),
    confidence: fv(confidence),
    attention: fv(attention),
    events,
    signals: [],
    whyNow: buildWhyNow(r, mood),
    flowEntities: [], // flow entities require the trade feed; browse view omits them honestly
    dataQuality: r.address ? "COMPLETE" : "INSUFFICIENT",
    qualityReasons: ["Trending snapshot (browse view)"],
    insufficient: [],
    visual: { territorySize01: attention / 100, contestBalance01: buyRatio },
    // extra display payload the Mini App reads for the statistics panel:
    // (kept as loose extra props; WorldState consumers ignore unknown keys)
    ...( { stats: {
      symbol: r.symbol, name: r.name, priceUsd: num(r.price),
      marketCap: num(r.market_cap), liquidity: num(r.liquidity),
      holders: num(r.holder_count), top10Rate: num(r.top_10_holder_rate),
      buys: num(r.buys), sells: num(r.sells),
      smartMoney: num(r.smart_degen_count), renowned: num(r.renowned_count),
      rugRatio: num(r.rug_ratio), washTrading: r.is_wash_trading === true,
      honeypot: r.is_honeypot === 1, renounced: r.is_renounced === 1,
      sniperCount: num(r.sniper_count), devHoldRate: num(r.dev_team_hold_rate),
      buyTax: r.buy_tax || undefined, sellTax: r.sell_tax || undefined,
      // extended set — everything GMGN confirms
      volume: num(r.volume), totalSupply: num(r.total_supply),
      athMarketCap: num(r.history_highest_market_cap), initialLiquidity: num(r.initial_liquidity),
      burnRatio: num(r.burn_ratio), burnStatus: r.burn_status || undefined,
      lockPercent: num(r.lock_percent), openSource: r.is_open_source === 1,
      renouncedMint: r.renounced_mint === 1, renouncedFreeze: r.renounced_freeze_account === 1,
      bluechipPct: num(r.bluechip_owner_percentage), top70SniperRate: num(r.top70_sniper_hold_rate),
      botRate: num(r.bot_degen_rate), entrapmentRatio: num(r.entrapment_ratio),
      ratTraderRate: num(r.rat_trader_amount_rate),
      launchpad: r.launchpad_platform || undefined, exchange: r.exchange || undefined,
      creator: r.creator || undefined, creatorStatus: r.creator_token_status || undefined,
      twitter: r.twitter_username || undefined, website: r.website || undefined, telegram: r.telegram || undefined,
      creationTs: num(r.creation_timestamp),
      change5m: num(r.price_change_percent5m), change1m: num(r.price_change_percent1m),
      change1h: num(r.price_change_percent1h),
    } } as unknown as Record<string, unknown> ),
    // WAR signature analysis — deterministic derived indices over confirmed metrics
    ...( { analysis: analyze({
      marketCap: num(r.market_cap), liquidity: num(r.liquidity),
      initialLiquidity: num(r.initial_liquidity), athMarketCap: num(r.history_highest_market_cap),
      volume: num(r.volume), holders: num(r.holder_count),
      top10Rate: num(r.top_10_holder_rate), devHoldRate: num(r.dev_team_hold_rate),
      top70SniperRate: num(r.top70_sniper_hold_rate), bundlerRate: num(r.bundler_rate),
      bluechipPct: num(r.bluechip_owner_percentage), sniperCount: num(r.sniper_count),
      botRate: num(r.bot_degen_rate), ratTraderRate: num(r.rat_trader_amount_rate),
      entrapmentRatio: num(r.entrapment_ratio), washTrading: r.is_wash_trading === true,
      rugRatio: num(r.rug_ratio), honeypot: r.is_honeypot === 1,
      renounced: r.is_renounced === 1, openSource: r.is_open_source === 1,
      renouncedMint: r.renounced_mint === 1, renouncedFreeze: r.renounced_freeze_account === 1,
      lockPercent: num(r.lock_percent), burnRatio: num(r.burn_ratio),
      buys: num(r.buys), sells: num(r.sells),
      smartMoney: num(r.smart_degen_count), renowned: num(r.renowned_count),
      buyTax: r.buy_tax || undefined, sellTax: r.sell_tax || undefined,
      creationTs: num(r.creation_timestamp),
      change1h: num(r.price_change_percent1h), change5m: num(r.price_change_percent5m),
    }) } as unknown as Record<string, unknown> ),
  } as WorldState;
}

function buildWhyNow(r: RankRow, mood: string): string[] {
  const out: string[] = [];
  const ch = num(r.price_change_percent1h);
  if (ch !== undefined && Math.abs(ch) > 5) out.push(`Price ${ch > 0 ? "up" : "down"} ${Math.round(ch)}% in the last hour`);
  const sm = num(r.smart_degen_count);
  if (sm && sm > 5) out.push(`${sm} smart-money wallets active`);
  const t10 = num(r.top_10_holder_rate);
  if (t10 !== undefined && t10 > 0.4) out.push(`Top-10 hold ${Math.round(t10 * 100)}% — concentrated`);
  if ((num(r.rug_ratio) ?? 0) > 0.3) out.push("Elevated rug ratio — caution");
  if (out.length === 0) out.push(`Currently ${mood.toLowerCase()} on the trending board`);
  return out;
}

/**
 * Build the trending address source + a matching evaluate() that reads from the
 * row cache this source populates. Returns both so the runtime can wire them
 * into TrendingCache without a second GMGN call per token.
 *
 * @param runTrending injected fn that runs `market trending` for a chain and
 *                    returns parsed rank rows (or null on failure)
 */
export function gmgnTrendingSource(
  runTrending: (chain: Chain) => Promise<readonly RankRow[] | null>,
  limitPerChain = 6,
) {
  const source = async (): Promise<readonly TrendingToken[] | null> => {
    const tokens: TrendingToken[] = [];
    let anyOk = false;
    for (const chain of TRENDING_CHAINS) {
      let rows: readonly RankRow[] | null = null;
      try { rows = await runTrending(chain); } catch { rows = null; }
      if (rows === null) continue;
      anyOk = true;
      for (const r of rows.slice(0, limitPerChain)) {
        if (!r.address) continue;
        rowCache.set(`${chain}:${r.address}`, r);
        tokens.push({ chain, address: r.address });
      }
    }
    return anyOk ? tokens : null;
  };

  const evaluate = async (t: TrendingToken): Promise<WorldState | null> => {
    const r = rowCache.get(`${t.chain}:${t.address}`);
    if (!r) return null;
    return rowToWorldState(r, t.chain);
  };

  return { source, evaluate };
}

/** Parse the CLI trending JSON envelope into rank rows. */
export function parseTrendingRank(json: unknown): readonly RankRow[] | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const rank = (data as { rank?: unknown }).rank;
  if (!Array.isArray(rank)) return null;
  return rank as RankRow[];
}
