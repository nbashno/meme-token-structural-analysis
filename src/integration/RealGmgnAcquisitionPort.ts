/**
 * WAR integration - RealGmgnAcquisitionPort (Phase 5B).
 *
 * Satisfies the product-side GmgnAcquisitionPort by running the REAL transport
 * chain for one token:
 *
 *   CliExecutor (injected) -> gmgnRunner -> raw GMGN JSON
 *     -> existing parsers (parseKline / parseTrending / parseFlowEvent)
 *     -> sealed flow normalizer (inside parseFlowEvent)
 *     -> NormalizedObservations
 *
 * It produces ONLY normalized observations. It NEVER computes Power/Threat/
 * Confidence or a BattlefieldState — that is the evaluator's job downstream.
 * Banned fields (hot_level, raw is_open_or_close) die in the parsers/normalizer,
 * never reaching here in a usable form.
 *
 * The CliExecutor is injected: a real one runs gmgn-cli (5F); a stub returns
 * raw-shaped payloads for transport tests (5B). Either way the data flows through
 * the real parsers — the stub replaces the NETWORK, not the intelligence.
 */

import type { Chain, TokenAddress, UnixMillis } from "../shared/scalars.js";
import type {
  MarketObservation,
  AnalyticsObservation,
  FlowObservation,
} from "../core/timeline/types.js";
import {
  parseKline,
  parseTrending,
  parseFlowEvent,
  type RawKline,
  type RawTrending,
} from "../adapters/gmgn/gmgnParsers.js";
import type { RawFlowEvent } from "../adapters/gmgn/FlowEventNormalizer.contract.js";
import {
  runGmgnJson,
  klineArgv,
  trendingArgv,
  trackArgv,
  type CliExecutor,
} from "../adapters/gmgn/gmgnRunner.js";
import type {
  GmgnAcquisitionPort,
  NormalizedObservations,
} from "../product/scan/ports/ports.js";
import type { DomainResult } from "../product/domain/identity.js";
import { ok, err } from "../product/domain/identity.js";

export interface AcquisitionConfig {
  readonly klineResolution: string; // e.g. "1m"
  readonly trendingInterval: string; // e.g. "1m"
  /** Which track sub-command to pull flow from (kol / smartmoney / follow-wallet). */
  readonly flowSource: "kol" | "smartmoney" | "follow-wallet";
}

export const DEFAULT_ACQUISITION_CONFIG: AcquisitionConfig = {
  klineResolution: "1m",
  trendingInterval: "1m",
  flowSource: "smartmoney",
};

export class RealGmgnAcquisitionPort implements GmgnAcquisitionPort {
  constructor(
    private readonly exec: CliExecutor,
    private readonly config: AcquisitionConfig = DEFAULT_ACQUISITION_CONFIG,
  ) {}

  async acquire(
    chain: Chain,
    address: TokenAddress,
    atMs: number,
  ): Promise<DomainResult<NormalizedObservations>> {
    // 1. MARKET (kline)
    const klineRes = await runGmgnJson<readonly RawKline[]>(
      this.exec,
      klineArgv(chain, address as string, this.config.klineResolution),
    );
    if (!klineRes.ok) return err(`kline acquisition failed: ${klineRes.kind}`);

    // 2. ANALYTICS (trending) — carries the sealed security fields too
    const trendingRes = await runGmgnJson<readonly RawTrending[]>(
      this.exec,
      trendingArgv(chain, this.config.trendingInterval),
    );
    if (!trendingRes.ok) return err(`trending acquisition failed: ${trendingRes.kind}`);

    // 3. FLOW (track) — routed through the sealed normalizer inside parseFlowEvent
    const flowRes = await runGmgnJson<readonly RawFlowEvent[]>(
      this.exec,
      trackArgv(this.config.flowSource, chain),
    );
    if (!flowRes.ok) return err(`flow acquisition failed: ${flowRes.kind}`);

    // Parse each lane. Malformed rows are dropped (parser returns null); we never
    // fabricate an observation. Timestamps come from the payloads themselves.
    const market: MarketObservation[] = [];
    for (const raw of klineRes.data) {
      const obs = parseKline(raw);
      if (obs !== null) market.push(obs);
    }

    const analytics: AnalyticsObservation[] = [];
    for (const raw of trendingRes.data) {
      const obs = parseTrending(raw, atMs as UnixMillis);
      if (obs !== null) analytics.push(obs);
    }

    const flow: FlowObservation[] = [];
    for (const raw of flowRes.data) {
      const obs = parseFlowEvent(raw);
      if (obs !== null) flow.push(obs);
    }

    // Observed window = min/max observation timestamps actually obtained.
    const times: number[] = [
      ...market.map((m) => m.meta.at as number),
      ...analytics.map((a) => a.meta.at as number),
      ...flow.map((f) => f.meta.at as number),
    ];
    const observedFromMs = times.length > 0 ? Math.min(...times) : atMs;
    const observedToMs = times.length > 0 ? Math.max(...times) : atMs;

    return ok({
      chain,
      address,
      market,
      analytics,
      flow,
      observedFromMs,
      observedToMs,
    });
  }
}
