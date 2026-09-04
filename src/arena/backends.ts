/**
 * WAR arena - Search + Replay backends (Phase 3).
 *
 * These implement the Phase 2 contracts that were BLOCKED, now that Phase 3 added
 * the read methods (TokenRepository.searchByText, MonitoringObservationRepository.
 * list). They READ verified persistence only — no ranking intelligence, no
 * fabricated results, no new scoring.
 */

import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";
import type { SearchPort, SearchQuery, SearchResult } from "../world/worldRadar.js";

/** Real search over stored tokens. Returns only stored fields. */
export class RepositorySearchPort implements SearchPort {
  constructor(private readonly uow: UnitOfWork, private readonly limit = 20) {}

  async search(query: SearchQuery): Promise<readonly SearchResult[]> {
    const rows = await this.uow.repos.tokens.searchByText(query.text, this.limit);
    return rows.map((r) => ({ chain: r.chain, address: r.address as unknown as string, symbol: r.symbol }));
  }
}

/** A replay history entry read from persistence (references, not recomputation). */
export interface ReplayHistoryEntry {
  readonly at: number;
  readonly kind: string;
  readonly ref: string; // reference to the stored snapshot/report id
  readonly reasons: readonly string[];
}

/**
 * Reads a monitoring session's persisted observation history so Replay can play
 * it back. It returns REFERENCES to stored snapshots; it does not recompute any
 * intelligence. The World replay renderer resolves refs to stored WorldStates.
 */
export class MonitoringHistoryReader {
  constructor(private readonly uow: UnitOfWork) {}

  async history(sessionId: string): Promise<readonly ReplayHistoryEntry[]> {
    const records = await this.uow.repos.observations.list(sessionId);
    return records.map((r) => ({
      at: r.record.at,
      kind: r.record.kind,
      ref: r.record.ref,
      reasons: r.reasons,
    }));
  }
}
