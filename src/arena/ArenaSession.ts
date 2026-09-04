/**
 * WAR arena - ArenaSession (Phase 3.1 product wiring).
 *
 * The single read-only product surface. It binds the verified Phase 1/2 pieces:
 *   - scan          -> ScanService (hardened executor injected upstream)
 *   - monitor tick  -> MonitoringService
 *   - world         -> toWorldState + WorldEngine
 *   - search        -> RepositorySearchPort
 *   - replay        -> MonitoringHistoryReader
 *
 * It NEVER computes intelligence and NEVER bypasses a boundary. Scan/monitor go
 * through the existing services (payment gate, hardening). The world is fed the
 * resulting IntelligenceReport via the pure adapter. One source of truth.
 */

import type { ScanService, ScanInput, ScanResult } from "../product/scan/orchestration/scanService.js";
import type { MonitoringService, MonitorTickOutcome } from "../integration/MonitoringService.js";
import type { MonitoringSession } from "../product/monitor/monitor.js";
import type { MonitorCarry } from "../integration/monitorTick.js";
import type { DomainResult } from "../product/domain/identity.js";
import { toWorldState, type WorldState } from "../world/worldAdapter.js";
import { WorldEngine, type WorldPosition } from "../world/worldEngine.js";
import { RepositorySearchPort, MonitoringHistoryReader, type ReplayHistoryEntry } from "./backends.js";
import type { SearchResult } from "../world/worldRadar.js";
import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";

export interface ArenaDeps {
  readonly scanService: ScanService;
  readonly monitoringService: MonitoringService;
  readonly uow: UnitOfWork;
}

export class ArenaSession {
  readonly world = new WorldEngine();
  private readonly search: RepositorySearchPort;
  private readonly replay: MonitoringHistoryReader;

  constructor(private readonly deps: ArenaDeps) {
    this.search = new RepositorySearchPort(deps.uow);
    this.replay = new MonitoringHistoryReader(deps.uow);
  }

  /** Run a paid scan and project its report into a world instance. */
  async scan(input: ScanInput, position: WorldPosition): Promise<DomainResult<{ result: ScanResult; world: WorldState }>> {
    const res = await this.deps.scanService.execute(input);
    if (!res.ok) return res;
    const world = toWorldState({ report: res.value.report });
    const id = `${world.chain}:${world.address}`;
    this.world.ensure(id, position);
    this.world.mount(id);
    this.world.update(id, world);
    return { ok: true, value: { result: res.value, world } };
  }

  /** Advance one monitoring tick; if a report is produced, update the world. */
  async monitorTick(session: MonitoringSession, carry: MonitorCarry): Promise<DomainResult<MonitorTickOutcome>> {
    return this.deps.monitoringService.tick(session, carry);
  }

  /** Search stored tokens (real backend). */
  async searchTokens(text: string): Promise<readonly SearchResult[]> {
    return this.search.search({ text });
  }

  /** Read a session's persisted history for replay (references only). */
  async replayHistory(sessionId: string): Promise<readonly ReplayHistoryEntry[]> {
    return this.replay.history(sessionId);
  }
}
