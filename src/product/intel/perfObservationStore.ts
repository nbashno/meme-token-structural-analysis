/**
 * WAR Product Layer — wallet performance observation store (Alpha Memory).
 *
 * Accumulates REAL realized-performance observations from GMGN top-traders.
 * This is the substrate for two things:
 *   1. WAR INTEL cards (biggest realized profit / ROI, top wallet).
 *   2. Calibration (deriving anti-gaming thresholds from the real distribution
 *      rather than guessing) and, over time, REPEAT PERFORMER detection.
 *
 * Deterministic, no ambient IO. realized_roi is stored EXACTLY as GMGN reports
 * it — never capped. Dedup is per (chain, wallet, token, UTC day).
 */

export interface PerfObservation {
  readonly chain: string;
  readonly wallet: string;
  readonly token: string;
  readonly tokenSymbol: string | null;
  readonly realizedProfit: number;   // USD (can be negative)
  readonly realizedRoi: number | null; // GMGN ratio, exact
  readonly costUsd: number;
  readonly walletTag: string | null;
  readonly source: string;
  readonly observedAt: number;       // epoch-ms
}

/** Filters applied when reading the dataset (anti-gaming, calibrated). */
export interface PerfFilter {
  readonly minCostUsd?: number;
  readonly minRealizedProfitUsd?: number;
}

/** A wallet rolled up across all its observations (Alpha Memory aggregate). */
export interface WalletAggregate {
  readonly chain: string;
  readonly wallet: string;
  readonly observations: number;
  readonly tokens: number;
  readonly totalRealizedProfit: number;
  readonly medianRoi: number | null;
  readonly maxRoi: number | null;
}

export interface PerfObservationStore {
  /** Record one observation (idempotent per chain+wallet+token+UTC day). */
  record(o: PerfObservation): Promise<void>;
  /** Top observations by realized profit, after filters. */
  topByProfit(filter: PerfFilter, limit: number): Promise<readonly PerfObservation[]>;
  /** Top observations by realized ROI, after filters. */
  topByRoi(filter: PerfFilter, limit: number): Promise<readonly PerfObservation[]>;
  /** All observations (for calibration distributions). Bounded by `max`. */
  all(max: number): Promise<readonly PerfObservation[]>;
  /** All observations for a specific wallet (for Wallet DNA fingerprint). */
  observationsForWallet(chain: string, wallet: string): Promise<readonly PerfObservation[]>;
  /** Wallets that appear in >= minObservations rows (REPEAT PERFORMER basis). */
  repeatPerformers(minObservations: number, filter: PerfFilter, limit: number): Promise<readonly WalletAggregate[]>;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const passes = (o: PerfObservation, f: PerfFilter) =>
  (f.minCostUsd == null || o.costUsd >= f.minCostUsd) &&
  (f.minRealizedProfitUsd == null || o.realizedProfit >= f.minRealizedProfitUsd);

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// -- In-memory implementation ------------------------------------------------
export class InMemoryPerfObservationStore implements PerfObservationStore {
  private readonly rows = new Map<string, PerfObservation>();  // dedup key -> obs

  async record(o: PerfObservation): Promise<void> {
    const key = `${o.chain}|${o.wallet}|${o.token}|${utcDay(o.observedAt)}`;
    this.rows.set(key, o);  // last-write-wins for the same day
  }
  async topByProfit(filter: PerfFilter, limit: number): Promise<readonly PerfObservation[]> {
    return [...this.rows.values()].filter(o => passes(o, filter))
      .sort((a, b) => b.realizedProfit - a.realizedProfit).slice(0, limit);
  }
  async topByRoi(filter: PerfFilter, limit: number): Promise<readonly PerfObservation[]> {
    return [...this.rows.values()].filter(o => passes(o, filter) && o.realizedRoi != null)
      .sort((a, b) => (b.realizedRoi ?? 0) - (a.realizedRoi ?? 0)).slice(0, limit);
  }
  async all(max: number): Promise<readonly PerfObservation[]> {
    return [...this.rows.values()].slice(0, max);
  }
  async observationsForWallet(chain: string, wallet: string): Promise<readonly PerfObservation[]> {
    return [...this.rows.values()].filter(o => o.chain === chain && o.wallet === wallet);
  }
  async repeatPerformers(minObs: number, filter: PerfFilter, limit: number): Promise<readonly WalletAggregate[]> {
    const byWallet = new Map<string, PerfObservation[]>();
    for (const o of this.rows.values()) {
      if (!passes(o, filter)) continue;
      const k = `${o.chain}|${o.wallet}`;
      (byWallet.get(k) ?? byWallet.set(k, []).get(k)!).push(o);
    }
    const out: WalletAggregate[] = [];
    for (const [k, obs] of byWallet) {
      if (obs.length < minObs) continue;
      const [chain, wallet] = k.split("|") as [string, string];
      const rois = obs.map(o => o.realizedRoi).filter((r): r is number => r != null);
      out.push({
        chain, wallet, observations: obs.length,
        tokens: new Set(obs.map(o => o.token)).size,
        totalRealizedProfit: obs.reduce((s, o) => s + o.realizedProfit, 0),
        medianRoi: median(rois),
        maxRoi: rois.length ? Math.max(...rois) : null,
      });
    }
    return out.sort((a, b) => b.totalRealizedProfit - a.totalRealizedProfit).slice(0, limit);
  }
}
