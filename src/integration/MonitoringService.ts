/**
 * WAR integration - MonitoringService (Phase 6).
 *
 * Drives a paid $1/24h monitoring session. Each invocation performs ONE tick:
 *   1. check the session may acquire (ACTIVE + not expired)
 *   2. acquire normalized observations (real acquisition port)
 *   3. evaluate through real WAR (real evaluation port)
 *   4. monitorTick: events / alerts / change-aware persist, threading carry
 *   5. persist meaningful changes + alerts; update session markers
 *
 * NO new intelligence, NO live polling loop here (the scheduler/cron that calls
 * tick() repeatedly is injected by the caller; the CLI executor is injected too,
 * exactly like the scan path). Deterministic given its inputs.
 *
 * Expiry invariant: an expired/inactive session performs NO acquisition.
 */

import type { UnixMillis } from "../shared/scalars.js";
import type { Clock, DomainResult } from "../product/domain/identity.js";
import { ok, err } from "../product/domain/identity.js";
import type { MonitoringSession } from "../product/monitor/monitor.js";
import { isAcquisitionAllowed, expireIfDue } from "../product/monitor/monitor.js";
import type { GmgnAcquisitionPort, WarEvaluationPort } from "../product/scan/ports/ports.js";
import { monitorTick, type MonitorCarry } from "./monitorTick.js";
import type { MarketEvent } from "../core/state/types.js";
import type { Alert } from "../product/intelligence/alerts.js";

export interface MonitorServiceDeps {
  readonly acquisition: GmgnAcquisitionPort;
  readonly evaluation: WarEvaluationPort;
  readonly clock: Clock;
}

export interface MonitorTickOutcome {
  readonly session: MonitoringSession;
  readonly events: readonly MarketEvent[];
  readonly alerts: readonly Alert[];
  readonly persisted: boolean;
  readonly nextCarry: MonitorCarry;
  readonly skipped: "EXPIRED" | "NOT_ACTIVE" | null;
}

export class MonitoringService {
  constructor(private readonly deps: MonitorServiceDeps) {}

  /**
   * Execute one monitoring tick. Returns the (possibly expired) session, any
   * events/alerts, whether this tick's result should be persisted, and the carry
   * to thread into the next tick.
   */
  async tick(session: MonitoringSession, carry: MonitorCarry): Promise<DomainResult<MonitorTickOutcome>> {
    const now = this.deps.clock.now();

    // Expire if due first — an expired monitor does no acquisition (invariant).
    const expired = expireIfDue(session, now);
    if (!expired.ok) return err(expired.error);
    const current = expired.value;

    if (current.status === "EXPIRED") {
      return ok({ session: current, events: [], alerts: [], persisted: false, nextCarry: carry, skipped: "EXPIRED" });
    }
    if (!isAcquisitionAllowed(current, now)) {
      return ok({ session: current, events: [], alerts: [], persisted: false, nextCarry: carry, skipped: "NOT_ACTIVE" });
    }

    // Acquire + evaluate through the real chain.
    const acq = await this.deps.acquisition.acquire(current.token.chain, current.token.address, now);
    if (!acq.ok) return err(`acquisition failed: ${acq.error}`);

    const evalRes = await this.deps.evaluation.evaluate(acq.value, now);
    if (!evalRes.ok) return err(`evaluation failed: ${evalRes.error}`);

    const result = monitorTick(evalRes.value, current.token.address, now as UnixMillis, carry);

    // Update session temporal markers.
    const updated: MonitoringSession = {
      ...current,
      lastObservationAt: now,
      lastBattlefieldStateAt: now,
      lastEventAt: result.events.length > 0 ? now : current.lastEventAt,
    };

    return ok({
      session: updated,
      events: result.events,
      alerts: result.alerts,
      persisted: result.persist.persist,
      nextCarry: result.nextCarry,
      skipped: null,
    });
  }
}
