/**
 * WAR — Postgres-backed Founder Wallet event store. SQL confined here.
 */

import type { PgPool } from "./pgClient.js";
import type { FounderEventStore, FounderEvent } from "../../founder/founderEventStore.js";

export class PgFounderEventStore implements FounderEventStore {
  constructor(private readonly pool: PgPool) {}

  async knownMints(chain: string, wallet: string): Promise<ReadonlySet<string>> {
    const r = await this.pool.query<{ mint: string }>(
      "SELECT mint FROM founder_wallet_tokens WHERE chain=$1 AND wallet=$2", [chain, wallet],
    );
    return new Set(r.rows.map((x) => x.mint));
  }

  async updateSnapshot(chain: string, wallet: string, mints: readonly string[], nowMs: number): Promise<readonly string[]> {
    // Did we have ANY snapshot before? (first run must not flag everything).
    const existing = await this.knownMints(chain, wallet);
    const isFirst = existing.size === 0;

    // Upsert every current mint (first_seen kept, last_seen bumped).
    for (const mint of mints) {
      await this.pool.query(
        `INSERT INTO founder_wallet_tokens (chain, wallet, mint, first_seen, last_seen)
           VALUES ($1,$2,$3,$4,$4)
         ON CONFLICT (chain, wallet, mint) DO UPDATE SET last_seen=$4`,
        [chain, wallet, mint, nowMs],
      );
    }
    if (isFirst) return [];
    return mints.filter((m) => !existing.has(m));
  }

  async recordEvent(e: FounderEvent): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO founder_wallet_events
         (chain, wallet, event_type, token_mint, token_symbol, tx_hash, from_address, from_name, occurred_at, detected_at, notified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)
       ON CONFLICT (chain, wallet, token_mint, tx_hash) DO NOTHING`,
      [e.chain, e.wallet, e.eventType, e.tokenMint, e.tokenSymbol, e.txHash,
       e.fromAddress, e.fromName, e.occurredAt, e.detectedAt],
    );
    return r.rowCount > 0;
  }

  async recentEvents(chain: string, wallet: string, limit: number): Promise<readonly FounderEvent[]> {
    const r = await this.pool.query<{
      chain: string; wallet: string; event_type: string; token_mint: string;
      token_symbol: string | null; tx_hash: string; from_address: string | null;
      from_name: string | null; occurred_at: string | null; detected_at: string;
    }>(
      `SELECT chain, wallet, event_type, token_mint, token_symbol, tx_hash,
              from_address, from_name, occurred_at, detected_at
         FROM founder_wallet_events
        WHERE chain=$1 AND wallet=$2
        ORDER BY detected_at DESC LIMIT $3`,
      [chain, wallet, limit],
    );
    return r.rows.map((x) => ({
      chain: x.chain, wallet: x.wallet,
      eventType: x.event_type as FounderEvent["eventType"],
      tokenMint: x.token_mint, tokenSymbol: x.token_symbol, txHash: x.tx_hash,
      fromAddress: x.from_address, fromName: x.from_name,
      occurredAt: x.occurred_at != null ? Number(x.occurred_at) : null,
      detectedAt: Number(x.detected_at),
    }));
  }
}
