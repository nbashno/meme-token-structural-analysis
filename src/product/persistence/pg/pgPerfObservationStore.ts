/**
 * WAR — Postgres-backed wallet performance observation store. SQL confined here.
 */

import type { PgPool } from "./pgClient.js";
import type {
  PerfObservationStore, PerfObservation, PerfFilter, WalletAggregate,
} from "../../intel/perfObservationStore.js";

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function whereFilter(f: PerfFilter, params: unknown[]): string {
  const parts: string[] = [];
  if (f.minCostUsd != null) { params.push(f.minCostUsd); parts.push(`cost_usd >= $${params.length}`); }
  if (f.minRealizedProfitUsd != null) { params.push(f.minRealizedProfitUsd); parts.push(`realized_profit >= $${params.length}`); }
  return parts.length ? "WHERE " + parts.join(" AND ") : "";
}

interface Row {
  chain: string; wallet: string; token: string; token_symbol: string | null;
  realized_profit: string | number; realized_roi: string | number | null;
  cost_usd: string | number; wallet_tag: string | null; source: string; observed_at: string | number;
}
const n = (v: string | number | null) => v == null ? null : (typeof v === "number" ? v : Number(v));
function fromRow(r: Row): PerfObservation {
  return {
    chain: r.chain, wallet: r.wallet, token: r.token, tokenSymbol: r.token_symbol,
    realizedProfit: n(r.realized_profit)!, realizedRoi: n(r.realized_roi),
    costUsd: n(r.cost_usd)!, walletTag: r.wallet_tag, source: r.source,
    observedAt: n(r.observed_at)!,
  };
}

export class PgPerfObservationStore implements PerfObservationStore {
  constructor(private readonly pool: PgPool) {}

  async record(o: PerfObservation): Promise<void> {
    await this.pool.query(
      `INSERT INTO wallet_perf_observations
         (chain, wallet, token, token_symbol, realized_profit, realized_roi, cost_usd, wallet_tag, source, observed_day, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (chain, wallet, token, observed_day) DO UPDATE SET
         realized_profit=$5, realized_roi=$6, cost_usd=$7, wallet_tag=$8, source=$9, observed_at=$11`,
      [o.chain, o.wallet, o.token, o.tokenSymbol, o.realizedProfit, o.realizedRoi,
       o.costUsd, o.walletTag, o.source, utcDay(o.observedAt), o.observedAt],
    );
  }

  async topByProfit(filter: PerfFilter, limit: number): Promise<readonly PerfObservation[]> {
    const params: unknown[] = [];
    const where = whereFilter(filter, params);
    params.push(limit);
    const r = await this.pool.query<Row>(
      `SELECT * FROM wallet_perf_observations ${where} ORDER BY realized_profit DESC LIMIT $${params.length}`, params,
    );
    return r.rows.map(fromRow);
  }

  async topByRoi(filter: PerfFilter, limit: number): Promise<readonly PerfObservation[]> {
    const params: unknown[] = [];
    let where = whereFilter(filter, params);
    where = where ? where + " AND realized_roi IS NOT NULL" : "WHERE realized_roi IS NOT NULL";
    params.push(limit);
    const r = await this.pool.query<Row>(
      `SELECT * FROM wallet_perf_observations ${where} ORDER BY realized_roi DESC LIMIT $${params.length}`, params,
    );
    return r.rows.map(fromRow);
  }

  async all(max: number): Promise<readonly PerfObservation[]> {
    const r = await this.pool.query<Row>(
      "SELECT * FROM wallet_perf_observations LIMIT $1", [max],
    );
    return r.rows.map(fromRow);
  }

  async observationsForWallet(chain: string, wallet: string): Promise<readonly PerfObservation[]> {
    const r = await this.pool.query<Row>(
      "SELECT * FROM wallet_perf_observations WHERE chain=$1 AND wallet=$2", [chain, wallet],
    );
    return r.rows.map(fromRow);
  }

  async repeatPerformers(minObs: number, filter: PerfFilter, limit: number): Promise<readonly WalletAggregate[]> {
    const params: unknown[] = [];
    const where = whereFilter(filter, params);
    params.push(minObs); const minIdx = params.length;
    params.push(limit); const limIdx = params.length;
    const r = await this.pool.query<{
      chain: string; wallet: string; observations: string | number; tokens: string | number;
      total_realized_profit: string | number; median_roi: string | number | null; max_roi: string | number | null;
    }>(
      `SELECT chain, wallet, COUNT(*) AS observations, COUNT(DISTINCT token) AS tokens,
              SUM(realized_profit) AS total_realized_profit,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY realized_roi) AS median_roi,
              MAX(realized_roi) AS max_roi
         FROM wallet_perf_observations ${where}
        GROUP BY chain, wallet
       HAVING COUNT(*) >= $${minIdx}
        ORDER BY total_realized_profit DESC LIMIT $${limIdx}`, params,
    );
    return r.rows.map((x) => ({
      chain: x.chain, wallet: x.wallet,
      observations: Number(x.observations), tokens: Number(x.tokens),
      totalRealizedProfit: Number(x.total_realized_profit),
      medianRoi: x.median_roi == null ? null : Number(x.median_roi),
      maxRoi: x.max_roi == null ? null : Number(x.max_roi),
    }));
  }
}
